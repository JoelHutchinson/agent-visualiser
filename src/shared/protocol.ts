// Wire protocol v2: daemon (or in-browser replay/simulator) -> front end.
//
// This file is the contract between src/ (daemon) and web/ (front end).
// Both sides import these types; change them only deliberately and in both.
//
// Model: a session is a tree of agents. The root agent is the one the user
// talks to (the orchestrator). Subagents are spawned by an agent (Claude Code
// `Agent`/`Task` tool, OTel nested `invoke_agent` spans, ...). An agent that
// has spawned subagents is shown as a manager; a leaf is a worker. The front
// end derives roles from the tree; the daemon only reports parentage.
//
// Privacy: only ids, names, tool names, kinds and timestamps. Never prompts,
// file contents, commands or tool output.

/** The four counted event types (unchanged from v1). */
export type EventType = 'research' | 'code' | 'bug' | 'idle';

/**
 * Away-from-desk work the office visualises in dedicated rooms:
 *  plan: planning (TodoWrite, update_plan, Plan subagents, plan mode)
 *  web:  web research (WebSearch, WebFetch, web_search, ...)
 *  run:  a long-running command (Bash/PowerShell/exec that has not returned after ~1.5s)
 *  wait: blocked on the user (permission prompt / question), per agent
 */
export type ActivityKind = 'plan' | 'web' | 'run' | 'wait';

export type AgentState = 'working' | 'waiting' | 'done';

export interface AgentInfo {
  /** Stable id within the session. The root agent's id is the session id. */
  id: string;
  /** null for the root agent. */
  parentId: string | null;
  /** Short display name: "Orchestrator", a subagent description, or an OTel agent name. */
  name: string;
  /** Subagent type if known ("Explore", "Plan", "general-purpose", "code-reviewer", ...). */
  kind?: string;
  state: AgentState;
  /** ISO time the agent started. */
  startedAt: string;
}

export interface Counts {
  research: number;
  code: number;
  bug: number;
}

/** A counted event, attributed to the agent that produced it. */
export interface AgentEvent {
  type: EventType;
  tool?: string;
  /** Which agent did it; defaults to the root agent if omitted. */
  agentId?: string;
  sessionId: string;
  ts: string;
  harness?: string;
}

export type ServerMessage =
  /** No session yet (daemon started, nothing seen). */
  | { kind: 'waiting' }
  /**
   * Full state of the displayed session. Sent on connect, when the displayed
   * session changes, and whenever the receiver should resync (it replaces all
   * previous state).
   */
  | {
      kind: 'session';
      sessionId: string;
      startedAt: string;
      harness?: string;
      source: 'live' | 'replay' | 'demo';
      /** Replay speed multiplier; 1 for live. */
      rate: number;
      /** Totals per type across the whole session so far. */
      counts: Counts;
      /** Every agent that is still alive (state !== 'done'), root first, parents before children. */
      agents: AgentInfo[];
      /** Activities currently in progress. */
      activities: { agentId: string; activity: ActivityKind; since: string }[];
    }
  /** An agent appeared, or its state changed, or it finished (state 'done'). */
  | { kind: 'agent'; agent: AgentInfo; ts: string }
  /** An activity started or ended for an agent. `ok` is set on 'end' for 'run'. */
  | { kind: 'activity'; agentId: string; activity: ActivityKind; op: 'start' | 'end'; ok?: boolean; ts: string }
  /** A counted event. */
  | { kind: 'event'; event: AgentEvent }
  /** A replay reached its end. */
  | { kind: 'ended' };

/** Root agent id for a session (by convention equal to the session id). */
export const rootAgentId = (sessionId: string) => sessionId;
