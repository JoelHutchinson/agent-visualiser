import { emptyCounts, objectToEvent, parseJson, type ServerMessage, type VisEvent } from './events.js';
import { attrs, eventsToOtlp, isOtlpRequest, otlpToEvents, type OtlpRequest } from './otel.js';

export interface Recording {
  sessionId: string;
  startedAt: string;
  events: VisEvent[];
}

/**
 * Turn a JSONL file into a recording. Each line may be a Claude Code
 * transcript line, a bare event, or a whole OTLP/JSON export (the format the
 * OpenTelemetry Collector's file exporter writes, and what `record` produces),
 * so sessions from any harness can be replayed.
 */
export function parseRecording(text: string): Recording {
  const events: VisEvent[] = [];
  let startedAt: string | undefined;
  for (const line of text.split('\n')) {
    const obj = parseJson(line);
    if (!obj) continue;
    if (isOtlpRequest(obj)) {
      const req = obj as OtlpRequest;
      for (const r of [...(req.resourceSpans ?? []), ...(req.resourceLogs ?? [])]) {
        const start = attrs(r.resource?.attributes)['session.start'];
        if (!startedAt && typeof start === 'string') startedAt = start;
      }
      events.push(...otlpToEvents(req));
      continue;
    }
    const ts = obj.timestamp ?? obj.ts;
    if (!startedAt && typeof ts === 'string') startedAt = ts;
    const ev = objectToEvent(obj);
    if (ev) events.push(ev);
  }
  events.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));

  // A file may interleave sessions; replay the busiest one.
  const bySession = new Map<string, number>();
  for (const e of events) bySession.set(e.sessionId, (bySession.get(e.sessionId) ?? 0) + 1);
  const sessionId = [...bySession].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'replay';
  // The same call can arrive as both an OTLP log and a span; count it once.
  const seen = new Set<string>();
  const mine = events.filter((e) => {
    if (e.sessionId !== sessionId) return false;
    if (!e.callId || e.type === 'idle') return true;
    const key = `${e.type}:${e.callId}`;
    return !seen.has(key) && !!seen.add(key);
  });
  const firstTs = mine[0]?.ts;
  if (!startedAt || (firstTs && Date.parse(firstTs) < Date.parse(startedAt))) startedAt = firstTs;
  return { sessionId, startedAt: startedAt ?? new Date().toISOString(), events: mine };
}

/**
 * Serialise a recording as one OTLP/JSON trace export (GenAI semantic
 * conventions). It carries tool names and timestamps only: no prompts, file
 * contents or commands, so it is safe to publish.
 */
export function toOtlpRecording(rec: Recording): string {
  return JSON.stringify(eventsToOtlp(rec.events, rec.startedAt)) + '\n';
}

export interface ReplayOptions {
  /** Playback speed multiplier. */
  speed?: number;
  /** Longest pause (in recorded ms) before it is compressed, so a lunch break
   *  in the recording does not stall the demo. */
  maxGapMs?: number;
  /** Start again from the top when the recording ends. */
  loop?: boolean;
}

/**
 * Plays a recording at its original pace. Emits the same messages as the live
 * daemon, so the front end cannot tell the difference.
 */
export class ReplayPlayer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private index = 0;
  private speed: number;
  private readonly maxGapMs: number;
  private readonly loop: boolean;

  constructor(
    private readonly rec: Recording,
    private readonly emit: (msg: ServerMessage) => void,
    opts: ReplayOptions = {},
  ) {
    this.speed = opts.speed ?? 1;
    this.maxGapMs = opts.maxGapMs ?? 20_000;
    this.loop = opts.loop ?? false;
  }

  start(): void {
    this.stop();
    this.index = 0;
    this.emit(this.sessionMessage());
    this.scheduleNext(this.gapBefore(0));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    // Re-announce so the scene's clock picks up the new rate.
    this.emit(this.snapshot());
  }

  /** Current state, for a client that connects mid-replay. */
  snapshot(): ServerMessage {
    const last = this.rec.events[this.index - 1];
    return { ...this.sessionMessage(), counts: this.countsSoFar(), idle: !last || last.type === 'idle' };
  }

  private sessionMessage(): Extract<ServerMessage, { kind: 'session' }> {
    return {
      kind: 'session',
      sessionId: this.rec.sessionId,
      startedAt: this.rec.startedAt,
      counts: emptyCounts(),
      idle: true,
      rate: this.speed,
      source: 'replay',
      harness: this.rec.events.find((e) => e.harness)?.harness,
    };
  }

  private countsSoFar() {
    const counts = emptyCounts();
    for (const ev of this.rec.events.slice(0, this.index)) if (ev.type !== 'idle') counts[ev.type]++;
    return counts;
  }

  private gapBefore(i: number): number {
    const prev = i === 0 ? this.rec.startedAt : this.rec.events[i - 1].ts;
    const gap = Date.parse(this.rec.events[i]?.ts ?? prev) - Date.parse(prev);
    return Number.isFinite(gap) ? Math.max(0, Math.min(gap, this.maxGapMs)) : 0;
  }

  private scheduleNext(recordedGapMs: number): void {
    if (this.index >= this.rec.events.length) {
      if (this.loop && this.rec.events.length) this.timer = setTimeout(() => this.start(), 3000);
      else this.emit({ kind: 'ended' });
      return;
    }
    this.timer = setTimeout(() => {
      const { callId: _callId, ...event } = this.rec.events[this.index];
      this.emit({ kind: 'event', event });
      this.index++;
      this.scheduleNext(this.index < this.rec.events.length ? this.gapBefore(this.index) : 0);
    }, recordedGapMs / this.speed);
  }
}
