import { activityOf, MAX_ACTIVITY_MS, PLAN_TIMEOUT_MS, RUN_AFTER_MS } from '../shared/activity.js';
import { IDLE_AFTER_MS, publicEvent, signalSession, signalTs, type Signal, type VisEvent } from '../shared/events.js';
import { rootAgentId, type ActivityKind, type AgentInfo, type AgentState, type ServerMessage } from '../shared/protocol.js';
import { SessionModel } from '../shared/session-model.js';

/** A tool call in flight whose activity we are timing. */
interface OpenTool {
  agentId: string;
  activity: ActivityKind;
  started: boolean;
  /** Fires the delayed 'run' start. */
  startTimer?: NodeJS.Timeout;
  /** Ends the activity if the result never arrives. */
  endTimer?: NodeJS.Timeout;
}

interface SessionState {
  id: string;
  model: SessionModel;
  /** `${type}:${callId}` (events) and `tool:${callId}` (activities) already
   *  counted, so a call seen via two channels (transcript + OTLP, or OTLP logs
   *  + spans) only bubbles once. */
  seen: Set<string>;
  tools: Map<string, OpenTool>;
  /** Live activity refcounts: parallel calls of one kind are one activity. */
  active: Map<string, number>;
}

const MAX_SESSIONS = 50;
const MAX_SEEN = 5000;
/** A call opened this long ago and never answered is a dead harness, not work. */
const STALE_MS = 5 * 60_000;

/**
 * Merges signals from every source (Claude Code transcripts, OTLP from any
 * harness) into one displayed session and speaks wire protocol v2. Policy: a
 * brand-new session takes over the screen; an already-known one only does
 * when the current session's orchestrator is waiting, so two busy agents
 * don't flicker back and forth.
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
    return this.current ? this.current.model.snapshot({ rate: 1, source: 'live' }) : { kind: 'waiting' };
  }

  /**
   * Load a session's history silently (e.g. a transcript that was already
   * running when the daemon started) and put it on screen. Calls still in
   * flight at the end of the history are picked up as live activities.
   */
  adopt(sessionId: string, startedAt: string, history: Signal[]): void {
    const s = this.session(sessionId, startedAt);
    s.model.startedAt = startedAt;
    s.model.harness ??= history.flatMap((x) => (x.kind === 'event' && x.event.harness ? [x.event.harness] : []))[0];
    const pending = new Map<string, Extract<Signal, { kind: 'tool' }>>();
    let waiting = true;
    for (const sig of history) {
      if (sig.kind === 'event') {
        const ev = sig.event;
        if (ev.type === 'idle') waiting = true;
        else if (this.count(s, ev)) {
          s.model.apply({ kind: 'event', event: publicEvent(ev) });
          waiting = false;
        }
      } else if (sig.kind === 'agent') {
        if (sig.agent.id === rootAgentId(s.id)) {
          if (sig.agent.state === 'working') waiting = false;
        } else {
          this.applyAgent(s, sig.agent, sig.ts, false);
          if (sig.agent.state === 'working') waiting = false;
        }
      } else if (sig.callId) {
        if (sig.op === 'start') pending.set(sig.callId, sig);
        else pending.delete(sig.callId);
        waiting = false;
      }
    }
    this.setRoot(s, waiting ? 'waiting' : 'working', new Date().toISOString(), false);
    this.show(s);
    for (const sig of pending.values()) this.tool(s, sig);
    if (!waiting) this.armIdle();
  }

  ingest(signals: Signal[]): void {
    for (const sig of signals) {
      const id = signalSession(sig);
      const known = this.sessions.has(id);
      const s = this.session(id, signalTs(sig));
      if (sig.kind === 'event' && sig.event.harness) s.model.harness = sig.event.harness;
      // Switch before applying, so the snapshot doesn't include what the scene
      // is about to animate.
      if (s !== this.current && (!known || !this.current || this.current.model.root.state !== 'working')) this.show(s);
      if (sig.kind === 'event') this.event(s, sig.event);
      else if (sig.kind === 'agent') this.agent(s, sig.agent, sig.ts);
      else this.tool(s, sig);
    }
    if (signals.some((x) => signalSession(x) === this.current?.id)) this.armIdle();
  }

  /** Any sign of life (a transcript line with no signal, say) postpones idle. */
  touch(sessionId: string): void {
    if (sessionId === this.current?.id) this.armIdle();
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    for (const s of this.sessions.values()) this.dropTools(s);
  }

  // ------------------------------------------------------------- signals

  private event(s: SessionState, ev: VisEvent): void {
    const ts = ev.ts;
    if (Date.parse(ts) < Date.parse(s.model.startedAt)) s.model.startedAt = ts;
    if (ev.type === 'idle') {
      // The root's turn is over: the user's move.
      this.setRoot(s, 'waiting', ts);
      return;
    }
    if (!this.count(s, ev)) return;
    this.setRoot(s, 'working', ts);
    this.send(s, { kind: 'event', event: publicEvent(ev) });
  }

  private agent(s: SessionState, agent: AgentInfo, ts: string): void {
    const root = rootAgentId(s.id);
    if (agent.id === root) {
      // The root is implicit; signals about it carry state (and, from OTel,
      // its name). The default name must not overwrite a real one.
      if (agent.name !== 'Orchestrator') this.applyAgent(s, { ...s.model.root, name: agent.name, kind: agent.kind }, ts);
      this.setRoot(s, agent.state === 'done' ? 'waiting' : agent.state, ts);
      return;
    }
    // A subagent starting is the orchestrator's doing.
    if (agent.state === 'working') this.setRoot(s, 'working', ts);
    this.applyAgent(s, agent, ts);
  }

  /** Apply an agent upsert; emits only when something changed. */
  private applyAgent(s: SessionState, agent: AgentInfo, ts: string, live = true): void {
    const prev = s.model.agents.get(agent.id);
    if (!prev && agent.state === 'done') return; // already gone, or never seen
    if (prev && prev.parentId === agent.parentId && prev.name === agent.name && prev.kind === agent.kind && prev.state === agent.state) return;
    const next: AgentInfo = { ...agent, startedAt: prev?.startedAt ?? agent.startedAt };
    if (agent.state === 'done') this.endAgentTools(s, agent.id, ts);
    this.send(s, { kind: 'agent', agent: next, ts }, live);
  }

  private setRoot(s: SessionState, state: AgentState, ts: string, live = true): void {
    const root = s.model.root;
    if (root.state === state) return;
    this.send(s, { kind: 'agent', agent: { ...root, state }, ts }, live);
  }

  /** Count a call once; false if it is a duplicate. */
  private count(s: SessionState, ev: VisEvent): boolean {
    if (!ev.callId) return true;
    return this.firstSight(s, `${ev.type}:${ev.callId}`);
  }

  private firstSight(s: SessionState, key: string): boolean {
    if (s.seen.has(key)) return false;
    s.seen.add(key);
    if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.values().next().value!);
    return true;
  }

  // ---------------------------------------------------------- activities

  private tool(s: SessionState, sig: Extract<Signal, { kind: 'tool' }>): void {
    const activity = activityOf(sig.tool);
    if (sig.op === 'start') {
      const key = sig.callId;
      if (!key || !activity) return;
      const stale = Date.now() - Date.parse(sig.ts);
      if (stale > STALE_MS || !this.firstSight(s, `tool:${key}`)) return;
      this.setRoot(s, 'working', sig.ts);
      const t: OpenTool = { agentId: sig.agentId, activity, started: false };
      s.tools.set(key, t);
      if (activity === 'run') {
        // Fast commands never show: only announce one still out after 1.5 s.
        t.startTimer = setTimeout(() => this.begin(s, key, t), Math.max(0, RUN_AFTER_MS - Math.max(0, stale)));
      } else this.begin(s, key, t);
      return;
    }

    const open = sig.callId ? s.tools.get(sig.callId) : undefined;
    if (open) {
      this.finishTool(s, sig.callId!, open, sig.ok, sig.ts);
      return;
    }
    // Sources that only see finished calls (OTel) send an end with a duration.
    // The result is already in, so an activity would be a blink: 'run' and
    // 'web' show only if the call was long, 'plan' and 'wait' always.
    if (!activity || sig.durationMs === undefined) return;
    if (sig.callId && !this.firstSight(s, `tool:${sig.callId}`)) return;
    if ((activity === 'run' || activity === 'web') && sig.durationMs < RUN_AFTER_MS) return;
    this.setRoot(s, 'working', sig.ts);
    this.startActivity(s, sig.agentId, activity, new Date(Date.parse(sig.ts) - sig.durationMs).toISOString());
    this.endActivity(s, sig.agentId, activity, sig.ts, activity === 'run' ? sig.ok !== false : undefined);
  }

  private begin(s: SessionState, key: string, t: OpenTool): void {
    t.startTimer = undefined;
    if (s.tools.get(key) !== t) return;
    t.started = true;
    this.startActivity(s, t.agentId, t.activity, new Date().toISOString());
    t.endTimer = setTimeout(() => this.finishTool(s, key, t, undefined, new Date().toISOString()), t.activity === 'plan' ? PLAN_TIMEOUT_MS : MAX_ACTIVITY_MS);
  }

  private finishTool(s: SessionState, key: string, t: OpenTool, ok: boolean | undefined, ts: string): void {
    clearTimeout(t.startTimer);
    clearTimeout(t.endTimer);
    s.tools.delete(key);
    // A run that finished before it was announced never gets a start or end.
    if (t.started) this.endActivity(s, t.agentId, t.activity, ts, t.activity === 'run' ? ok !== false : undefined);
  }

  private startActivity(s: SessionState, agentId: string, activity: ActivityKind, ts: string): void {
    const key = `${agentId}:${activity}`;
    const n = s.active.get(key) ?? 0;
    s.active.set(key, n + 1);
    if (n === 0) this.send(s, { kind: 'activity', agentId, activity, op: 'start', ts });
  }

  private endActivity(s: SessionState, agentId: string, activity: ActivityKind, ts: string, ok?: boolean): void {
    const key = `${agentId}:${activity}`;
    const n = s.active.get(key) ?? 0;
    if (n <= 1) s.active.delete(key);
    else s.active.set(key, n - 1);
    if (n === 1) this.send(s, { kind: 'activity', agentId, activity, op: 'end', ...(ok === undefined ? {} : { ok }), ts });
  }

  /** A finished agent leaves nothing running behind. */
  private endAgentTools(s: SessionState, agentId: string, ts: string): void {
    for (const [key, t] of s.tools) if (t.agentId === agentId) this.finishTool(s, key, t, undefined, ts);
  }

  private dropTools(s: SessionState): void {
    for (const t of s.tools.values()) {
      clearTimeout(t.startTimer);
      clearTimeout(t.endTimer);
    }
    s.tools.clear();
  }

  // ------------------------------------------------------------- plumbing

  private session(id: string, startedAt: string): SessionState {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, model: new SessionModel(id, startedAt), seen: new Set(), tools: new Map(), active: new Map() };
      this.sessions.set(id, s);
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value!;
        if (oldest !== this.current?.id) {
          this.dropTools(this.sessions.get(oldest)!);
          this.sessions.delete(oldest);
        }
      }
    }
    return s;
  }

  /** Record a message in the session's model; send it if the session is on screen. */
  private send(s: SessionState, msg: ServerMessage, live = true): void {
    s.model.apply(msg);
    if (live && s === this.current) this.emit(msg);
  }

  private show(s: SessionState): void {
    this.current = s;
    this.emit(this.snapshot());
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    const s = this.current;
    if (!s || s.model.root.state !== 'working') return;
    this.idleTimer = setTimeout(() => {
      if (this.current !== s || s.model.root.state !== 'working') return;
      // A command or web call still out means the agent is busy, not waiting.
      const busy = [...s.model.activities.values()].some((a) => Date.now() - Date.parse(a.since) < MAX_ACTIVITY_MS);
      if (busy) return this.armIdle();
      this.setRoot(s, 'waiting', new Date().toISOString());
    }, this.idleAfterMs);
  }
}
