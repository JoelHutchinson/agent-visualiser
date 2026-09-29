import { emptyCounts, tally } from './events.js';
import { rootAgentId, type ActivityKind, type AgentInfo, type Counts, type ServerMessage } from './protocol.js';

type SessionMessage = Extract<ServerMessage, { kind: 'session' }>;

/**
 * The state a front end would rebuild from the v2 message stream: the agent
 * tree, activities in progress and counts. The hub keeps one per session and
 * the replay player one for the recording, so both can send a `session`
 * snapshot to a client that connects mid-stream by replaying their own
 * messages into it.
 */
export class SessionModel {
  readonly counts: Counts = emptyCounts();
  /** Alive agents only (state !== 'done'). Always contains the root. */
  readonly agents = new Map<string, AgentInfo>();
  readonly activities = new Map<string, { agentId: string; activity: ActivityKind; since: string }>();

  constructor(
    readonly sessionId: string,
    public startedAt: string,
    public harness?: string,
  ) {
    this.agents.set(rootAgentId(sessionId), { id: rootAgentId(sessionId), parentId: null, name: 'Orchestrator', state: 'waiting', startedAt });
  }

  get root(): AgentInfo {
    return this.agents.get(rootAgentId(this.sessionId))!;
  }

  apply(msg: ServerMessage): void {
    if (msg.kind === 'agent') {
      if (msg.agent.state === 'done') {
        this.agents.delete(msg.agent.id);
        for (const [k, a] of this.activities) if (a.agentId === msg.agent.id) this.activities.delete(k);
      } else this.agents.set(msg.agent.id, msg.agent);
    } else if (msg.kind === 'activity') {
      const key = `${msg.agentId}:${msg.activity}`;
      if (msg.op === 'start') this.activities.set(key, { agentId: msg.agentId, activity: msg.activity, since: msg.ts });
      else this.activities.delete(key);
    } else if (msg.kind === 'event') {
      tally(this.counts, msg.event);
    }
  }

  snapshot(extra: { rate: number; source: SessionMessage['source'] }): SessionMessage {
    return {
      kind: 'session',
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      harness: this.harness,
      source: extra.source,
      rate: extra.rate,
      counts: { ...this.counts },
      agents: this.ordered(),
      activities: [...this.activities.values()].map((a) => ({ ...a })),
    };
  }

  /** Root first, parents before children; agents whose parent is gone hang off the root. */
  private ordered(): AgentInfo[] {
    const rootId = rootAgentId(this.sessionId);
    const kids = new Map<string, AgentInfo[]>();
    for (const a of this.agents.values()) {
      if (a.id === rootId) continue;
      const p = a.parentId && this.agents.has(a.parentId) && a.parentId !== a.id ? a.parentId : rootId;
      (kids.get(p) ?? kids.set(p, []).get(p)!).push(a);
    }
    const out: AgentInfo[] = [];
    const seen = new Set<string>();
    const walk = (a: AgentInfo) => {
      if (seen.has(a.id)) return;
      seen.add(a.id);
      out.push(a);
      for (const c of kids.get(a.id) ?? []) walk(c);
    };
    walk(this.root);
    return out;
  }
}
