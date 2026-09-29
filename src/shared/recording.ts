// A recording is a finished session: events, the agent tree and every tool
// call, built from any source's Signals. It serialises to a standard OTLP/JSON
// trace (GenAI conventions) and replays through ReplayPlayer.

import { activityOf } from './activity.js';
import { classifyTool, signalSession, signalTs, type Signal, type VisEvent } from './events.js';
import { AGENT_KIND_KEY, hexId, IN_PROGRESS, kv, nanos, type KeyValue, type OtlpRequest, type Span } from './otel.js';
import { rootAgentId } from './protocol.js';

export interface RecAgent {
  id: string;
  parentId: string | null;
  name: string;
  kind?: string;
  startedAt: string;
  /** Absent if the agent was still running when the recording ended. */
  endedAt?: string;
}

export interface RecTool {
  agentId: string;
  tool: string;
  callId?: string;
  start: string;
  /** Absent if the call never returned. */
  end?: string;
  ok: boolean;
}

export interface Recording {
  sessionId: string;
  startedAt: string;
  /** Counted events plus `idle` (the root's turn ended), oldest first. */
  events: VisEvent[];
  /** Subagents (the root is implicit). */
  agents: RecAgent[];
  /** Tool calls that the scene shows as events or activities. */
  tools: RecTool[];
}

/** Turn a stream of signals into a recording of the busiest session in it. */
export function buildRecording(signals: Signal[], startedAtHint?: string): Recording {
  const sorted = signals
    .map((s, n) => ({ s, n }))
    .sort((x, y) => Date.parse(signalTs(x.s)) - Date.parse(signalTs(y.s)) || x.n - y.n)
    .map((x) => x.s);

  // A file may interleave sessions; replay the busiest one.
  const bySession = new Map<string, number>();
  for (const s of sorted) bySession.set(signalSession(s), (bySession.get(signalSession(s)) ?? 0) + 1);
  const sessionId = [...bySession].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'replay';

  const events: VisEvent[] = [];
  const agents = new Map<string, RecAgent>();
  const tools = new Map<string, RecTool>();
  const anon: RecTool[] = [];
  // The same call can arrive as both an OTLP log and a span; count it once.
  const seen = new Set<string>();
  const root = rootAgentId(sessionId);

  for (const s of sorted) {
    if (signalSession(s) !== sessionId) continue;
    if (s.kind === 'event') {
      const e = s.event;
      if (e.callId && e.type !== 'idle') {
        const key = `${e.type}:${e.callId}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      events.push(e);
    } else if (s.kind === 'agent') {
      const a = s.agent;
      if (a.id === root) continue;
      const rec = agents.get(a.id);
      if (a.state === 'done') {
        if (rec && !rec.endedAt) rec.endedAt = s.ts;
      } else if (!rec) agents.set(a.id, { id: a.id, parentId: a.parentId, name: a.name, kind: a.kind, startedAt: s.ts });
      else {
        // A later signal may know more (name, kind, real parent).
        rec.name = a.name;
        rec.kind = a.kind ?? rec.kind;
        rec.parentId = a.parentId;
      }
    } else {
      if (!classifyTool(s.tool) && !activityOf(s.tool)) continue;
      if (s.op === 'start') {
        if (!s.callId || tools.has(s.callId)) continue;
        tools.set(s.callId, { agentId: s.agentId, tool: s.tool, callId: s.callId, start: s.ts, ok: true });
        continue;
      }
      const open = s.callId ? tools.get(s.callId) : undefined;
      if (open) {
        // Results carry no tool name in some sources; the start has it.
        if (!open.end) {
          open.end = s.ts;
          open.ok = s.ok !== false;
        }
      } else if (!s.callId || !tools.has(s.callId)) {
        const start = new Date(Date.parse(s.ts) - (s.durationMs ?? 0)).toISOString();
        const t: RecTool = { agentId: s.agentId, tool: s.tool, callId: s.callId, start, end: s.ts, ok: s.ok !== false };
        if (s.callId) tools.set(s.callId, t);
        else anon.push(t);
      }
    }
  }

  const firstTs = [events[0]?.ts, ...[...tools.values()].map((t) => t.start), ...[...agents.values()].map((a) => a.startedAt)]
    .filter((t): t is string => !!t)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  let startedAt = startedAtHint;
  if (!startedAt || (firstTs && Date.parse(firstTs) < Date.parse(startedAt))) startedAt = firstTs;
  return {
    sessionId,
    startedAt: startedAt ?? new Date().toISOString(),
    events,
    agents: [...agents.values()],
    tools: [...tools.values(), ...anon].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
  };
}

// ---------------------------------------------------------------- writing

/**
 * Serialise a recording as one OTLP/JSON trace export using the GenAI
 * conventions. The root agent's turns are top-level `invoke_agent` spans,
 * each subagent a nested `invoke_agent` span (gen_ai.agent.id/name, kind in
 * `agent_visualiser.agent.kind`) under the agent that spawned it, and each
 * tool call an `execute_tool` span under its agent. Activities are not
 * stored: they are derived from tool names and durations on read. The file is
 * valid input for any OTLP backend and round-trips through OtelMapper.
 */
export function recordingToOtlp(rec: Recording): OtlpRequest {
  const traceId = hexId(16);
  const root = rootAgentId(rec.sessionId);
  const ms = (iso: string) => Date.parse(iso);

  const lastTs = Math.max(
    ms(rec.startedAt),
    ...rec.events.map((e) => ms(e.ts)),
    ...rec.tools.map((t) => ms(t.end ?? t.start)),
    ...rec.agents.map((a) => ms(a.endedAt ?? a.startedAt)),
  );
  const iso = (t: number) => new Date(t).toISOString();

  // Root turns end at each idle event; whatever follows the last one is an
  // unfinished turn, flagged so it does not read back as an extra idle.
  const idles = rec.events.filter((e) => e.type === 'idle').map((e) => ms(e.ts));
  const turns: { spanId: string; start: number; end: number; open: boolean }[] = [];
  let prev = ms(rec.startedAt);
  for (const t of idles) {
    turns.push({ spanId: hexId(8), start: prev, end: t, open: false });
    prev = t;
  }
  if (lastTs > prev || !turns.length) turns.push({ spanId: hexId(8), start: prev, end: lastTs, open: true });
  const turnAt = (t: number) => (turns.find((x) => t <= x.end) ?? turns[turns.length - 1]).spanId;

  const agentSpan = new Map(rec.agents.map((a) => [a.id, hexId(8)]));
  const parentOf = (agentId: string, at: number) => (agentId === root ? turnAt(at) : (agentSpan.get(agentId) ?? turnAt(at)));
  const ids = (agentId: string, name: string) => [
    kv('gen_ai.operation.name', 'invoke_agent'),
    kv('gen_ai.conversation.id', rec.sessionId),
    kv('gen_ai.agent.id', agentId),
    kv('gen_ai.agent.name', name),
  ];

  const spans: Span[] = [];
  for (const t of turns) {
    spans.push({
      traceId,
      spanId: t.spanId,
      name: 'invoke_agent Orchestrator',
      startTimeUnixNano: nanos(iso(t.start)),
      endTimeUnixNano: nanos(iso(t.end)),
      attributes: [...ids(root, 'Orchestrator'), ...(t.open ? [kv(IN_PROGRESS, 'true')] : [])],
    });
  }
  for (const a of rec.agents) {
    const attributes: KeyValue[] = ids(a.id, a.name);
    if (a.kind) attributes.push(kv(AGENT_KIND_KEY, a.kind));
    if (!a.endedAt) attributes.push(kv(IN_PROGRESS, 'true'));
    spans.push({
      traceId,
      spanId: agentSpan.get(a.id)!,
      parentSpanId: a.parentId && agentSpan.has(a.parentId) ? agentSpan.get(a.parentId) : turnAt(ms(a.startedAt)),
      name: `invoke_agent ${a.name}`,
      startTimeUnixNano: nanos(a.startedAt),
      endTimeUnixNano: nanos(a.endedAt ?? iso(lastTs)),
      attributes,
    });
  }

  const toolSpan = (agentId: string, tool: string, start: string, end: string, ok: boolean, callId?: string): Span => {
    const attributes = [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', tool), kv('gen_ai.conversation.id', rec.sessionId)];
    if (callId) attributes.push(kv('gen_ai.tool.call.id', callId));
    if (!ok) attributes.push(kv('error.type', 'tool_error'));
    return {
      traceId,
      spanId: hexId(8),
      parentSpanId: parentOf(agentId, ms(start)),
      name: `execute_tool ${tool}`,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes,
      ...(ok ? {} : { status: { code: 2 } }),
    };
  };

  const called = new Set<string>();
  for (const t of rec.tools) {
    if (t.callId) called.add(t.callId);
    spans.push(toolSpan(t.agentId, t.tool, t.start, t.end ?? t.start, t.ok, t.callId));
  }
  // Events with no recorded call (bare event logs) still become spans.
  for (const e of rec.events) {
    if (e.type === 'idle' || (e.callId && called.has(e.callId))) continue;
    spans.push(toolSpan(e.agentId ?? root, e.tool ?? 'unknown', e.ts, e.ts, e.type !== 'bug', e.callId));
  }

  const harness = rec.events.find((e) => e.harness)?.harness ?? 'unknown';
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', harness), kv('session.id', rec.sessionId), kv('session.start', rec.startedAt)] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}
