import fs from 'node:fs';
import path from 'node:path';
import { parseJson, type Signal } from '../shared/events.js';
import type { SubagentFile } from '../shared/replay.js';
import { TranscriptParser, type SubagentHint } from '../shared/transcript.js';
import type { Hub } from './hub.js';

export interface TranscriptOptions {
  projectsDir: string;
  /** Fallback rescan interval, used only if fs.watch is unavailable or misses a
   *  brand-new session file. */
  pollMs?: number;
}

/** Newest top-level `<project>/<session>.jsonl` under the projects dir. */
export function findNewestSession(projectsDir: string): { file: string; mtimeMs: number } | undefined {
  let best: { file: string; mtimeMs: number } | undefined;
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return undefined;
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
        const { mtimeMs } = fs.statSync(file);
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {
        // Deleted between readdir and stat.
      }
    }
  }
  return best;
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
  private watcher: fs.FSWatcher | undefined;
  private pending: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: TranscriptOptions,
    private readonly hub: Pick<Hub, 'adopt' | 'ingest' | 'touch'>,
  ) {}

  start(): void {
    this.check();
    try {
      // Recursive watching is supported on Windows, macOS and Linux (Node 20+).
      this.watcher = fs.watch(this.opts.projectsDir, { recursive: true }, (_evt, name) => {
        if (!name || String(name).endsWith('.jsonl')) this.scheduleCheck();
      });
      this.watcher.on('error', () => this.startPolling(1000));
      // Slow safety net in case an event is dropped.
      this.startPolling(this.opts.pollMs ?? 5000);
    } catch {
      // Directory missing (Claude Code never run yet) or watch unsupported.
      this.startPolling(this.opts.pollMs ?? 1000);
    }
  }

  stop(): void {
    this.watcher?.close();
    clearInterval(this.pollTimer);
    clearTimeout(this.pending);
  }

  private startPolling(ms: number): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.check(), ms);
    this.pollTimer.unref?.();
  }

  private scheduleCheck(): void {
    // Coalesce bursts of watch events; stays well inside the 1 s budget.
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.check();
    }, 50);
  }

  private check(): void {
    const newest = findNewestSession(this.opts.projectsDir);
    if (newest && newest.file !== this.tailer?.file) this.follow(newest.file);
    else if (this.tailer) this.consume();
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
