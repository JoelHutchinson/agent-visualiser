import { activityWindow } from './activity.js';
import { isVisEvent, parseJson, publicEvent, type Signal } from './events.js';
import { attrs, isOtlpRequest, OtelMapper, type OtlpRequest } from './otel.js';
import { rootAgentId, type ServerMessage } from './protocol.js';
import { buildRecording, recordingToOtlp, type Recording } from './recording.js';
import { SessionModel } from './session-model.js';
import { TranscriptParser, type SubagentHint } from './transcript.js';

export type { Recording } from './recording.js';

/** A subagent's own transcript file (`<session>/subagents/agent-<id>.jsonl`) and its meta.json. */
export interface SubagentFile {
  agentId: string;
  meta?: Omit<SubagentHint, 'agentId'>;
  text: string;
}

/**
 * Turn a JSONL file into a recording. Each line may be a Claude Code
 * transcript line, a bare event, or a whole OTLP/JSON export (the format the
 * OpenTelemetry Collector's file exporter writes, and what `record` produces),
 * so sessions from any harness can be replayed. Claude Code keeps subagents in
 * separate files; pass them as `subagents` to include the hierarchy.
 */
export function parseRecording(text: string, subagents: SubagentFile[] = []): Recording {
  const signals: Signal[] = [];
  const mapper = new OtelMapper();
  const parser = new TranscriptParser();
  let startedAt: string | undefined;

  // Transcript lines are parsed in time order across files, so a spawn is
  // always seen before the subagent's own lines.
  const transcript: { ts: number; n: number; obj: Record<string, unknown>; file?: string }[] = [];
  const add = (line: string, file?: string) => {
    const obj = parseJson(line);
    if (!obj) return;
    if (!file && isOtlpRequest(obj)) {
      const req = obj as OtlpRequest;
      for (const r of [...(req.resourceSpans ?? []), ...(req.resourceLogs ?? [])]) {
        const start = attrs(r.resource?.attributes)['session.start'];
        if (!startedAt && typeof start === 'string') startedAt = start;
      }
      signals.push(...mapper.map(req));
      return;
    }
    const ts = obj.timestamp ?? obj.ts;
    if (!file && !startedAt && typeof ts === 'string') startedAt = ts;
    if (!file && isVisEvent(obj)) {
      const { type, tool, agentId, sessionId, ts, harness, callId } = obj;
      signals.push({ kind: 'event', event: { type, tool, agentId, sessionId, ts, harness, callId } });
      return;
    }
    transcript.push({ ts: typeof ts === 'string' ? Date.parse(ts) : NaN, n: transcript.length, obj, file });
  };
  for (const line of text.split('\n')) add(line);
  for (const f of subagents) {
    parser.hint({ agentId: f.agentId, ...f.meta });
    for (const line of f.text.split('\n')) add(line, f.agentId);
  }
  transcript.sort((x, y) => (Number.isNaN(x.ts) || Number.isNaN(y.ts) ? 0 : x.ts - y.ts) || x.n - y.n);
  for (const t of transcript) signals.push(...parser.feed(t.obj, t.file));

  return buildRecording(signals, startedAt);
}

/**
 * Serialise a recording as one OTLP/JSON trace export (GenAI semantic
 * conventions). It carries tool names, agent names and timestamps only: no
 * prompts, file contents or commands, so it is safe to publish.
 */
export function toOtlpRecording(rec: Recording): string {
  return JSON.stringify(recordingToOtlp(rec)) + '\n';
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

interface Timed {
  ts: string;
  msg: ServerMessage;
}

/**
 * A recording as the v2 messages a live session would have produced: agents
 * appearing and finishing, events, activities (derived from tool names and
 * durations with the same rules as the hub) and the root going to 'waiting'
 * when its turn ends.
 */
export function recordingToMessages(rec: Recording): Timed[] {
  const root = rootAgentId(rec.sessionId);
  // Ties at one instant: agents first, then work, then things ending.
  const items: { at: number; prio: number; ts: string; msg: ServerMessage }[] = [];
  const push = (ts: string, prio: number, msg: ServerMessage) => items.push({ at: Date.parse(ts), prio, ts, msg });
  const iso = (t: number) => new Date(t).toISOString();

  for (const a of rec.agents) {
    const info = { id: a.id, parentId: a.parentId, name: a.name, kind: a.kind, startedAt: a.startedAt };
    push(a.startedAt, 0, { kind: 'agent', agent: { ...info, state: 'working' }, ts: a.startedAt });
    if (a.endedAt) push(a.endedAt, 4, { kind: 'agent', agent: { ...info, state: 'done' }, ts: a.endedAt });
  }
  for (const e of rec.events) {
    if (e.type === 'idle') push(e.ts, 3, { kind: 'agent', agent: { id: root, parentId: null, name: 'Orchestrator', state: 'waiting', startedAt: rec.startedAt }, ts: e.ts });
    else push(e.ts, 2, { kind: 'event', event: publicEvent(e) });
  }
  for (const t of rec.tools) {
    const w = activityWindow(t.tool, Date.parse(t.start), t.end ? Date.parse(t.end) : undefined, t.ok);
    if (!w) continue;
    push(iso(w.start), 1, { kind: 'activity', agentId: t.agentId, activity: w.activity, op: 'start', ts: iso(w.start) });
    push(iso(w.end), 3, { kind: 'activity', agentId: t.agentId, activity: w.activity, op: 'end', ...(w.ok === undefined ? {} : { ok: w.ok }), ts: iso(w.end) });
  }
  items.sort((x, y) => x.at - y.at || x.prio - y.prio);

  // Any work while the root is waiting means the user spoke: back to working.
  const out: Timed[] = [];
  let waiting = true;
  for (const it of items) {
    const isWait = it.msg.kind === 'agent' && it.msg.agent.id === root && it.msg.agent.state === 'waiting';
    const isEnd = it.msg.kind === 'activity' ? it.msg.op === 'end' : it.msg.kind === 'agent' && it.msg.agent.state === 'done';
    if (waiting && !isWait && !isEnd) {
      out.push({ ts: it.ts, msg: { kind: 'agent', agent: { id: root, parentId: null, name: 'Orchestrator', state: 'working', startedAt: rec.startedAt }, ts: it.ts } });
      waiting = false;
    }
    if (isWait) {
      if (waiting) continue;
      waiting = true;
    }
    out.push({ ts: it.ts, msg: it.msg });
  }
  return out;
}

/**
 * Plays a recording at its original pace. Emits the same v2 messages as the
 * live daemon (source 'replay'), so the front end cannot tell the difference.
 */
export class ReplayPlayer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private index = 0;
  private speed: number;
  private readonly maxGapMs: number;
  private readonly loop: boolean;
  private readonly timeline: Timed[];
  private model: SessionModel;

  constructor(
    private readonly rec: Recording,
    private readonly emit: (msg: ServerMessage) => void,
    opts: ReplayOptions = {},
  ) {
    this.speed = opts.speed ?? 1;
    this.maxGapMs = opts.maxGapMs ?? 20_000;
    this.loop = opts.loop ?? false;
    this.timeline = recordingToMessages(rec);
    this.model = this.freshModel();
  }

  /** Number of messages a full playback emits after the opening snapshot. */
  get length(): number {
    return this.timeline.length;
  }

  start(): void {
    this.stop();
    this.index = 0;
    this.model = this.freshModel();
    this.emit(this.snapshot());
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
    return this.model.snapshot({ rate: this.speed, source: 'replay' });
  }

  private freshModel(): SessionModel {
    const harness = this.rec.events.find((e) => e.harness)?.harness;
    return new SessionModel(this.rec.sessionId, this.rec.startedAt, harness);
  }

  private gapBefore(i: number): number {
    const prev = i === 0 ? this.rec.startedAt : this.timeline[i - 1].ts;
    const gap = Date.parse(this.timeline[i]?.ts ?? prev) - Date.parse(prev);
    return Number.isFinite(gap) ? Math.max(0, Math.min(gap, this.maxGapMs)) : 0;
  }

  private scheduleNext(recordedGapMs: number): void {
    if (this.index >= this.timeline.length) {
      if (this.loop && this.timeline.length) this.timer = setTimeout(() => this.start(), 3000);
      else this.emit({ kind: 'ended' });
      return;
    }
    this.timer = setTimeout(() => {
      const { msg } = this.timeline[this.index];
      this.model.apply(msg);
      this.emit(msg);
      this.index++;
      this.scheduleNext(this.index < this.timeline.length ? this.gapBefore(this.index) : 0);
    }, recordedGapMs / this.speed);
  }
}
