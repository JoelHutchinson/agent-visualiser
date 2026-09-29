import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Signal, VisEvent } from '../src/shared/events.js';
import type { ServerMessage } from '../src/shared/protocol.js';
import { Hub } from '../src/daemon/hub.js';

const now = () => new Date().toISOString();
const ev = (type: VisEvent['type'], sessionId = 'a', extra: Partial<VisEvent> = {}): Signal => ({
  kind: 'event',
  event: { type, sessionId, ts: now(), ...extra },
});
const agent = (id: string, parentId: string | null, state: 'working' | 'waiting' | 'done' = 'working', sessionId = 'a'): Signal => ({
  kind: 'agent',
  sessionId,
  ts: now(),
  agent: { id, parentId, name: `agent ${id}`, kind: 'Explore', state, startedAt: now() },
});
const tool = (tool: string, callId: string, op: 'start' | 'end', extra: Partial<Extract<Signal, { kind: 'tool' }>> = {}): Signal => ({
  kind: 'tool',
  sessionId: 'a',
  agentId: 'a',
  tool,
  callId,
  op,
  ts: now(),
  ...extra,
});

type Session = Extract<ServerMessage, { kind: 'session' }>;

describe('Hub', () => {
  let out: ServerMessage[];
  let hub: Hub;
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-29T10:00:00.000Z') });
    out = [];
    hub = new Hub((m) => out.push(m), { idleAfterMs: 10_000 });
  });
  afterEach(() => {
    hub.stop();
    vi.useRealTimers();
  });

  const desc = (m: ServerMessage) =>
    m.kind === 'event'
      ? m.event.type
      : m.kind === 'agent'
        ? `agent:${m.agent.id}:${m.agent.state}`
        : m.kind === 'activity'
          ? `${m.activity}:${m.op}`
          : m.kind;
  const kinds = () => out.map(desc);
  const snap = () => hub.snapshot() as Session;

  it('starts waiting, then shows a new session before its first event', () => {
    expect(hub.snapshot()).toEqual({ kind: 'waiting' });
    hub.ingest([ev('code', 'a', { harness: 'codex' })]);
    // Snapshot first (so the scene doesn't double count), then the root wakes, then the event.
    expect(kinds()).toEqual(['session', 'agent:a:working', 'code']);
    expect(out[0]).toMatchObject({ kind: 'session', counts: { code: 0 }, harness: 'codex', source: 'live', rate: 1 });
    expect(snap()).toMatchObject({ counts: { code: 1 }, harness: 'codex' });
    expect(snap().agents).toEqual([{ id: 'a', parentId: null, name: 'Orchestrator', state: 'working', startedAt: expect.any(String) }]);
  });

  it('counts a call once across channels, and never leaks callId', () => {
    hub.ingest([ev('code', 'a', { callId: 'x' })]);
    hub.ingest([ev('code', 'a', { callId: 'x' }), ev('bug', 'a', { callId: 'x' })]);
    expect(kinds()).toEqual(['session', 'agent:a:working', 'code', 'bug']);
    expect(JSON.stringify(out)).not.toContain('"callId"');
  });

  it('goes waiting after 10 s of silence, and touch() postpones it', () => {
    hub.ingest([ev('research')]);
    vi.advanceTimersByTime(8000);
    hub.touch('a');
    vi.advanceTimersByTime(8000);
    expect(kinds()).not.toContain('agent:a:waiting');
    vi.advanceTimersByTime(2001);
    expect(kinds().at(-1)).toBe('agent:a:waiting');
    // ...and new activity wakes it again.
    hub.ingest([ev('code')]);
    expect(kinds().slice(-2)).toEqual(['agent:a:working', 'code']);
  });

  it('an idle event (end of turn) sends the root to waiting immediately, once', () => {
    hub.ingest([ev('code')]);
    hub.ingest([ev('idle'), ev('idle')]);
    expect(kinds()).toEqual(['session', 'agent:a:working', 'code', 'agent:a:waiting']);
  });

  it('a brand-new session takes over; a known one waits until the current is waiting', () => {
    hub.ingest([ev('code', 'a'), ev('code', 'b')]);
    expect(snap().sessionId).toBe('b');
    hub.ingest([ev('code', 'a')]); // a is known, b is busy: stay on b
    expect(snap().sessionId).toBe('b');
    hub.ingest([ev('idle', 'b'), ev('research', 'a')]);
    expect(snap()).toMatchObject({ sessionId: 'a', counts: { code: 2, research: 1 } });
  });

  it('adopt() loads history silently, including the agent tree', () => {
    hub.adopt('a', '2026-09-29T09:00:00.000Z', [
      ev('code'),
      agent('t1', 'a'),
      ev('research', 'a', { agentId: 't1' }),
      ev('bug'),
      agent('t2', 't1'),
      agent('t2', 't1', 'done'),
      ev('idle'),
    ]);
    expect(kinds()).toEqual(['session']);
    const s = out[0] as Session;
    expect(s).toMatchObject({ counts: { code: 1, bug: 1, research: 1 }, startedAt: '2026-09-29T09:00:00.000Z' });
    expect(s.agents.map((a) => [a.id, a.parentId, a.state])).toEqual([
      ['a', null, 'waiting'],
      ['t1', 'a', 'working'],
    ]);
  });

  describe('agents', () => {
    it('sends agent messages for new subagents and only when something changed', () => {
      hub.ingest([ev('code'), agent('t1', 'a')]);
      hub.ingest([agent('t1', 'a')]); // unchanged: silent
      hub.ingest([agent('t1', 'a', 'done')]);
      hub.ingest([agent('t1', 'a', 'done')]); // already gone: silent
      expect(kinds()).toEqual(['session', 'agent:a:working', 'code', 'agent:t1:working', 'agent:t1:done']);
      expect(snap().agents.map((a) => a.id)).toEqual(['a']);
    });

    it('snapshots list alive agents root first, parents before children', () => {
      hub.ingest([ev('code'), agent('c', 'b'), agent('b', 'a'), agent('d', 'a'), agent('gone', 'a')]);
      hub.ingest([agent('gone', 'a', 'done')]);
      expect(snap().agents.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('a subagent starting wakes a waiting root', () => {
      hub.ingest([ev('code'), ev('idle')]);
      hub.ingest([agent('t1', 'a')]);
      expect(kinds().slice(-3)).toEqual(['agent:a:waiting', 'agent:a:working', 'agent:t1:working']);
    });

    it('root signals from OTel carry a name; the default name does not overwrite it', () => {
      hub.ingest([{ kind: 'agent', sessionId: 'a', ts: now(), agent: { id: 'a', parentId: null, name: 'Coder', state: 'working', startedAt: now() } }]);
      expect(snap().agents[0].name).toBe('Coder');
      hub.ingest([{ kind: 'agent', sessionId: 'a', ts: now(), agent: { id: 'a', parentId: null, name: 'Orchestrator', state: 'working', startedAt: now() } }]);
      expect(snap().agents[0].name).toBe('Coder');
    });
  });

  describe('activities', () => {
    it('plan and web start on the call and end on the result', () => {
      hub.ingest([tool('TodoWrite', 'p1', 'start')]);
      expect(snap().activities).toEqual([{ agentId: 'a', activity: 'plan', since: expect.any(String) }]);
      hub.ingest([tool('TodoWrite', 'p1', 'end', { ok: true })]);
      hub.ingest([tool('WebFetch', 'w1', 'start', { agentId: 't1' }), tool('WebFetch', 'w1', 'end')]);
      expect(kinds().filter((k) => /^(plan|web)/.test(k))).toEqual(['plan:start', 'plan:end', 'web:start', 'web:end']);
      expect(out.find((m) => m.kind === 'activity' && m.activity === 'web')).toMatchObject({ agentId: 't1' });
      expect(snap().activities).toEqual([]);
    });

    it('a plan call whose result never arrives ends after 3 s', () => {
      hub.ingest([tool('update_plan', 'p1', 'start')]);
      vi.advanceTimersByTime(2900);
      expect(kinds()).not.toContain('plan:end');
      vi.advanceTimersByTime(200);
      expect(kinds()).toContain('plan:end');
    });

    it('a fast command never shows a run (no start, no end)', () => {
      hub.ingest([tool('Bash', 'c1', 'start')]);
      vi.advanceTimersByTime(1000);
      hub.ingest([tool('Bash', 'c1', 'end', { ok: true })]);
      vi.advanceTimersByTime(5000);
      expect(kinds().filter((k) => k.startsWith('run'))).toEqual([]);
    });

    it('a command still out after 1.5 s starts a run, and ends with ok', () => {
      hub.ingest([tool('PowerShell', 'c1', 'start')]);
      vi.advanceTimersByTime(1499);
      expect(kinds().some((k) => k.startsWith('run'))).toBe(false);
      vi.advanceTimersByTime(2);
      expect(kinds().at(-1)).toBe('run:start');
      expect(snap().activities.map((a) => a.activity)).toEqual(['run']);
      hub.ingest([tool('PowerShell', 'c1', 'end', { ok: false })]);
      expect(out.at(-1)).toMatchObject({ kind: 'activity', activity: 'run', op: 'end', ok: false });
      expect(snap().activities).toEqual([]);
    });

    it('does not go waiting while a command is still running, then does after it returns', () => {
      hub.ingest([tool('Bash', 'c1', 'start')]);
      vi.advanceTimersByTime(30_000);
      expect(snap().agents[0].state).toBe('working');
      hub.ingest([tool('Bash', 'c1', 'end', { ok: true })]);
      vi.advanceTimersByTime(10_001);
      expect(snap().agents[0].state).toBe('waiting');
    });

    it('parallel calls of one kind are one activity', () => {
      hub.ingest([tool('WebSearch', 'w1', 'start'), tool('WebSearch', 'w2', 'start'), tool('WebSearch', 'w1', 'end')]);
      expect(kinds().filter((k) => k.startsWith('web'))).toEqual(['web:start']);
      hub.ingest([tool('WebSearch', 'w2', 'end')]);
      expect(kinds().filter((k) => k.startsWith('web'))).toEqual(['web:start', 'web:end']);
    });

    it('AskUserQuestion is a wait activity for its agent', () => {
      hub.ingest([tool('AskUserQuestion', 'q1', 'start', { agentId: 't1' })]);
      expect(out.at(-1)).toMatchObject({ kind: 'activity', activity: 'wait', op: 'start', agentId: 't1' });
      hub.ingest([tool('AskUserQuestion', 'q1', 'end', { agentId: 't1' })]);
      expect(out.at(-1)).toMatchObject({ activity: 'wait', op: 'end' });
    });

    it('a finishing agent ends its activities', () => {
      hub.ingest([agent('t1', 'a'), tool('WebFetch', 'w1', 'start', { agentId: 't1' })]);
      hub.ingest([agent('t1', 'a', 'done')]);
      expect(kinds().slice(-2)).toEqual(['web:end', 'agent:t1:done']);
    });

    it('tools reported only at completion: long run/web blink, short ones skipped, plan always', () => {
      hub.ingest([
        tool('Bash', 'r1', 'end', { durationMs: 200 }),
        tool('WebFetch', 'w1', 'end', { durationMs: 200 }),
        tool('Bash', 'r2', 'end', { durationMs: 4000, ok: true }),
        tool('write_todos', 'p1', 'end', { durationMs: 5 }),
      ]);
      expect(kinds().filter((k) => /^(run|plan|web)/.test(k))).toEqual(['run:start', 'run:end', 'plan:start', 'plan:end']);
    });

    it('counts a call once when seen via two channels', () => {
      hub.ingest([tool('WebSearch', 'w1', 'start'), tool('WebSearch', 'w1', 'end')]);
      hub.ingest([tool('WebSearch', 'w1', 'end', { durationMs: 3000 })]);
      expect(kinds().filter((k) => k.startsWith('web'))).toEqual(['web:start', 'web:end']);
    });

    it('adopt() picks up a call still in flight, crediting the time it already ran', () => {
      const start = new Date(Date.now() - 1000).toISOString();
      hub.adopt('a', start, [ev('code'), tool('Bash', 'c1', 'start', { ts: start })]);
      vi.advanceTimersByTime(600);
      expect(kinds().at(-1)).toBe('run:start');
    });

    it('adopt() ignores calls that were abandoned long ago', () => {
      const old = new Date(Date.now() - 3600_000).toISOString();
      hub.adopt('a', old, [ev('code', 'a', { ts: old }), tool('Bash', 'c1', 'start', { ts: old })]);
      vi.advanceTimersByTime(5000);
      expect(kinds().filter((k) => k.startsWith('run'))).toEqual([]);
    });

    it('activities of a background session are tracked for its snapshot', () => {
      hub.ingest([ev('code', 'a'), ev('code', 'b')]); // b on screen
      hub.ingest([{ ...tool('WebFetch', 'w1', 'start'), sessionId: 'a' }]);
      expect(kinds().some((k) => k.startsWith('web'))).toBe(false);
      hub.ingest([ev('idle', 'b'), ev('research', 'a')]);
      expect((out.filter((m) => m.kind === 'session').at(-1) as Session).activities).toEqual([{ agentId: 'a', activity: 'web', since: expect.any(String) }]);
    });
  });
});
