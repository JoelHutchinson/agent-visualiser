import { describe, expect, it } from 'vitest';
import { otlpToEvents, type KeyValue, type OtlpRequest } from '../src/shared/otel.js';
import { parseRecording, toOtlpRecording } from '../src/shared/replay.js';

const kv = (o: Record<string, string | number | boolean>): KeyValue[] =>
  Object.entries(o).map(([key, v]) => ({
    key,
    value: typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : { intValue: String(v) },
  }));
const T = '1790676000000000000'; // 2026-09-29T10:00:00Z in ns
const T_ISO = '2026-09-29T10:00:00.000Z';

const logs = (service: string, attributes: Record<string, string | number | boolean>, eventName?: string): OtlpRequest => ({
  resourceLogs: [{ resource: { attributes: kv({ 'service.name': service }) }, scopeLogs: [{ logRecords: [{ timeUnixNano: T, eventName, attributes: kv(attributes) }] }] }],
});
const spans = (s: object[]): OtlpRequest => ({ resourceSpans: [{ resource: { attributes: kv({ 'service.name': 'my-agent' }) }, scopeSpans: [{ spans: s }] }] });

describe('vendor tool events', () => {
  it('Claude Code claude_code.tool_result', () => {
    const evs = otlpToEvents(
      logs('claude-code', { 'event.name': 'tool_result', 'session.id': 'cc-1', tool_name: 'Read', tool_use_id: 'toolu_9', success: 'true', duration_ms: 20 }, 'claude_code.tool_result'),
    );
    expect(evs).toEqual([{ type: 'research', tool: 'Read', sessionId: 'cc-1', harness: 'claude-code', callId: 'toolu_9', ts: '2026-09-29T09:59:59.980Z' }]);
  });

  it('Claude Code failed tool gives a code bubble and a bug', () => {
    const evs = otlpToEvents(logs('claude-code', { 'event.name': 'tool_result', 'session.id': 'cc-1', tool_name: 'Bash', success: 'false', error_type: 'ShellError' }, 'claude_code.tool_result'));
    expect(evs.map((e) => e.type)).toEqual(['code', 'bug']);
  });

  it('Codex codex.tool_result (event name in attributes only)', () => {
    const evs = otlpToEvents(logs('codex_cli_rs', { 'event.name': 'codex.tool_result', 'conversation.id': 'cx-1', tool_name: 'exec_command', call_id: 'call_1', success: 'true' }));
    expect(evs).toMatchObject([{ type: 'code', tool: 'exec_command', sessionId: 'cx-1', harness: 'codex', callId: 'call_1', ts: T_ISO }]);
  });

  it('Gemini CLI gemini_cli.tool_call, skipping rejected calls', () => {
    const ok = otlpToEvents(logs('gemini-cli', { 'event.name': 'gemini_cli.tool_call', 'session.id': 'g-1', function_name: 'read_file', success: true, decision: 'accept' }));
    expect(ok).toMatchObject([{ type: 'research', tool: 'read_file', harness: 'gemini-cli', sessionId: 'g-1' }]);
    const rejected = otlpToEvents(logs('gemini-cli', { 'event.name': 'gemini_cli.tool_call', function_name: 'write_file', success: false, decision: 'reject' }));
    expect(rejected).toEqual([]);
  });

  it('ignores unrelated events', () => {
    expect(otlpToEvents(logs('claude-code', { 'event.name': 'api_request', 'session.id': 'x' }, 'claude_code.api_request'))).toEqual([]);
  });
});

describe('GenAI semantic convention spans', () => {
  it('execute_tool span; ERROR status adds a bug at span end', () => {
    const evs = otlpToEvents(
      spans([
        {
          name: 'execute_tool apply_patch',
          startTimeUnixNano: T,
          endTimeUnixNano: '1790676002000000000',
          attributes: kv({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'apply_patch', 'gen_ai.tool.call.id': 'c1', 'gen_ai.conversation.id': 'conv-1', 'error.type': 'tool_error' }),
          status: { code: 'STATUS_CODE_ERROR' },
        },
      ]),
    );
    expect(evs).toEqual([
      { type: 'code', tool: 'apply_patch', sessionId: 'conv-1', harness: 'my-agent', callId: 'c1', ts: T_ISO },
      { type: 'bug', tool: 'apply_patch', sessionId: 'conv-1', harness: 'my-agent', callId: 'c1', ts: '2026-09-29T10:00:02.000Z' },
    ]);
  });

  it('root invoke_agent span end → idle; nested ones are ignored', () => {
    const agent = { name: 'invoke_agent', startTimeUnixNano: T, endTimeUnixNano: T, attributes: kv({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 'c' }) };
    expect(otlpToEvents(spans([agent]))).toMatchObject([{ type: 'idle', sessionId: 'c' }]);
    expect(otlpToEvents(spans([{ ...agent, parentSpanId: 'abcd' }]))).toEqual([]);
  });

  it('Claude Code beta spans: tool + failing execution child', () => {
    const evs = otlpToEvents(
      spans([
        { name: 'claude_code.tool', startTimeUnixNano: T, endTimeUnixNano: T, attributes: kv({ tool_name: 'Edit', tool_use_id: 'toolu_1', 'session.id': 's' }) },
        { name: 'claude_code.tool.execution', parentSpanId: 'ab', startTimeUnixNano: T, endTimeUnixNano: T, attributes: kv({ success: 'false', 'session.id': 's' }) },
      ]),
    );
    expect(evs.map((e) => e.type)).toEqual(['code', 'bug']);
  });
});

describe('OTLP recordings', () => {
  it('round-trips a transcript through the OTLP/JSON recording format without content', () => {
    const lines = [
      { type: 'user', sessionId: 's', timestamp: '2026-09-29T10:00:00.000Z', message: { content: 'please fix the secret bug' } },
      { type: 'assistant', sessionId: 's', timestamp: '2026-09-29T10:00:01.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'secret' } }] } },
      { type: 'assistant', sessionId: 's', timestamp: '2026-09-29T10:00:02.000Z', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', sessionId: 's', timestamp: '2026-09-29T10:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'secret failure' }] } },
      { type: 'assistant', sessionId: 's', timestamp: '2026-09-29T10:00:04.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'secret' }] } },
    ];
    const rec = parseRecording(lines.map((l) => JSON.stringify(l)).join('\n'));
    const otlp = toOtlpRecording(rec);
    expect(otlp).not.toMatch(/secret|npm test/);
    expect(otlp).toContain('"execute_tool Bash"');

    const back = parseRecording(otlp);
    expect(back.startedAt).toBe('2026-09-29T10:00:00.000Z');
    expect(back.events.map((e) => [e.type, e.tool, e.ts])).toEqual([
      ['research', 'Grep', '2026-09-29T10:00:01.000Z'],
      ['code', 'Bash', '2026-09-29T10:00:02.000Z'],
      ['bug', 'Bash', '2026-09-29T10:00:03.000Z'],
      ['idle', undefined, '2026-09-29T10:00:04.000Z'],
    ]);
  });
});
