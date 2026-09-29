// OTLP → VisEvent. Works for any agent that speaks OpenTelemetry:
//
//  * GenAI semantic conventions (semantic-conventions-genai, semconv v1.44):
//    `execute_tool {gen_ai.tool.name}` spans and `invoke_agent` spans.
//  * Vendor tool events that predate/sit beside the GenAI conventions:
//    claude_code.tool_result, codex.tool_result, gemini_cli.tool_call logs,
//    and Claude Code's beta `claude_code.tool` / `claude_code.interaction` spans.
//
// Input is the OTLP/JSON object model (ExportLogsServiceRequest /
// ExportTraceServiceRequest). The protobuf decoder produces the same shape.

import { classifyTool, type VisEvent } from './events.js';

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

function sessionOf(a: Attrs, fallback?: string): string {
  return (
    first(a, 'gen_ai.conversation.id', 'session.id', 'conversation.id', 'thread.id', 'thread_id', 'session_id') ??
    fallback ??
    'otel'
  );
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

const TOOL_LOG = /(^|\.)(tool_result|tool_call)$/;

export function logToEvents(rec: LogRecord, resource: Attrs): VisEvent[] {
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
  return toolEvents(tool, failed(a), base, startTs, ts);
}

export function spanToEvents(span: Span, resource: Attrs): VisEvent[] {
  const a = { ...resource, ...attrs(span.attributes) };
  const name = span.name ?? '';
  const op = str(a['gen_ai.operation.name']);
  const start = nanosToIso(span.startTimeUnixNano) ?? new Date().toISOString();
  const end = nanosToIso(span.endTimeUnixNano) ?? start;
  const base = {
    sessionId: sessionOf(a, span.traceId),
    harness: harnessName(str(a['service.name'])),
  };

  if (op === 'execute_tool' || name.startsWith('execute_tool') || name === 'claude_code.tool') {
    const tool = first(a, 'gen_ai.tool.name', 'tool_name', 'tool.name') ?? (name.replace(/^execute_tool\s*/, '') || undefined);
    const callId = first(a, 'gen_ai.tool.call.id', 'tool_use_id', 'call_id');
    // Claude Code reports failure on the child execution span instead.
    const err = name === 'claude_code.tool' ? false : failed(a, span.status?.code);
    return toolEvents(tool, err, { ...base, callId }, start, end);
  }
  if (name === 'claude_code.tool.execution') {
    return failed(a, span.status?.code) ? [{ ...base, type: 'bug', ts: end }] : [];
  }

  // A finished top-level agent turn means the agent is waiting for input.
  const turn = op === 'invoke_agent' || name.startsWith('invoke_agent') || name === 'claude_code.interaction';
  if (turn && !span.parentSpanId) return [{ ...base, type: 'idle', ts: end }];
  return [];
}

/** All events in one OTLP export, oldest first. */
export function otlpToEvents(req: OtlpRequest): VisEvent[] {
  const out: VisEvent[] = [];
  for (const rl of req.resourceLogs ?? []) {
    const res = attrs(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) for (const rec of sl.logRecords ?? []) out.push(...logToEvents(rec, res));
  }
  for (const rs of req.resourceSpans ?? []) {
    const res = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) for (const span of ss.spans ?? []) out.push(...spanToEvents(span, res));
  }
  return out.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
}

export function isOtlpRequest(obj: unknown): boolean {
  const o = obj as OtlpRequest;
  return !!o && (Array.isArray(o.resourceLogs) || Array.isArray(o.resourceSpans));
}

// ------------------------------------------------------------- recording

const kv = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
const nanos = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
const hexId = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Serialise events as a standard OTLP/JSON trace export using the GenAI
 * conventions: tool calls become `execute_tool` spans (status ERROR when they
 * failed) and each agent turn an `invoke_agent` span. The file is valid input
 * for any OTLP backend and round-trips through `otlpToEvents`.
 */
export function eventsToOtlp(events: VisEvent[], startedAt: string): OtlpRequest {
  const sessionId = events[0]?.sessionId ?? 'recording';
  const traceId = hexId(16);
  const spans: Span[] = [];
  const byCall = new Map<string, Span>();
  let turnStart = startedAt;

  for (const ev of events) {
    if (ev.type === 'idle') {
      spans.push({
        traceId,
        spanId: hexId(8),
        name: 'invoke_agent',
        startTimeUnixNano: nanos(turnStart),
        endTimeUnixNano: nanos(ev.ts),
        attributes: [kv('gen_ai.operation.name', 'invoke_agent'), kv('gen_ai.conversation.id', ev.sessionId)],
      });
      turnStart = ev.ts;
      continue;
    }
    const existing = ev.callId ? byCall.get(ev.callId) : undefined;
    if (ev.type === 'bug' && existing) {
      existing.endTimeUnixNano = nanos(ev.ts);
      existing.status = { code: 2 };
      existing.attributes!.push(kv('error.type', 'tool_error'));
      continue;
    }
    const tool = ev.tool ?? 'unknown';
    const span: Span = {
      traceId,
      spanId: hexId(8),
      name: `execute_tool ${tool}`,
      startTimeUnixNano: nanos(ev.ts),
      endTimeUnixNano: nanos(ev.ts),
      attributes: [kv('gen_ai.operation.name', 'execute_tool'), kv('gen_ai.tool.name', tool), kv('gen_ai.conversation.id', ev.sessionId)],
    };
    if (ev.callId) {
      span.attributes!.push(kv('gen_ai.tool.call.id', ev.callId));
      byCall.set(ev.callId, span);
    }
    if (ev.type === 'bug') {
      span.status = { code: 2 };
      span.attributes!.push(kv('error.type', 'tool_error'));
    }
    spans.push(span);
  }

  const harness = events.find((e) => e.harness)?.harness ?? 'unknown';
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', harness), kv('session.id', sessionId), kv('session.start', startedAt)] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}
