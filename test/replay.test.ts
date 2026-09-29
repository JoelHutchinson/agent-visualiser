import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRecording, ReplayPlayer, toOtlpRecording, type SubagentFile } from '../src/shared/replay.js';
import type { ServerMessage } from '../src/shared/protocol.js';

const S = 'sess-1';
const base = (n: number) => ({ sessionId: S, timestamp: new Date(Date.parse('2026-09-29T10:00:00.000Z') + n * 1000).toISOString() });
const iso = (n: number) => base(n).timestamp;
const use = (n: number, id: string, name: string, input: object = {}, extra: object = {}) => ({
  ...base(n), ...extra, type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const res = (n: number, id: string, extra: object = {}, top: object = {}, more: object = {}) => ({
  ...base(n), ...more, type: 'user', ...top, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'PRIVATE OUTPUT', ...extra }] },
});
const end = (n: number, more: object = {}) => ({ ...base(n), ...more, type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE TEXT' }] } });
const text = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n');
const side = (agentId: string) => ({ isSidechain: true, agentId });

// A session: research, a long command, a plan, then a subagent that does its own
// work (incl. a failing edit) while the root waits on it; then the turn ends.
const main = text(
  { ...base(0), type: 'user', message: { role: 'user', content: 'PRIVATE PROMPT' } },
  use(1, 'r1', 'Grep', { pattern: 'PRIVATE' }),
  res(1.5, 'r1'),
  use(2, 'b1', 'Bash', { command: 'npm test PRIVATE' }),
  res(6, 'b1'),
  use(6.5, 'p1', 'TodoWrite', { todos: 'PRIVATE' }),
  res(6.6, 'p1'),
  use(7, 'toolu_A', 'Agent', { description: 'Fix the parser', subagent_type: 'general-purpose', prompt: 'PRIVATE PROMPT' }),
  res(15, 'toolu_A', {}, { toolUseResult: { status: 'completed', agentId: 'aaa111' } }),
  end(16),
);
const subFiles: SubagentFile[] = [
  {
    agentId: 'aaa111',
    meta: { toolUseId: 'toolu_A', description: 'Fix the parser', agentType: 'general-purpose' },
    text: text(
      use(8, 's1', 'Read', {}, side('aaa111')),
      use(9, 's2', 'Edit', {}, side('aaa111')),
      res(10, 's2', { is_error: true }, {}, side('aaa111')),
      use(11, 's3', 'WebFetch', { url: 'https://PRIVATE' }, side('aaa111')),
      res(13, 's3', {}, {}, side('aaa111')),
      end(14, side('aaa111')),
    ),
  },
];

describe('recordings', () => {
  it('carry the agent tree and tool calls parsed from a transcript with subagent files', () => {
    const rec = parseRecording(main, subFiles);
    expect(rec.sessionId).toBe(S);
    expect(rec.agents).toEqual([{ id: 'toolu_A', parentId: S, name: 'Fix the parser', kind: 'general-purpose', startedAt: iso(7), endedAt: expect.any(String) }]);
    expect(rec.events.filter((e) => e.type !== 'idle').map((e) => [e.type, e.tool, e.agentId === S ? 'root' : e.agentId])).toEqual([
      ['research', 'Grep', 'root'],
      ['code', 'Bash', 'root'],
      ['research', 'Read', 'toolu_A'],
      ['code', 'Edit', 'toolu_A'],
      ['bug', 'Edit', 'toolu_A'],
      ['research', 'WebFetch', 'toolu_A'],
    ]);
    expect(rec.tools.map((t) => t.tool)).toEqual(['Grep', 'Bash', 'TodoWrite', 'Read', 'Edit', 'WebFetch']);
  });

  it('serialise to standard OTLP/JSON with nested invoke_agent spans, without content, and round-trip', () => {
    const rec = parseRecording(main, subFiles);
    const otlp = toOtlpRecording(rec);
    expect(otlp).not.toMatch(/PRIVATE|npm test|https:/);
    const req = JSON.parse(otlp);
    const spans = req.resourceSpans[0].scopeSpans[0].spans as { name: string; spanId: string; parentSpanId?: string }[];
    const sub = spans.find((s) => s.name === 'invoke_agent Fix the parser')!;
    const turn = spans.find((s) => s.name === 'invoke_agent Orchestrator')!;
    expect(sub.parentSpanId).toBe(turn.spanId);
    expect(spans.find((s) => s.name === 'execute_tool Edit')!.parentSpanId).toBe(sub.spanId);
    expect(spans.find((s) => s.name === 'execute_tool Bash')!.parentSpanId).toBe(turn.spanId);
    expect(otlp).toContain('"agent_visualiser.agent.kind"');

    const back = parseRecording(otlp);
    expect(back.startedAt).toBe(rec.startedAt);
    expect(back.agents.map((a) => [a.id, a.parentId, a.name, a.kind, a.startedAt, a.endedAt])).toEqual(rec.agents.map((a) => [a.id, a.parentId, a.name, a.kind, a.startedAt, a.endedAt]));
    const shape = (r: typeof rec) => r.events.map((e) => [e.type, e.tool, e.agentId ?? S, e.ts]);
    expect(shape(back)).toEqual(shape(rec));
    expect(back.tools.map((t) => [t.tool, t.agentId, t.start, t.end ?? t.start, t.ok])).toEqual(rec.tools.map((t) => [t.tool, t.agentId, t.start, t.end ?? t.start, t.ok]));
  });

  it('keep replaying old transcripts (no subagent files) and bare event lines', () => {
    const rec = parseRecording(text(use(1, 'x', 'Read'), use(2, 'y', 'Edit'), end(3)));
    expect(rec.events.map((e) => e.type)).toEqual(['research', 'code', 'idle']);
    expect(rec.agents).toEqual([]);
    const bare = parseRecording(text({ type: 'code', sessionId: 'z', ts: iso(1), tool: 'Edit' }, { type: 'idle', sessionId: 'z', ts: iso(2) }));
    expect(bare.events.map((e) => e.type)).toEqual(['code', 'idle']);
    // ...and survive a trip through the OTLP format.
    expect(parseRecording(toOtlpRecording(bare)).events.map((e) => e.type)).toEqual(['code', 'idle']);
  });

  it('keep an unfinished turn and unfinished subagent unfinished (no phantom idle or done)', () => {
    const rec = parseRecording(text(use(1, 'toolu_A', 'Agent', { description: 'Still going' }), use(2, 'x', 'Read')));
    const back = parseRecording(toOtlpRecording(rec));
    expect(back.events.map((e) => e.type)).toEqual(['research']);
    expect(back.agents).toMatchObject([{ id: 'toolu_A', name: 'Still going' }]);
    expect(back.agents[0].endedAt).toBeUndefined();
  });
});

describe('ReplayPlayer (protocol v2)', () => {
  let out: ServerMessage[];
  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
  });
  afterEach(() => vi.useRealTimers());

  const desc = (m: ServerMessage) =>
    m.kind === 'event' ? `${m.event.type}:${m.event.agentId === S ? 'root' : m.event.agentId}` : m.kind === 'agent' ? `agent:${m.agent.id}:${m.agent.state}` : m.kind === 'activity' ? `${m.activity}:${m.op}` : m.kind;

  it('emits a session snapshot, then agents, events and derived activities as they happen', () => {
    const player = new ReplayPlayer(parseRecording(main, subFiles), (m) => out.push(m), { speed: 1000 });
    player.start();
    vi.advanceTimersByTime(60_000);
    expect(out[0]).toMatchObject({ kind: 'session', sessionId: S, source: 'replay', rate: 1000, counts: { research: 0, code: 0, bug: 0 }, agents: [{ id: S, parentId: null, name: 'Orchestrator', state: 'waiting' }], activities: [] });
    expect(out.at(-1)).toEqual({ kind: 'ended' });
    const seq = out.slice(1, -1).map(desc);
    expect(seq).toEqual([
      'agent:sess-1:working',
      'research:root',
      'code:root',
      'run:start', // the 4 s command: shown once it had been out 1.5 s
      'run:end',
      'plan:start',
      'plan:end',
      'agent:toolu_A:working',
      'research:toolu_A',
      'code:toolu_A',
      'bug:toolu_A',
      'web:start',
      'research:toolu_A', // WebFetch counts as research too
      'web:end',
      'agent:toolu_A:done',
      'agent:sess-1:waiting',
    ]);
    expect(JSON.stringify(out)).not.toMatch(/PRIVATE|callId/);
  });

  it('never announces a fast command as a run', () => {
    const rec = parseRecording(text(use(1, 'b', 'Bash'), res(1.5, 'b'), end(2)));
    const player = new ReplayPlayer(rec, (m) => out.push(m), { speed: 1000 });
    player.start();
    vi.advanceTimersByTime(10_000);
    expect(out.map(desc).some((d) => d.startsWith('run'))).toBe(false);
  });

  it('snapshot() reflects the state so far, for a client that connects mid-replay', () => {
    const player = new ReplayPlayer(parseRecording(main, subFiles), (m) => out.push(m), { speed: 1 });
    player.start();
    // Recorded t=8..: the subagent is alive and has read a file.
    vi.advanceTimersByTime(9_500);
    const snap = player.snapshot() as Extract<ServerMessage, { kind: 'session' }>;
    expect(snap.agents.map((a) => [a.id, a.parentId, a.state])).toEqual([[S, null, 'working'], ['toolu_A', S, 'working']]);
    expect(snap.counts.research).toBeGreaterThanOrEqual(2);
    player.stop();
  });

  it('loops', () => {
    const player = new ReplayPlayer(parseRecording(text(use(1, 'x', 'Read'), end(2))), (m) => out.push(m), { speed: 1000, loop: true });
    player.start();
    vi.advanceTimersByTime(10_000);
    expect(out.filter((m) => m.kind === 'session').length).toBeGreaterThan(1);
    expect(out.some((m) => m.kind === 'ended')).toBe(false);
    player.stop();
  });
});
