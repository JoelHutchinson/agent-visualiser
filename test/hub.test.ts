import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, VisEvent } from '../src/shared/events.js';
import { Hub } from '../src/daemon/hub.js';

const ev = (type: VisEvent['type'], sessionId = 'a', extra: Partial<VisEvent> = {}): VisEvent => ({
  type,
  sessionId,
  ts: new Date().toISOString(),
  ...extra,
});

describe('Hub', () => {
  let out: ServerMessage[];
  let hub: Hub;
  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
    hub = new Hub((m) => out.push(m), { idleAfterMs: 10_000 });
  });
  afterEach(() => {
    hub.stop();
    vi.useRealTimers();
  });

  const kinds = () => out.map((m) => (m.kind === 'event' ? m.event.type : m.kind));

  it('starts waiting, then shows a new session before its first event', () => {
    expect(hub.snapshot()).toEqual({ kind: 'waiting' });
    hub.ingest([ev('code', 'a', { harness: 'codex' })]);
    expect(kinds()).toEqual(['session', 'code']);
    // Snapshot sent before the event, so the scene doesn't double count.
    expect(out[0]).toMatchObject({ kind: 'session', counts: { code: 0 }, harness: 'codex' });
    expect(hub.snapshot()).toMatchObject({ counts: { code: 1 }, idle: false });
  });

  it('counts a call once across channels, and never leaks callId', () => {
    hub.ingest([ev('code', 'a', { callId: 'x' })]);
    hub.ingest([ev('code', 'a', { callId: 'x' }), ev('bug', 'a', { callId: 'x' })]);
    expect(kinds()).toEqual(['session', 'code', 'bug']);
    expect(JSON.stringify(out)).not.toContain('"callId"');
  });

  it('goes idle after 10 s of silence, and touch() postpones it', () => {
    hub.ingest([ev('research')]);
    vi.advanceTimersByTime(8000);
    hub.touch('a');
    vi.advanceTimersByTime(8000);
    expect(kinds()).not.toContain('idle');
    vi.advanceTimersByTime(2001);
    expect(kinds().at(-1)).toBe('idle');
  });

  it('a brand-new session takes over; a known one waits until the current is idle', () => {
    hub.ingest([ev('code', 'a'), ev('code', 'b')]);
    expect(hub.snapshot()).toMatchObject({ sessionId: 'b' });
    hub.ingest([ev('code', 'a')]); // a is known, b is busy: stay on b
    expect(hub.snapshot()).toMatchObject({ sessionId: 'b' });
    hub.ingest([ev('idle', 'b'), ev('research', 'a')]);
    expect(hub.snapshot()).toMatchObject({ sessionId: 'a', counts: { code: 2, research: 1 } });
  });

  it('adopt() loads history silently', () => {
    hub.adopt('a', '2026-09-29T09:00:00.000Z', [ev('code'), ev('bug'), ev('idle')]);
    expect(kinds()).toEqual(['session']);
    expect(out[0]).toMatchObject({ counts: { code: 1, bug: 1, research: 0 }, idle: true, startedAt: '2026-09-29T09:00:00.000Z' });
  });
});
