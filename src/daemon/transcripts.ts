import fs from 'node:fs';
import path from 'node:path';
import { lineToEvent, parseJson, type VisEvent } from '../shared/events.js';
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

/**
 * Claude Code adapter: follows the most recently modified session transcript
 * and hands its events to the hub. Read-only: never writes to ~/.claude.
 */
export class TranscriptSource {
  private tailer: LineTailer | undefined;
  private sessionId = '';
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
    else if (this.tailer) this.consume(this.tailer.readNew());
  }

  /** Switch to a session file: hand its history to the hub, then tail. */
  private follow(file: string): void {
    this.tailer = new LineTailer(file);
    this.sessionId = path.basename(file, '.jsonl');
    let startedAt = '';
    const history: VisEvent[] = [];
    for (const line of this.tailer.readExisting()) {
      startedAt ||= timestampOf(line);
      const ev = lineToEvent(line);
      if (ev) history.push(ev);
    }
    if (history.length) this.sessionId = history[history.length - 1].sessionId;
    this.hub.adopt(this.sessionId, startedAt || new Date().toISOString(), history);
  }

  private consume(lines: string[]): void {
    if (!lines.length) return;
    const events = lines.map(lineToEvent).filter((e): e is VisEvent => e !== null);
    if (events.length) this.hub.ingest(events);
    this.hub.touch(this.sessionId);
  }
}

function timestampOf(line: string): string {
  const ts = parseJson(line)?.timestamp;
  return typeof ts === 'string' ? ts : '';
}
