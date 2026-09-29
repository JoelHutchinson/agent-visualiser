import {
  emptyCounts,
  IDLE_AFTER_MS,
  publicEvent,
  tally,
  type Counts,
  type ServerMessage,
  type VisEvent,
} from '../shared/events.js';

interface SessionState {
  id: string;
  startedAt: string;
  harness?: string;
  counts: Counts;
  idle: boolean;
  /** `${type}:${callId}` already counted, so a call seen via two channels
   *  (transcript + OTLP, or OTLP logs + spans) only bubbles once. */
  seen: Set<string>;
}

const MAX_SESSIONS = 50;
const MAX_SEEN = 5000;

/**
 * Merges events from every source (Claude Code transcripts, OTLP from any
 * harness) into one displayed session. Policy: a brand-new session takes
 * over the screen; an already-known one only does when the current session
 * is idle, so two busy agents don't flicker back and forth.
 */
export class Hub {
  private sessions = new Map<string, SessionState>();
  private current: SessionState | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly idleAfterMs: number;

  constructor(
    private readonly emit: (msg: ServerMessage) => void,
    opts: { idleAfterMs?: number } = {},
  ) {
    this.idleAfterMs = opts.idleAfterMs ?? IDLE_AFTER_MS;
  }

  snapshot(): ServerMessage {
    const s = this.current;
    if (!s) return { kind: 'waiting' };
    return {
      kind: 'session',
      sessionId: s.id,
      startedAt: s.startedAt,
      counts: { ...s.counts },
      idle: s.idle,
      rate: 1,
      source: 'live',
      harness: s.harness,
    };
  }

  /**
   * Load a session's history silently (e.g. a transcript that was already
   * running when the daemon started) and put it on screen.
   */
  adopt(sessionId: string, startedAt: string, history: VisEvent[]): void {
    const s = this.session(sessionId, startedAt);
    s.startedAt = startedAt;
    s.harness ??= history.find((e) => e.harness)?.harness;
    for (const ev of history) this.count(s, ev);
    const last = history[history.length - 1];
    s.idle = !last || last.type === 'idle';
    this.show(s);
    if (!s.idle) this.armIdle();
  }

  ingest(events: VisEvent[]): void {
    for (const ev of events) {
      const known = this.sessions.has(ev.sessionId);
      const s = this.session(ev.sessionId, ev.ts);
      if (ev.harness) s.harness = ev.harness;
      // Switch before counting, so the snapshot doesn't include the event the
      // scene is about to animate.
      if (s !== this.current && (!known || !this.current || this.current.idle)) this.show(s);
      if (!this.count(s, ev)) continue;
      s.idle = ev.type === 'idle';
      if (s === this.current) this.emit({ kind: 'event', event: publicEvent(ev) });
    }
    if (events.some((e) => e.sessionId === this.current?.id)) this.armIdle();
  }

  /** Any sign of life (a transcript line with no event, say) postpones idle. */
  touch(sessionId: string): void {
    if (sessionId === this.current?.id) this.armIdle();
  }

  stop(): void {
    clearTimeout(this.idleTimer);
  }

  private session(id: string, startedAt: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, startedAt, counts: emptyCounts(), idle: true, seen: new Set() };
      this.sessions.set(id, s);
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value!;
        if (oldest !== this.current?.id) this.sessions.delete(oldest);
      }
    }
    return s;
  }

  /** Tally an event; false if it is a duplicate or a redundant idle. */
  private count(s: SessionState, ev: VisEvent): boolean {
    if (Date.parse(ev.ts) < Date.parse(s.startedAt)) s.startedAt = ev.ts;
    if (ev.type === 'idle') return !s.idle || s !== this.current;
    if (ev.callId) {
      const key = `${ev.type}:${ev.callId}`;
      if (s.seen.has(key)) return false;
      s.seen.add(key);
      if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.values().next().value!);
    }
    tally(s.counts, ev);
    return true;
  }

  private show(s: SessionState): void {
    this.current = s;
    this.emit(this.snapshot());
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const s = this.current;
    if (!s || s.idle) return;
    this.idleTimer = setTimeout(() => {
      if (this.current !== s || s.idle) return;
      s.idle = true;
      this.emit({ kind: 'event', event: { type: 'idle', sessionId: s.id, ts: new Date().toISOString(), harness: s.harness } });
    }, this.idleAfterMs);
  }
}
