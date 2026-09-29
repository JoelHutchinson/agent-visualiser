import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LineTailer, TranscriptSource } from '../src/daemon/transcripts.js';
import type { Signal } from '../src/shared/events.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vis-'));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const eventsOf = (sigs: Signal[]) => sigs.flatMap((s) => (s.kind === 'event' ? [s.event] : []));

const toolUse = (name: string, ts = new Date().toISOString()) =>
  JSON.stringify({ type: 'assistant', sessionId: 'sess', timestamp: ts, message: { content: [{ type: 'tool_use', id: name + ts, name }] } }) + '\n';

describe('LineTailer', () => {
  it('returns only complete new lines and survives truncation', () => {
    const f = path.join(tmp, 'a.jsonl');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(f, 'one\ntw');
    const t = new LineTailer(f);
    expect(t.readNew()).toEqual(['one']);
    fs.appendFileSync(f, 'o\nthree\n');
    expect(t.readNew()).toEqual(['two', 'three']);
    expect(t.readNew()).toEqual([]);
    fs.writeFileSync(f, 'new\n');
    expect(t.readNew()).toEqual(['new']);
  });
});

describe('TranscriptSource', () => {
  it('adopts the newest session, then streams appended lines within 1 s', async () => {
    const proj = path.join(tmp, 'projects', 'C--code-app');
    fs.mkdirSync(proj, { recursive: true });
    const old = path.join(proj, 'old.jsonl');
    fs.writeFileSync(old, toolUse('Read', '2026-01-01T00:00:00.000Z'));
    fs.utimesSync(old, new Date('2026-01-01'), new Date('2026-01-01'));
    const cur = path.join(proj, 'sess.jsonl');
    fs.writeFileSync(cur, toolUse('Read', '2026-09-29T10:00:00.000Z') + '{"broken json\n');

    const adopted: [string, string, Signal[]][] = [];
    const ingested: Signal[] = [];
    const src = new TranscriptSource(
      { projectsDir: path.join(tmp, 'projects'), pollMs: 200 },
      { adopt: (...a) => void adopted.push(a), ingest: (e) => void ingested.push(...e), touch: () => {} },
    );
    src.start();
    try {
      expect(adopted).toHaveLength(1);
      expect(adopted[0][0]).toBe('sess');
      expect(adopted[0][1]).toBe('2026-09-29T10:00:00.000Z');
      expect(eventsOf(adopted[0][2]).map((e) => e.type)).toEqual(['research']);

      const t0 = Date.now();
      fs.appendFileSync(cur, toolUse('Edit'));
      while (!ingested.length && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 20));
      expect(eventsOf(ingested).map((e) => e.tool)).toEqual(['Edit']);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      src.stop();
    }
  });
});
