// End to end: the official OpenTelemetry JS SDK plays the part of a harness
// and exports real OTLP to our receivers over every supported transport.
import { SpanStatusCode } from '@opentelemetry/api';
import { OTLPLogExporter as HttpJsonLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as ProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as ProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { BasicTracerProvider, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOtlpGrpc, startOtlpHttp, type OtlpServer } from '../src/daemon/otlp.js';
import type { Signal, VisEvent } from '../src/shared/events.js';

let received: VisEvent[] = [];
let httpSrv: OtlpServer;
let grpcSrv: OtlpServer;
const HTTP = 44318;
const GRPC = 44317;

beforeAll(async () => {
  // The receivers hand the hub signals; these tests look at the counted events.
  const keep = (sigs: Signal[]) => received.push(...sigs.flatMap((s) => (s.kind === 'event' ? [s.event] : [])));
  httpSrv = await startOtlpHttp(HTTP, keep);
  grpcSrv = await startOtlpGrpc(GRPC, keep);
});
afterAll(async () => {
  await httpSrv.close();
  await grpcSrv.close();
});

async function viaLogs(exporter: LogRecordExporter, service: string, attributes: Record<string, string | number | boolean>, eventName: string) {
  received = [];
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': service }),
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  provider.getLogger('test').emit({ eventName, attributes: { 'event.name': eventName, ...attributes } });
  await provider.forceFlush();
  await provider.shutdown();
  return received;
}

async function viaSpans(exporter: SpanExporter) {
  received = [];
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'some-new-agent' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');
  const turn = tracer.startSpan('invoke_agent Coder', { attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'conv-7' } });
  const tool = tracer.startSpan('execute_tool run_tests', {
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'run_tests', 'gen_ai.tool.call.id': 'call-3', 'gen_ai.conversation.id': 'conv-7' },
  });
  tool.setStatus({ code: SpanStatusCode.ERROR });
  tool.setAttribute('error.type', 'exit_code_1');
  tool.end();
  turn.end();
  await provider.forceFlush();
  await provider.shutdown();
  return received;
}

describe('OTLP receivers with real SDK exporters', () => {
  it('HTTP/protobuf logs: Claude Code tool_result', async () => {
    const evs = await viaLogs(
      new ProtoLogExporter({ url: `http://127.0.0.1:${HTTP}/v1/logs` }),
      'claude-code',
      { 'session.id': 'cc-1', tool_name: 'Grep', tool_use_id: 'toolu_1', success: 'true' },
      'claude_code.tool_result',
    );
    expect(evs).toMatchObject([{ type: 'research', tool: 'Grep', sessionId: 'cc-1', harness: 'claude-code', callId: 'toolu_1' }]);
  });

  it('HTTP/JSON logs: Codex tool_result failure', async () => {
    const evs = await viaLogs(
      new HttpJsonLogExporter({ url: `http://127.0.0.1:${HTTP}/v1/logs` }),
      'codex_cli_rs',
      { 'conversation.id': 'cx-1', tool_name: 'apply_patch', call_id: 'c-1', success: 'false' },
      'codex.tool_result',
    );
    expect(evs.map((e) => [e.type, e.tool, e.harness, e.sessionId])).toEqual([
      ['code', 'apply_patch', 'codex', 'cx-1'],
      ['bug', 'apply_patch', 'codex', 'cx-1'],
    ]);
  });

  it('gRPC traces: GenAI semconv execute_tool + invoke_agent', async () => {
    const evs = await viaSpans(new GrpcTraceExporter({ url: `http://127.0.0.1:${GRPC}` }));
    expect(evs.map((e) => [e.type, e.tool, e.sessionId])).toEqual([
      ['code', 'run_tests', 'conv-7'],
      ['bug', 'run_tests', 'conv-7'],
      ['idle', undefined, 'conv-7'],
    ]);
  });

  it('HTTP/protobuf traces decode identically', async () => {
    const evs = await viaSpans(new ProtoTraceExporter({ url: `http://127.0.0.1:${HTTP}/v1/traces` }));
    expect(evs.map((e) => e.type)).toEqual(['code', 'bug', 'idle']);
  });
});
