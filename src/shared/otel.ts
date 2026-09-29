// OTLP → Signals (events, agent hierarchy, tool calls). Works for any agent that speaks OpenTelemetry:
//
//  * GenAI semantic conventions (semantic-conventions-genai, semconv v1.44):
//    `execute_tool {gen_ai.tool.name}` spans and `invoke_agent` spans.
//  * Vendor tool events that predate/sit beside the GenAI conventions:
//    claude_code.tool_result, codex.tool_result, gemini_cli.tool_call logs,
//    and Claude Code's beta `claude_code.tool` / `claude_code.interaction` spans.
//
// Input is the OTLP/JSON object model (ExportLogsServiceRequest /
// ExportTraceServiceRequest). The protobuf decoder produces the same shape.

import { activityOf } from './activity.js';
import { classifyTool, type Signal, type VisEvent } from './events.js';
import { rootAgentId } from './protocol.js';

export interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
}
export interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface Resource {
  attributes?: KeyValue[];
}
export interface LogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  eventName?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  traceId?: string;
}
export interface Span {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  /** JSON encodes the enum as a number or as "STATUS_CODE_ERROR". */
  status?: { code?: number | string; message?: string };
}
export interface OtlpRequest {
  resourceLogs?: { resource?: Resource; scopeLogs?: { logRecords?: LogRecord[] }[] }[];
  resourceSpans?: { resource?: Resource; scopeSpans?: { spans?: Span[] }[] }[];
}

type Attrs = Record<string, unknown>;

export function anyValue(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  return undefined;
}

export function attrs(list: KeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of list ?? []) if (kv && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value);
  return out;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
const first = (a: Attrs, ...keys: string[]) => keys.map((k) => str(a[k])).find((v) => v !== undefined);

function nanosToIso(n: string | number | undefined): string | undefined {
  if (n === undefined || n === '' || n === '0' || n === 0) return undefined;
  try {
    const ms = Number(BigInt(n) / 1_000_000n);
    return ms > 0 ? new Date(ms).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/** service.name → a short, stable harness id. */
export function harnessName(serviceName: string | undefined): string | undefined {
  if (!serviceName) return undefined;
  const s = serviceName.toLowerCase();
  if (s.includes('claude')) return 'claude-code';
  if (s.includes('codex')) return 'codex';
  if (s.includes('gemini')) return 'gemini-cli';
  if (s.includes('opencode')) return 'opencode';
  if (s.includes('copilot')) return 'copilot';
  return serviceName;
}

const explicitSession = (a: Attrs) => first(a, 'gen_ai.conversation.id', 'session.id', 'conversation.id', 'thread.id', 'thread_id', 'session_id');

function sessionOf(a: Attrs, fallback?: string): string {
  return explicitSession(a) ?? fallback ?? 'otel';
}

function failed(a: Attrs, statusCode?: number | string): boolean {
  if (statusCode === 2 || statusCode === 'STATUS_CODE_ERROR') return true;
  const success = a['success'];
  if (success === false || success === 'false') return true;
  return first(a, 'error.type', 'error_type') !== undefined;
}

/** Tool call → its category bubble, plus a bug bubble if it failed. */
function toolEvents(tool: string | undefined, err: boolean, base: Omit<VisEvent, 'type' | 'ts'>, startTs: string, endTs: string): VisEvent[] {
  const out: VisEvent[] = [];
  const type = classifyTool(tool);
  if (type) out.push({ ...base, type, tool, ts: startTs });
  if (err) out.push({ ...base, type: 'bug', tool, ts: endTs });
  return out;
}

const asEvents = (evs: VisEvent[]): Signal[] => evs.map((event) => ({ kind: 'event', event }));

/**
 * A finished tool call as signals: its events, plus one 'end' carrying the
 * duration (OTel reports calls at completion, so the hub cannot time them
 * live). Only tools the scene can show are forwarded.
 */
function toolSignals(tool: string | undefined, err: boolean, base: Omit<VisEvent, 'type' | 'ts'>, startTs: string, endTs: string): Signal[] {
  const out = asEvents(toolEvents(tool, err, base, startTs, endTs));
  if (tool && (classifyTool(tool) || activityOf(tool))) {
    out.push({
      kind: 'tool',
      sessionId: base.sessionId,
      agentId: base.agentId ?? rootAgentId(base.sessionId),
      tool,
      callId: base.callId,
      op: 'end',
      ok: !err,
      durationMs: Math.max(0, Date.parse(endTs) - Date.parse(startTs)),
      ts: endTs,
    });
  }
  return out;
}

const TOOL_LOG = /(^|\.)(tool_result|tool_call)$/;

/** Harness-specific tool logs (claude_code.tool_result, codex.tool_result, gemini_cli.tool_call). Always the root agent. */
export function logToSignals(rec: LogRecord, resource: Attrs): Signal[] {
  const a = { ...resource, ...attrs(rec.attributes) };
  const name = rec.eventName || first(a, 'event.name') || (typeof anyValue(rec.body) === 'string' ? (anyValue(rec.body) as string) : '');
  if (!TOOL_LOG.test(name)) return [];

  const ts = nanosToIso(rec.timeUnixNano) ?? nanosToIso(rec.observedTimeUnixNano) ?? str(a['event.timestamp']) ?? new Date().toISOString();
  // Claude Code only puts decision_type=accept on results that actually ran;
  // Gemini's tool_call carries rejects too, which are not work done.
  if (a['decision'] === 'reject') return [];
  const tool = first(a, 'gen_ai.tool.name', 'tool_name', 'function_name', 'tool.name');
  const base = {
    sessionId: sessionOf(a, rec.traceId),
    harness: harnessName(str(a['service.name'])),
    callId: first(a, 'gen_ai.tool.call.id', 'tool_use_id', 'call_id', 'tool_call_id'),
  };
  const durationMs = Number(a['duration_ms']);
  const startTs = Number.isFinite(durationMs) && durationMs > 0 ? new Date(Date.parse(ts) - durationMs).toISOString() : ts;
  return toolSignals(tool, failed(a), base, startTs, ts);
}

/** Where a span sits: which session it belongs to and which agent encloses it. */
interface SpanInfo {
  sessionId: string;
  agentId?: string;
}

type SpanLookup = (spanId: string | undefined) => SpanInfo | undefined;

const MAX_SPANS = 5000;
const AGENT_KIND_KEYS = ['agent_visualiser.agent.kind', 'gen_ai.agent.kind', 'gen_ai.agent.type'];
/** Recordings mark agent spans that were still open when the recording ended. */
export const IN_PROGRESS = 'agent_visualiser.in_progress';
export const AGENT_KIND_KEY = AGENT_KIND_KEYS[0];

const isAgentSpan = (op: string | undefined, name: string) => op === 'invoke_agent' || name.startsWith('invoke_agent') || name === 'claude_code.interaction';

/**
 * Turns OTLP exports into Signals. Stateful because a trace is exported in
 * pieces: it remembers which agent each recent span belonged to, so a tool
 * span in one export can be attributed through its parent chain to an
 * `invoke_agent` span seen earlier. Spans in the same export are resolved
 * together (children usually finish, and are exported, before their parents).
 *
 * Hierarchy (GenAI semconv `invoke_agent`): a top-level invoke_agent span is
 * one turn of the root agent (the session's orchestrator); its end means the
 * user's move. An invoke_agent nested under another agent's span is a
 * subagent: id = gen_ai.agent.id (else the span id), name = gen_ai.agent.name,
 * parent = the enclosing agent. Spans only export once they end, so a live
 * subagent appears and finishes in the same export; start and end timestamps
 * are still the real ones. `execute_tool` spans go to the nearest enclosing
 * agent; tools whose parent span is unknown (exported in an earlier batch and
 * evicted, or never exported) go to the root, as do all vendor logs.
 */
export class OtelMapper {
  private spans = new Map<string, SpanInfo>();

  map(req: OtlpRequest): Signal[] {
    const out: Signal[] = [];
    for (const rl of req.resourceLogs ?? []) {
      const res = attrs(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) for (const rec of sl.logRecords ?? []) out.push(...logToSignals(rec, res));
    }

    const batch = new Map<string, { span: Span; a: Attrs }>();
    const all: { span: Span; a: Attrs }[] = [];
    for (const rs of req.resourceSpans ?? []) {
      const res = attrs(rs.resource?.attributes);
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          const entry = { span, a: { ...res, ...attrs(span.attributes) } };
          all.push(entry);
          if (span.spanId) batch.set(span.spanId, entry);
        }
      }
    }
    const resolving = new Set<string>();
    const info: SpanLookup = (spanId) => {
      if (!spanId) return undefined;
      const known = this.spans.get(spanId);
      if (known) return known;
      const entry = batch.get(spanId);
      if (!entry || resolving.has(spanId)) return undefined;
      resolving.add(spanId);
      const i = this.resolve(entry.span, entry.a, info);
      resolving.delete(spanId);
      this.remember(spanId, i);
      return i;
    };
    for (const { span, a } of all) {
      const i = info(span.spanId) ?? this.resolve(span, a, info);
      out.push(...this.signals(span, a, i, info));
    }
    return out
      .map((s, n) => ({ s, n }))
      .sort((x, y) => Date.parse(signalTime(x.s)) - Date.parse(signalTime(y.s)) || rank(x.s) - rank(y.s) || x.n - y.n)
      .map((x) => x.s);
  }

  private resolve(span: Span, a: Attrs, info: SpanLookup): SpanInfo {
    const parent = info(span.parentSpanId || undefined);
    const sessionId = explicitSession(a) ?? parent?.sessionId ?? span.traceId ?? 'otel';
    const op = str(a['gen_ai.operation.name']);
    if (!isAgentSpan(op, span.name ?? '')) return { sessionId, agentId: parent?.agentId };
    if (parent?.agentId || (span.parentSpanId && !parent)) {
      // Nested: a subagent (an unknown parent is assumed to be the orchestrator's turn).
      return { sessionId, agentId: first(a, 'gen_ai.agent.id') ?? span.spanId ?? `${sessionId}:${span.name}` };
    }
    return { sessionId, agentId: rootAgentId(sessionId) };
  }

  private remember(spanId: string, i: SpanInfo): void {
    this.spans.set(spanId, i);
    if (this.spans.size > MAX_SPANS) this.spans.delete(this.spans.keys().next().value!);
  }

  private signals(span: Span, a: Attrs, i: SpanInfo, info: SpanLookup): Signal[] {
    if (span.spanId) this.remember(span.spanId, i);
    const name = span.name ?? '';
    const op = str(a['gen_ai.operation.name']);
    const start = nanosToIso(span.startTimeUnixNano) ?? new Date().toISOString();
    const end = nanosToIso(span.endTimeUnixNano) ?? start;
    const harness = harnessName(str(a['service.name']));
    const base = { sessionId: i.sessionId, harness, agentId: i.agentId };

    if (op === 'execute_tool' || name.startsWith('execute_tool') || name === 'claude_code.tool') {
      const tool = first(a, 'gen_ai.tool.name', 'tool_name', 'tool.name') ?? (name.replace(/^execute_tool\s*/, '') || undefined);
      const callId = first(a, 'gen_ai.tool.call.id', 'tool_use_id', 'call_id');
      // Claude Code reports failure on the child execution span instead.
      const err = name === 'claude_code.tool' ? false : failed(a, span.status?.code);
      return toolSignals(tool, err, { ...base, callId }, start, end);
    }
    if (name === 'claude_code.tool.execution') {
      return failed(a, span.status?.code) ? asEvents([{ ...base, type: 'bug', ts: end }]) : [];
    }
    if (!isAgentSpan(op, name)) return [];

    const inProgress = a[IN_PROGRESS] === 'true' || a[IN_PROGRESS] === true;
    const rootId = rootAgentId(i.sessionId);
    if (i.agentId === rootId) {
      // A finished top-level agent turn means the agent is waiting for input.
      const out: Signal[] = [];
      const agentName = first(a, 'gen_ai.agent.name');
      if (agentName) out.push({ kind: 'agent', sessionId: i.sessionId, agent: { id: rootId, parentId: null, name: agentName, state: 'working', startedAt: start }, ts: start });
      if (!inProgress) out.push(...asEvents([{ ...base, agentId: undefined, type: 'idle', ts: end }]));
      return out;
    }

    const parent = info(span.parentSpanId || undefined);
    const agent = {
      id: i.agentId!,
      parentId: parent?.agentId ?? rootId,
      name: (first(a, 'gen_ai.agent.name') ?? name.replace(/^invoke_agent\s*/, '')) || 'Agent',
      kind: first(a, ...AGENT_KIND_KEYS),
      startedAt: start,
    };
    const out: Signal[] = [{ kind: 'agent', sessionId: i.sessionId, agent: { ...agent, state: 'working' }, ts: start }];
    if (!inProgress) out.push({ kind: 'agent', sessionId: i.sessionId, agent: { ...agent, state: 'done' }, ts: end });
    return out;
  }
}

const signalTime = (s: Signal) => (s.kind === 'event' ? s.event.ts : s.ts);
/** Order within one instant: agents appear before their work, and finish/idle after it. */
const rank = (s: Signal) => (s.kind === 'agent' ? (s.agent.state === 'done' ? 2 : 0) : s.kind === 'event' && s.event.type === 'idle' ? 2 : 1);

/** All signals in one OTLP export, oldest first. Stateless convenience wrapper. */
export function otlpToSignals(req: OtlpRequest): Signal[] {
  return new OtelMapper().map(req);
}

/** Just the counted events of an export (bubbles), oldest first. */
export function otlpToEvents(req: OtlpRequest): VisEvent[] {
  return otlpToSignals(req).flatMap((s) => (s.kind === 'event' ? [s.event] : []));
}

export function isOtlpRequest(obj: unknown): boolean {
  const o = obj as OtlpRequest;
  return !!o && (Array.isArray(o.resourceLogs) || Array.isArray(o.resourceSpans));
}

// ---------------------------------------------------------- serialisation

export const kv = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
export const nanos = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
export const hexId = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
