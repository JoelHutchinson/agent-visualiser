import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseJson, type Signal } from '../shared/events.js';
import type { SubagentFile } from '../shared/replay.js';
import { TranscriptParser, type SubagentHint } from '../shared/transcript.js';
import type { Hub } from './hub.js';

export interface TranscriptOptions {
  /** One or more Claude Code projects folders; the newest session across all wins. */
  projectsDir: string | string[];
  /** Extra folders found at runtime (e.g. WSL distros that start later); re-run every 30s. */
  discover?: () => string[];
  /** Fallback rescan interval, used only if fs.watch is unavailable or misses a
   *  brand-new session file. */
  pollMs?: number;
}

/** Network paths (\\\\wsl.localhost\\...) don't deliver fs.watch events reliably; poll them. */
export const isNetworkPath = (p: string) => /^(\\\\|\/\/)/.test(p);

/**
 * Claude Code folders inside running WSL distros, seen from Windows
 * (`\\\\wsl.localhost\\<distro>\\home\\<user>\\.claude\\projects`). Only running distros are
 * listed so we never boot WSL just to look.
 */
export function discoverWslProjects(): string[] {
  if (process.platform !== 'win32') return [];
  let out = '';
  try {
    out = execFileSync('wsl.exe', ['-l', '--running', '-q'], { encoding: 'utf16le', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const distro of out.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean)) {
    const root = `\\\\wsl.localhost\\${distro}`;
    const homes = [path.join(root, 'root')];
    try {
      for (const u of fs.readdirSync(path.join(root, 'home'))) homes.push(path.join(root, 'home', u));
    } catch {
      // No /home or not reachable.
    }
    for (const h of homes) {
      const dir = path.join(h, '.claude', 'projects');
      try {
        if (fs.statSync(dir).isDirectory()) found.push(dir);
      } catch {
        // Not a Claude Code user.
      }
    }
  }
  return found;
}

/** Newest top-level `<project>/<session>.jsonl` under the projects dir(s). */
export function findNewestSession(projectsDirs: string | string[]): { file: string; mtimeMs: number } | undefined {
  let best: { file: string; mtimeMs: number } | undefined;
  for (const s of listSessions(projectsDirs)) if (!best || s.mtimeMs > best.mtimeMs) best = s;
  return best;
}
/** Every top-level `<project>/<session>.jsonl` under the projects dir(s). */
export function listSessions(projectsDirs: string | string[]): { file: string; mtimeMs: number }[] {
  return (Array.isArray(projectsDirs) ? projectsDirs : [projectsDirs]).flatMap(sessionsIn);
}
function sessionsIn(projectsDir: string): { file: string; mtimeMs: number }[] {
  const all: { file: string; mtimeMs: number }[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return all;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir, p.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      try {
        all.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        // Deleted between readdir and stat.
      }
    }
  }
  return all;
}

/** Reads a file incrementally, yielding only complete new lines. */
export class LineTailer {
  private offset = 0;
  private partial = '';

  constructor(readonly file: string) {}

  /** Skip to the current end, returning the existing complete lines. */
  readExisting(): string[] {
    return this.readNew();
  }

  readNew(): string[] {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      return [];
    }
    try {
      const { size } = fs.fstatSync(fd);
      if (size < this.offset) {
        // Truncated or replaced: start over.
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += read;
      const text = this.partial + buf.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  }
}

/** A subagent's files live in `<project>/<session>/subagents/`. */
export function subagentDir(sessionFile: string): string {
  return path.join(path.dirname(sessionFile), path.basename(sessionFile, '.jsonl'), 'subagents');
}

/** `agent-<id>.jsonl` files of a session, newest first. */
export function listSubagentFiles(sessionFile: string): { agentId: string; file: string; mtimeMs: number }[] {
  const dir = subagentDir(sessionFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { agentId: string; file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    try {
      out.push({ agentId: m[1], file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // Deleted between readdir and stat.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** meta.json next to a subagent transcript: { toolUseId, description, agentType }. */
function readMeta(file: string): Omit<SubagentHint, 'agentId'> | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return { toolUseId: s(m.toolUseId), description: s(m.description), agentType: s(m.agentType) };
  } catch {
    return undefined;
  }
}

/** History of long sessions can hold hundreds of subagents; read the most recent. */
const MAX_HISTORY_SUBAGENTS = 100;

/** The subagent transcripts of a session file, for `record` and `--replay`. */
export function readSubagentFiles(sessionFile: string): SubagentFile[] {
  return listSubagentFiles(sessionFile)
    .slice(0, MAX_HISTORY_SUBAGENTS)
    .flatMap(({ agentId, file }) => {
      try {
        return [{ agentId, meta: readMeta(file), text: fs.readFileSync(file, 'utf8') }];
      } catch {
        return [];
      }
    });
}

interface Line {
  ts: number;
  n: number;
  text: string;
  /** Subagent file the line came from; undefined for the main transcript. */
  agentId?: string;
}

const parseTs = (line: string) => {
  const ts = parseJson(line)?.timestamp;
  return typeof ts === 'string' ? Date.parse(ts) : NaN;
};

/**
 * Claude Code adapter: follows the most recently modified session transcript,
 * plus the transcripts of its subagents that are still running, and hands
 * their signals to the hub. Read-only: never writes to ~/.claude.
 */
export class TranscriptSource {
  private tailer: LineTailer | undefined;
  private sessionFile = '';
  private sessionId = '';
  private parser = new TranscriptParser();
  /** Subagent transcripts being tailed, by transcript agentId. */
  private subs = new Map<string, LineTailer>();
  /** Subagents whose meta.json has been read and handed to the parser. */
  private linked = new Set<string>();
  /** Subagents already finished, never tailed again. */
  private retired = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private discoverTimer: NodeJS.Timeout | undefined;
  private watchers: fs.FSWatcher[] = [];
  private pending: NodeJS.Timeout | undefined;
  private dirs: string[] = [];
  private lastScan = 0;
  private known = new Set<string>();

  constructor(
    private readonly opts: TranscriptOptions,
    private readonly hub: Pick<Hub, 'adopt' | 'ingest' | 'touch'>,
  ) {}

  /** Every folder currently being watched (for logging). */
  get folders(): string[] {
    return [...this.dirs];
  }

  start(): void {
    const base = Array.isArray(this.opts.projectsDir) ? this.opts.projectsDir : [this.opts.projectsDir];
    this.addDirs(base);
    this.addDirs(this.opts.discover?.() ?? []);
    if (this.opts.discover) {
      this.discoverTimer = setInterval(() => this.addDirs(this.opts.discover!()), 30_000);
      this.discoverTimer.unref?.();
    }
    this.check(true);
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    clearInterval(this.pollTimer);
    clearInterval(this.discoverTimer);
    clearTimeout(this.pending);
  }

  private addDirs(dirs: string[]): void {
    let poll = false;
    for (const dir of dirs) {
      if (this.dirs.includes(dir)) continue;
      this.dirs.push(dir);
      if (isNetworkPath(dir)) { poll = true; continue; }
      try {
        // Recursive watching is supported on Windows, macOS and Linux (Node 20+).
        const w = fs.watch(dir, { recursive: true }, (_evt, name) => {
          if (!name || String(name).endsWith('.jsonl')) this.scheduleCheck();
        });
        w.on('error', () => this.startPolling(1000));
        this.watchers.push(w);
      } catch {
        // Directory missing (Claude Code never run yet) or watch unsupported.
        poll = true;
      }
    }
    // Network folders are polled every second; otherwise a slow safety net.
    this.startPolling(poll || this.dirs.some(isNetworkPath) ? 1000 : this.opts.pollMs ?? 5000);
  }

  private startPolling(ms: number): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.check(ms >= 5000), ms);
    this.pollTimer.unref?.();
  }

  private scheduleCheck(): void {
    // Coalesce bursts of watch events; stays well inside the 1 s budget.
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.check(true);
    }, 50);
  }

  /** Read new lines; rescan every folder for a newer session at most every 4s
   *  when polling (a full scan over a network share is comparatively slow). */
  private check(fullScan = false): void {
    const now = Date.now();
    if (fullScan || !this.tailer || now - this.lastScan > 4000) {
      this.lastScan = now;
      const next = this.pickSession(listSessions(this.dirs), now);
      if (next && next !== this.tailer?.file) { this.follow(next); return; }
    }
    if (this.tailer) this.consume();
  }

  /**
   * Which session to show when several are live (e.g. Windows and WSL):
   * a brand-new session takes over at once (you just started it); an existing
   * one only once the displayed session has been quiet for a minute, so two
   * busy sessions don't make the view flip back and forth.
   */
  private pickSession(sessions: { file: string; mtimeMs: number }[], now: number): string | undefined {
    const firstScan = this.known.size === 0;
    const fresh = sessions.filter((s) => !this.known.has(s.file));
    for (const s of sessions) this.known.add(s.file);
    const newest = sessions.reduce<{ file: string; mtimeMs: number } | undefined>((b, s) => (!b || s.mtimeMs > b.mtimeMs ? s : b), undefined);
    if (!this.tailer || firstScan) return newest?.file;
    const brandNew = fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (brandNew) return brandNew.file;
    const current = sessions.find((s) => s.file === this.tailer!.file);
    if (!current || now - current.mtimeMs > 60_000) return newest?.file;
    return this.tailer.file;
  }

  /** Switch to a session file: hand its history to the hub, then tail. */
  private follow(file: string): void {
    this.tailer = new LineTailer(file);
    this.sessionFile = file;
    this.sessionId = path.basename(file, '.jsonl');
    this.parser = new TranscriptParser(this.sessionId);
    this.subs.clear();
    this.retired.clear();
    this.linked.clear();

    const lines: Line[] = [];
    const push = (text: string, agentId?: string) => lines.push({ ts: parseTs(text), n: lines.length, text, agentId });
    for (const text of this.tailer.readExisting()) push(text);
    listSubagentFiles(file).forEach((sub, i) => {
      this.hintFor(sub.agentId, sub.file);
      const tailer = new LineTailer(sub.file);
      // Recent subagents are read in full; the long tail of old ones is only skipped past.
      const history = tailer.readExisting();
      if (i < MAX_HISTORY_SUBAGENTS) for (const text of history) push(text, sub.agentId);
      this.subs.set(sub.agentId, tailer);
    });

    const times = lines.map((l) => l.ts).filter((t) => !Number.isNaN(t));
    const signals = this.parse(lines);
    this.prune();
    if (signals.length) this.sessionId = this.parser.sessionId;
    const startedAt = times.length ? new Date(Math.min(...times)).toISOString() : new Date().toISOString();
    this.hub.adopt(this.sessionId, startedAt, signals);
  }

  private consume(): void {
    const lines: Line[] = [];
    const push = (text: string, agentId?: string) => lines.push({ ts: parseTs(text), n: lines.length, text, agentId });
    for (const text of this.tailer!.readNew()) push(text);
    this.discoverSubagents();
    for (const [agentId, tailer] of this.subs) {
      // meta.json may land a moment after the transcript; link as soon as it is there.
      if (!this.linked.has(agentId)) this.hintFor(agentId);
      for (const text of tailer.readNew()) push(text, agentId);
    }
    if (!lines.length) return;
    const signals = this.parse(lines);
    this.prune();
    if (signals.length) this.hub.ingest(signals);
    this.hub.touch(this.sessionId);
  }

  /** Lines from several files in time order, so a spawn precedes its subagent's lines. */
  private parse(lines: Line[]): Signal[] {
    lines.sort((a, b) => (Number.isNaN(a.ts) || Number.isNaN(b.ts) ? 0 : a.ts - b.ts) || a.n - b.n);
    return lines.flatMap((l) => this.parser.feed(l.text, l.agentId));
  }

  /** Start tailing subagent files that appeared since the last check. */
  private discoverSubagents(): void {
    for (const sub of listSubagentFiles(this.sessionFile)) {
      if (this.subs.has(sub.agentId) || this.retired.has(sub.agentId)) continue;
      this.hintFor(sub.agentId, sub.file);
      this.subs.set(sub.agentId, new LineTailer(sub.file));
    }
  }

  private hintFor(agentId: string, file = path.join(subagentDir(this.sessionFile), `agent-${agentId}.jsonl`)): void {
    const meta = readMeta(file);
    this.parser.hint({ agentId, ...meta });
    if (meta?.toolUseId) this.linked.add(agentId);
  }

  /** Stop tailing subagents that have finished, so hundreds of files never pile up. */
  private prune(): void {
    for (const id of [...this.subs.keys()]) {
      if (!this.parser.isDone(id)) continue;
      this.subs.delete(id);
      this.retired.add(id);
    }
  }
}
