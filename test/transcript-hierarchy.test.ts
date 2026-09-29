// Synthetic fixtures that mirror the real Claude Code layout (verified against
// local transcripts, v2.1.x): subagent lines live in
// <session>/subagents/agent-<id>.jsonl with isSidechain + agentId + the
// parent's sessionId, linked to the parent's Agent tool_use through
// agent-<id>.meta.json { toolUseId }. No real content is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptSource } from '../src/daemon/transcripts.js';
import type { Signal } from '../src/shared/events.js';
import { TranscriptParser } from '../src/shared/transcript.js';

const SESSION = 'sess-1';
let clock = Date.parse('2026-09-29T10:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();

const main = { sessionId: SESSION, isSidechain: false };
const use = (id: string, name: string, input: object = {}, extra: object = {}) => ({
  ...main, ...extra, type: 'assistant', timestamp: ts(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, extra: object = {}, toolUseResult?: object, base: object = main) => ({
  ...base, type: 'user', timestamp: ts(), ...(toolUseResult ? { toolUseResult } : {}), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...extra }] },
});
const endTurn = (base: object = main) => ({ ...base, type: 'assistant', timestamp: ts(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const sub = (agentId: string) => ({ sessionId: SESSION, isSidechain: true, agentId });

const spawn = (id: string, description = 'Find the auth code', subagent_type = 'Explore') =>
  use(id, 'Agent', { description, subagent_type, prompt: 'SECRET PROMPT: do the thing with /etc/passwd', model: 'sonnet' });

const run = (lines: object[], parser = new TranscriptParser(SESSION), file?: string) => lines.flatMap((l) => parser.feed(l as Record<string, unknown>, file));
const agents = (sigs: Signal[]) => sigs.flatMap((s) => (s.kind === 'agent' ? [s.agent] : []));
const events = (sigs: Signal[]) => sigs.flatMap((s) => (s.kind === 'event' ? [s.event] : []));
const tools = (sigs: Signal[]) => sigs.flatMap((s) => (s.kind === 'tool' ? [s] : []));

describe('transcript hierarchy', () => {
  it('an Agent tool_use starts a subagent named by its description, never the prompt', () => {
    const sigs = run([spawn('toolu_A')]);
    expect(agents(sigs)).toEqual([
      { id: 'toolu_A', parentId: SESSION, name: 'Find the auth code', kind: 'Explore', state: 'working', startedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(sigs)).not.toMatch(/SECRET|passwd/);
    // The spawn itself is not a counted event or an activity.
    expect(events(sigs)).toEqual([]);
    expect(tools(sigs)).toEqual([]);
  });

  it('also understands the older Task tool, truncates long descriptions and falls back to a generic name', () => {
    const sigs = run([use('t1', 'Task', { description: 'x'.repeat(200), subagent_type: 'Plan' }), use('t2', 'Task', {})]);
    expect(agents(sigs).map((a) => [a.name.length, a.kind, a.name.length > 0])).toEqual([[60, 'Plan', true], ['Subagent'.length, undefined, true]]);
  });

  it('a synchronous spawn finishes on its tool_result', () => {
    const sigs = run([spawn('toolu_A'), result('toolu_A', {}, { status: 'completed', agentId: 'aaa111' })]);
    expect(agents(sigs).map((a) => a.state)).toEqual(['working', 'done']);
  });

  it('a background spawn is NOT finished by its immediate async_launched result', () => {
    const p = new TranscriptParser(SESSION);
    const sigs = run([spawn('toolu_A'), result('toolu_A', {}, { isAsync: true, status: 'async_launched', agentId: 'aaa111' })], p);
    expect(agents(sigs).map((a) => a.state)).toEqual(['working']);
    // ...it finishes on its task-notification (queue-operation) or via the subagent's own end_turn.
    const done = p.feed({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: SESSION, content: '<task-notification>\n<task-id>aaa111</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>completed</status>\n</task-notification>' });
    expect(agents(done)).toMatchObject([{ id: 'toolu_A', state: 'done' }]);
  });

  it('ignores non-terminal notifications and notifications for unknown ids (background shells)', () => {
    const p = new TranscriptParser(SESSION);
    run([spawn('toolu_A'), result('toolu_A', {}, { status: 'async_launched', agentId: 'aaa111' })], p);
    const note = (tool: string, status: string) => p.feed({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: `<task-notification><tool-use-id>${tool}</tool-use-id><status>${status}</status></task-notification>` });
    expect(agents(note('toolu_A', 'running'))).toEqual([]);
    expect(agents(note('toolu_shell', 'completed'))).toEqual([]);
    expect(agents(note('toolu_A', 'failed'))).toMatchObject([{ state: 'done' }]);
  });

  it('attributes subagent-file lines to the subagent, via meta.json or the async result', () => {
    const p = new TranscriptParser(SESSION);
    p.hint({ agentId: 'aaa111', toolUseId: 'toolu_A', description: 'Find the auth code', agentType: 'Explore' });
    const sigs = [
      ...run([spawn('toolu_A')], p),
      ...run([use('s1', 'Read', {}, sub('aaa111')), use('s2', 'Edit', {}, sub('aaa111'))], p, 'aaa111'),
      ...run([use('m1', 'Grep')], p),
    ];
    expect(events(sigs).map((e) => [e.type, e.tool, e.agentId])).toEqual([
      ['research', 'Read', 'toolu_A'],
      ['code', 'Edit', 'toolu_A'],
      ['research', 'Grep', SESSION],
    ]);
  });

  it('registers a subagent from meta.json when its lines show up before the spawn was seen', () => {
    const p = new TranscriptParser(SESSION);
    p.hint({ agentId: 'aaa111', toolUseId: 'toolu_A', description: 'Late', agentType: 'Plan' });
    const sigs = run([use('s1', 'Read', {}, sub('aaa111'))], p, 'aaa111');
    expect(agents(sigs)).toMatchObject([{ id: 'toolu_A', parentId: SESSION, name: 'Late', kind: 'Plan', state: 'working' }]);
    expect(events(sigs)[0].agentId).toBe('toolu_A');
    // The real spawn line then fixes up nothing that was already right...
    expect(agents(run([spawn('toolu_A', 'Late', 'Plan')], p))).toEqual([]);
  });

  it('links via the async result agentId when there is no meta.json', () => {
    const p = new TranscriptParser(SESSION);
    run([spawn('toolu_A'), result('toolu_A', {}, { status: 'async_launched', agentId: 'aaa111' })], p);
    expect(events(run([use('s1', 'Bash', {}, sub('aaa111'))], p, 'aaa111'))[0].agentId).toBe('toolu_A');
  });

  it('credits lines that cannot be linked to the root', () => {
    const sigs = run([use('s1', 'Read', {}, sub('unknown'))], new TranscriptParser(SESSION), 'unknown');
    expect(events(sigs).map((e) => e.agentId)).toEqual([SESSION]);
  });

  it('nested spawns: the parent is the agent whose file holds the spawn', () => {
    const p = new TranscriptParser(SESSION);
    p.hint({ agentId: 'aaa111', toolUseId: 'toolu_A', description: 'Outer' });
    run([spawn('toolu_A', 'Outer')], p);
    const sigs = run([spawn('toolu_B', 'Inner')].map((l) => ({ ...l, ...sub('aaa111') })), p, 'aaa111');
    expect(agents(sigs)).toMatchObject([{ id: 'toolu_B', parentId: 'toolu_A', name: 'Inner' }]);
  });

  it('a subagent ending its turn finishes it; the root ending its turn is idle', () => {
    const p = new TranscriptParser(SESSION);
    p.hint({ agentId: 'aaa111', toolUseId: 'toolu_A' });
    run([spawn('toolu_A')], p);
    const s1 = run([endTurn(sub('aaa111'))], p, 'aaa111');
    expect(agents(s1)).toMatchObject([{ id: 'toolu_A', state: 'done' }]);
    expect(events(s1)).toEqual([]);
    expect(p.isDone('aaa111')).toBe(true);
    expect(events(run([endTurn()], p)).map((e) => [e.type, e.agentId])).toEqual([['idle', SESSION]]);
  });

  it('bug events go to the agent that ran the failing tool', () => {
    const p = new TranscriptParser(SESSION);
    p.hint({ agentId: 'aaa111', toolUseId: 'toolu_A' });
    run([spawn('toolu_A')], p);
    const sigs = run([use('s1', 'Bash', {}, sub('aaa111')), result('s1', { is_error: true }, undefined, sub('aaa111'))], p, 'aaa111');
    expect(events(sigs).map((e) => [e.type, e.agentId])).toEqual([['code', 'toolu_A'], ['bug', 'toolu_A']]);
    expect(tools(sigs).map((t) => [t.op, t.tool, t.ok])).toEqual([['start', 'Bash', undefined], ['end', 'Bash', false]]);
  });

  it('TaskStop on a background agent finishes it', () => {
    const p = new TranscriptParser(SESSION);
    run([spawn('toolu_A'), result('toolu_A', {}, { status: 'async_launched', agentId: 'aaa111' })], p);
    const sigs = run([use('stop1', 'TaskStop', { task_id: 'aaa111' }), result('stop1')], p);
    expect(agents(sigs)).toMatchObject([{ id: 'toolu_A', state: 'done' }]);
  });

  it('a typed user prompt wakes the root; tool results and meta lines do not', () => {
    const p = new TranscriptParser(SESSION);
    const typed = { ...main, type: 'user', timestamp: ts(), message: { role: 'user', content: 'do it' } };
    expect(agents(run([typed], p))).toMatchObject([{ id: SESSION, parentId: null, state: 'working' }]);
    expect(agents(run([{ ...typed, isMeta: true }, result('x')], p))).toEqual([]);
  });

  it('never leaks prompts, commands or outputs', () => {
    const sigs = run([
      spawn('toolu_A'),
      use('b1', 'Bash', { command: 'cat ~/.ssh/id_rsa' }),
      result('b1', { content: 'TOP SECRET OUTPUT' }),
      { ...main, type: 'user', timestamp: ts(), message: { content: 'my password is hunter2' } },
    ]);
    expect(JSON.stringify(sigs)).not.toMatch(/SECRET|id_rsa|hunter2|passwd/);
  });
});

describe('TranscriptSource with subagent files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vis-sub-'));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const jsonl = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  it('adopts the hierarchy from history, then tails the running subagent file and drops it when done', async () => {
    const proj = path.join(tmp, 'projects', 'C--code-app');
    const subDir = path.join(proj, SESSION, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(proj, `${SESSION}.jsonl`), jsonl(spawn('toolu_A'), result('toolu_A', {}, { status: 'async_launched', agentId: 'aaa111' })));
    fs.writeFileSync(path.join(subDir, 'agent-aaa111.meta.json'), JSON.stringify({ toolUseId: 'toolu_A', description: 'Find the auth code', agentType: 'Explore' }));
    const subFile = path.join(subDir, 'agent-aaa111.jsonl');
    fs.writeFileSync(subFile, jsonl(use('s0', 'Read', {}, sub('aaa111'))));

    const adopted: Signal[][] = [];
    const ingested: Signal[] = [];
    const src = new TranscriptSource(
      { projectsDir: path.join(tmp, 'projects'), pollMs: 100 },
      { adopt: (_a, _b, h) => void adopted.push(h), ingest: (s) => void ingested.push(...s), touch: () => {} },
    );
    src.start();
    try {
      expect(agents(adopted[0])).toMatchObject([{ id: 'toolu_A', name: 'Find the auth code', kind: 'Explore', state: 'working' }]);
      expect(events(adopted[0]).map((e) => [e.tool, e.agentId])).toEqual([['Read', 'toolu_A']]);

      fs.appendFileSync(subFile, jsonl(use('s1', 'Edit', {}, sub('aaa111')), endTurn(sub('aaa111'))));
      const t0 = Date.now();
      while (!agents(ingested).some((a) => a.state === 'done') && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
      expect(events(ingested).map((e) => [e.tool, e.agentId])).toEqual([['Edit', 'toolu_A']]);
      expect(agents(ingested).map((a) => a.state)).toEqual(['done']);
    } finally {
      src.stop();
    }
  });
});
