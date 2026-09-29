// Simulator feed: emits protocol v2 messages (session, agent, activity, event)
// for `?demo` and the hosted demo build, so the front end can be exercised
// with no daemon. It plays a plausible agent team: subagents spawn, work,
// leave; sub-teams form; agents plan, research, run commands and wait.
import type { ActivityKind, AgentInfo, AgentState, ServerMessage } from '../../../src/shared/protocol';
import type { Feed } from './feeds';

export type Preset = 'solo' | 'team' | 'departments' | 'swarm' | 'story';
export const PRESETS: { id: Preset; label: string }[] = [
  { id: 'story', label: 'Growing story' },
  { id: 'solo', label: 'Solo (studio)' },
  { id: 'team', label: 'Team' },
  { id: 'departments', label: 'Departments' },
  { id: 'swarm', label: 'Swarm' },
];

const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi', 'Rho', 'Sigma', 'Tau', 'Upsilon'];
const KINDS = ['Explore', 'general-purpose', 'code-reviewer', 'Plan', 'test-runner'];
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

interface SimAgent { id: string; parentId: string | null; name: string; kind?: string; state: AgentState; born: number; startedAt: string; kids: number; depth: number; busy: boolean }

export interface DemoControls {
  readonly preset: Preset;
  /** Toggle the root agent waiting on the user; returns the new state. */
  toggleWait(): boolean;
  addWorker(): void;
  addTeam(): void;
}

export class Simulator implements Feed, DemoControls {
  private agents = new Map<string, SimAgent>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private n = 0;
  private teamNo = 0;
  private root!: SimAgent;
  private readonly sessionId = `demo-${Math.random().toString(36).slice(2, 8)}`;
  private stopped = false;

  constructor(readonly preset: Preset, private readonly emit: (m: ServerMessage) => void) {}

  start(): void {
    const now = new Date().toISOString();
    this.root = this.make(null, 'Orchestrator');
    this.build();
    this.emit({
      kind: 'session', sessionId: this.sessionId, startedAt: now, harness: 'claude-code', source: 'demo', rate: 1,
      counts: { research: 0, code: 0, bug: 0 }, agents: [...this.agents.values()].map(info), activities: [],
    });
    for (const a of this.agents.values()) a.born = performance.now();
    this.simulate();
  }
  close(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.pending) clearTimeout(t);
    this.timers = []; this.pending.clear();
  }

  // ------------------------------------------------------------- controls
  toggleWait(): boolean {
    const on = this.root.state !== 'waiting';
    this.setState(this.root, on ? 'waiting' : 'working');
    return on;
  }
  addWorker(): void {
    const leads = this.leads(true);
    if (leads.length) this.spawn(pick(leads), 'worker');
  }
  addTeam(): void {
    const leads = this.leads(false).filter((m) => m.depth < 3);
    if (leads.length) this.spawnTeam(pick(leads));
  }

  // ---------------------------------------------------------------- model
  private make(parent: SimAgent | null, name: string, kind?: string): SimAgent {
    const id = parent ? `${this.sessionId}:a${++this.n}` : this.sessionId;
    const a: SimAgent = { id, parentId: parent?.id ?? null, name, kind, state: 'working', born: performance.now(), startedAt: new Date().toISOString(), kids: 0, depth: parent ? parent.depth + 1 : 0, busy: false };
    if (parent) parent.kids++;
    this.agents.set(id, a);
    return a;
  }
  private worker(parent: SimAgent): SimAgent {
    const kind = pick(KINDS);
    return this.make(parent, `${kind} ${this.n + 1}`, kind);
  }
  private team(parent: SimAgent): SimAgent {
    return this.make(parent, GREEK[this.teamNo++ % GREEK.length]);
  }
  private build(): void {
    const r = this.root, w = (p: SimAgent, k: number) => { for (let i = 0; i < k; i++) this.worker(p); };
    switch (this.preset) {
      case 'solo': case 'story': w(r, 1); break;
      case 'team': w(r, 4); break;
      case 'departments':
        w(r, 2);
        for (let i = 0; i < 3; i++) {
          const m = this.team(r); w(m, 3 + i);
          if (i === 1) { const s = this.team(m); w(s, 3); }
        }
        break;
      case 'swarm':
        w(r, 2);
        for (let i = 0; i < 5; i++) {
          const m = this.team(r); w(m, 4 + (i % 3));
          if (i % 2 === 0) {
            const s = this.team(m); w(s, 4);
            if (i === 0) { const t = this.team(s); w(t, 3); }
          }
        }
        break;
    }
  }
  private get alive(): SimAgent[] { return [...this.agents.values()].filter((a) => a.state !== 'done'); }
  /** Agents that can take another subagent (the root and anyone with a team). */
  private leads(workersOnly: boolean): SimAgent[] {
    const cap = (a: SimAgent) => (a === this.root ? (this.preset === 'solo' ? 3 : 4) : 8);
    return this.alive.filter((a) => (a === this.root || a.kids > 0) && (!workersOnly || a.kids < cap(a)));
  }

  // ------------------------------------------------------------ messages
  private send(m: ServerMessage): void { if (!this.stopped) this.emit(m); }
  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.pending.delete(t); fn(); }, ms);
    this.pending.add(t);
  }
  private setState(a: SimAgent, state: AgentState): void {
    a.state = state;
    this.send({ kind: 'agent', agent: info(a), ts: new Date().toISOString() });
  }
  private spawn(parent: SimAgent, role: 'worker' | 'team'): SimAgent {
    const a = role === 'team' ? this.team(parent) : this.worker(parent);
    this.send({ kind: 'agent', agent: info(a), ts: new Date().toISOString() });
    return a;
  }
  private spawnTeam(lead: SimAgent): void {
    const m = this.spawn(lead, 'team');
    this.later(2500, () => { if (m.state !== 'done') for (let i = 0; i < 2; i++) this.spawn(m, 'worker'); });
  }
  private finish(a: SimAgent): void {
    a.state = 'done';
    const parent = a.parentId ? this.agents.get(a.parentId) : undefined;
    if (parent) parent.kids--;
    this.send({ kind: 'agent', agent: info(a), ts: new Date().toISOString() });
    this.agents.delete(a.id);
  }
  private event(a: SimAgent, type: 'research' | 'code' | 'bug'): void {
    this.send({ kind: 'event', event: { type, tool: type === 'research' ? 'Read' : type === 'code' ? 'Edit' : 'Bash', agentId: a.id, sessionId: this.sessionId, ts: new Date().toISOString(), harness: 'claude-code' } });
  }
  private activity(a: SimAgent, activity: ActivityKind, op: 'start' | 'end', ok?: boolean): void {
    this.send({ kind: 'activity', agentId: a.id, activity, op, ...(ok === undefined ? {} : { ok }), ts: new Date().toISOString() });
  }

  // ------------------------------------------------------------ behaviour
  private ready(a: SimAgent): boolean { return a.state === 'working' && performance.now() - a.born > 4500; }
  private simulate(): void {
    const story = this.preset === 'story';
    const max = 70, teams = this.preset !== 'solo';
    this.timers.push(setInterval(() => {
      const busy = this.alive.filter((a) => this.ready(a) && (a.kids === 0 && a !== this.root ? true : Math.random() < 0.2));
      if (!busy.length) return;
      const r = Math.random();
      this.event(pick(busy), r < 0.4 ? 'research' : r < 0.92 ? 'code' : 'bug');
    }, 260));
    this.timers.push(setInterval(() => {
      if (this.agents.size >= max) return;
      const leads = this.leads(true);
      if (!leads.length) return;
      const lead = pick(leads);
      if (teams && Math.random() < (story ? 0.24 : 0.18) && lead.depth < 3) this.spawnTeam(lead);
      else this.spawn(lead, 'worker');
    }, (story ? 2.6 : 3.2) * 1000));
    this.timers.push(setInterval(() => {
      const done = this.alive.filter((a) => a !== this.root && a.kids === 0 && this.ready(a) && performance.now() - a.born > 12000 && !a.busy);
      if (done.length && this.agents.size > (story ? 6 : 3)) this.finish(pick(done));
    }, 4200));
    this.timers.push(setInterval(() => {
      const able = this.alive.filter((a) => this.ready(a) && !a.busy && (a !== this.root || Math.random() < 0.3));
      if (!able.length) return;
      const a = pick(able), r = Math.random();
      const kind: ActivityKind = r < 0.25 ? 'plan' : r < 0.55 ? 'web' : r < 0.85 ? 'run' : 'wait';
      const secs = 4 + Math.random() * 5;
      a.busy = true;
      this.activity(a, kind, 'start');
      // Real work happens while away from the desk: research while browsing.
      if (kind === 'web') for (let t = 1.2; t < secs; t += 1.4) this.later(t * 1000, () => this.event(a, 'research'));
      this.later(secs * 1000, () => {
        a.busy = false;
        if (a.state === 'done') return;
        if (kind === 'run') {
          const ok = Math.random() >= 0.25;
          this.activity(a, kind, 'end', ok);
          this.event(a, ok ? 'code' : 'bug');
        } else this.activity(a, kind, 'end');
      });
    }, 3500));
  }
}

function info(a: SimAgent): AgentInfo {
  return { id: a.id, parentId: a.parentId, name: a.name, kind: a.kind, state: a.state, startedAt: a.startedAt };
}
