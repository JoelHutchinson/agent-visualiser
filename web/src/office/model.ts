// Live model: turns protocol v2 messages into an agent tree plus a stream of
// scene-level happenings (spawn, promote, state, finish, activity, event) that
// the renderers act out. Roles come from the tree, never from the wire:
// root = orchestrator, an agent with children = manager, a leaf = worker.
import type { ActivityKind, AgentInfo, AgentState, ServerMessage } from '../../../src/shared/protocol';
import type { CountType, Host } from './types';

export type Role = 'orchestrator' | 'manager' | 'worker';
export type Tier = 'studio' | 'office' | 'mega';
export const TIERS: Tier[] = ['studio', 'office', 'mega'];

/** One activity in progress for an agent (started, not yet ended). */
export interface Act {
  kind: ActivityKind;
  ended: boolean;
  /** Result of a finished 'run' (false = it failed). */
  ok?: boolean;
  /** This wait shows the "..." bubble at the desk (nowhere to walk to). */
  dots?: boolean;
}

export interface Agent {
  id: string;
  /** Arrival number, stable within the session: picks looks and colours. */
  seq: number;
  name: string;
  kind?: string;
  state: AgentState;
  parent: Agent | null;
  children: Agent[];
  role: Role;
  depth: number;
  born: number;
  acts: Act[];
}

/** What the renderers implement. The model calls these; they never call back into the tree except `remove`. */
export interface ModelListener {
  /** Everything is gone (new session, or waiting for one). */
  onReset(): void;
  /** A full resync finished populating; `model.building` was true while it ran. */
  onSynced(): void;
  onSpawn(a: Agent, initial: boolean): void;
  /** A worker gained its first child and is now a manager. */
  onPromote(a: Agent): void;
  onState(a: Agent, prev: AgentState): void;
  /** The agent finished: report, coffee, leave, then call `model.remove(a)`. */
  onFinish(a: Agent): void;
  onActivity(a: Agent, act: Act): void;
  onActivityEnd(a: Agent, act: Act): void;
  /** `a` is null when the event cannot be placed (no agents yet). */
  onEvent(a: Agent | null, type: CountType): void;
}

const emptyCounts = (): Record<CountType, number> => ({ research: 0, code: 0, bug: 0 });
const total = (c: Record<CountType, number>) => c.research + c.code + c.bug;

export class OfficeModel {
  readonly agents = new Map<string, Agent>();
  root: Agent | null = null;
  sessionId = '';
  startedAt = '';
  counts = emptyCounts();
  /** True while a full resync is being replayed into the renderer (no walking, no curtain). */
  building = false;
  /** The root's last counted event was 'idle' (the agent finished its turn). */
  idle = true;
  ended = false;
  onChange?: () => void;
  private listener: ModelListener | null = null;
  private seq = 0;

  constructor(private readonly host: Pick<Host, 'setCounts'>) {}

  attach(listener: ModelListener): void {
    this.listener = listener;
    // Bring a renderer that arrives late up to date.
    if (this.agents.size) {
      this.listener.onReset();
      this.building = true;
      for (const a of this.list) this.listener.onSpawn(a, true);
      this.building = false;
      this.listener.onSynced();
    }
  }
  detach(): void { this.listener = null; }

  get list(): Agent[] { return [...this.agents.values()]; }
  get managers(): Agent[] { return this.list.filter((a) => a.role !== 'worker'); }

  /** The top-level manager an agent belongs to (its department), if any. */
  deptOf(a: Agent): Agent | null {
    let n = a;
    while (n.parent?.parent) n = n.parent;
    return n.parent && n.role === 'manager' ? n : null;
  }

  /** Which building the current organisation needs (it only ever grows within a session). */
  tierNeeded(): Tier {
    const mgrs = this.list.filter((a) => a.role === 'manager').length;
    const rootWorkers = this.root ? this.root.children.filter((c) => c.role === 'worker').length : 0;
    if (mgrs === 0 && rootWorkers <= 6) return 'studio';
    if (mgrs <= 4 && this.agents.size <= 30) return 'office';
    return 'mega';
  }

  // ------------------------------------------------------------- messages
  handle(msg: ServerMessage): void {
    switch (msg.kind) {
      case 'waiting':
        this.clear();
        this.sessionId = '';
        this.host.setCounts(emptyCounts());
        break;
      case 'session':
        this.applySession(msg);
        break;
      case 'agent':
        this.upsert(msg.agent);
        break;
      case 'activity':
        if (msg.op === 'start') this.startActivity(msg.agentId, msg.activity);
        else this.endActivity(msg.agentId, msg.activity, msg.ok);
        break;
      case 'event': {
        const ev = msg.event;
        if (ev.type === 'idle') { this.idle = true; break; }
        this.idle = false;
        this.counts[ev.type]++;
        const a = (ev.agentId ? this.agents.get(ev.agentId) : undefined) ?? this.root;
        this.listener?.onEvent(a ?? null, ev.type);
        break;
      }
      case 'ended':
        this.ended = true;
        this.idle = true;
        break;
    }
    this.onChange?.();
  }

  private clear(): void {
    this.agents.clear();
    this.root = null;
    this.seq = 0;
    this.counts = emptyCounts();
    this.ended = false;
    this.idle = true;
    this.listener?.onReset();
  }

  private applySession(msg: Extract<ServerMessage, { kind: 'session' }>): void {
    this.ended = false;
    const same = this.root !== null && this.sessionId === msg.sessionId && this.startedAt === msg.startedAt && total(msg.counts) >= total(this.counts);
    this.sessionId = msg.sessionId;
    this.startedAt = msg.startedAt;
    this.host.setCounts(msg.counts);
    this.counts = { ...msg.counts };
    if (!same) this.rebuild(msg);
    else this.reconcile(msg);
  }

  /** Full resync: link the whole tree first (so roles are right from the start), then seat everyone. */
  private rebuild(msg: Extract<ServerMessage, { kind: 'session' }>): void {
    this.clear();
    this.counts = { ...msg.counts };
    this.building = true;
    const made: Agent[] = [];
    for (const info of msg.agents) if (info.state !== 'done') made.push(this.link(info));
    for (const a of made) this.listener?.onSpawn(a, true);
    for (const act of msg.activities) this.startActivity(act.agentId, act.activity);
    this.building = false;
    this.idle = !this.root || this.root.state !== 'working';
    this.listener?.onSynced();
  }

  /** Same session, new snapshot: bring the scene in line without tearing it down. */
  private reconcile(msg: Extract<ServerMessage, { kind: 'session' }>): void {
    const seen = new Set<string>();
    for (const info of msg.agents) { seen.add(info.id); this.upsert(info); }
    for (const a of this.list) if (!seen.has(a.id) && a.state !== 'done' && a !== this.root) this.finish(a);
    const live = new Set(msg.activities.map((x) => `${x.agentId}:${x.activity}`));
    for (const a of this.list) for (const act of [...a.acts]) if (!live.has(`${a.id}:${act.kind}`)) this.endActivity(a.id, act.kind);
    for (const x of msg.activities) {
      const a = this.agents.get(x.agentId);
      if (a && !a.acts.some((q) => q.kind === x.activity)) this.startActivity(x.agentId, x.activity);
    }
  }

  private link(info: AgentInfo): Agent {
    let parent = info.parentId ? this.agents.get(info.parentId) ?? null : null;
    if (!parent && this.root) parent = this.root;           // orphan: hang it off the root
    const a: Agent = {
      id: info.id, seq: this.seq++, name: info.name, kind: info.kind, state: info.state, parent, children: [],
      role: parent ? 'worker' : 'orchestrator', depth: parent ? parent.depth + 1 : 0, born: performance.now(), acts: [],
    };
    if (parent) {
      parent.children.push(a);
      if (parent.role === 'worker') parent.role = 'manager';
    } else this.root = a;
    this.agents.set(a.id, a);
    return a;
  }

  private upsert(info: AgentInfo): void {
    const a = this.agents.get(info.id);
    if (!a) {
      if (info.state === 'done') return;
      const parent = info.parentId ? this.agents.get(info.parentId) : undefined;
      const promote = parent && parent.role === 'worker' ? parent : null;
      const child = this.link(info);
      if (promote) this.listener?.onPromote(promote);
      this.listener?.onSpawn(child, false);
      return;
    }
    a.name = info.name;
    a.kind = info.kind ?? a.kind;
    if ((a.state === 'done' && a !== this.root) || info.state === a.state) return;
    if (info.state === 'done') { this.finish(a); return; }
    const prev = a.state;
    a.state = info.state;
    this.listener?.onState(a, prev);
  }

  private finish(a: Agent): void {
    for (const act of [...a.acts]) this.endActivity(a.id, act.kind);
    a.state = 'done';
    if (a === this.root) { this.listener?.onState(a, 'working'); return; }   // the boss stays at the desk
    this.listener?.onFinish(a);
  }

  private startActivity(agentId: string, kind: ActivityKind): void {
    const a = this.agents.get(agentId);
    if (!a || a.state === 'done') return;
    const act: Act = { kind, ended: false };
    a.acts.push(act);
    this.listener?.onActivity(a, act);
  }

  private endActivity(agentId: string, kind: ActivityKind, ok?: boolean): void {
    const a = this.agents.get(agentId);
    const act = a?.acts.find((x) => x.kind === kind && !x.ended);
    if (!a || !act) return;
    act.ended = true;
    act.ok = ok;
    a.acts.splice(a.acts.indexOf(act), 1);
    this.listener?.onActivityEnd(a, act);
  }

  /** Called by a renderer once a finished agent has walked out. */
  remove(a: Agent): void {
    if (a.parent) { const i = a.parent.children.indexOf(a); if (i >= 0) a.parent.children.splice(i, 1); }
    this.agents.delete(a.id);
  }
}
