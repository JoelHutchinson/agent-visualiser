import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNetworkPath, listSessions, TranscriptSource } from '../src/daemon/transcripts.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vis-multi-'));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const line = (sessionId: string) =>
  JSON.stringify({ type: 'assistant', sessionId, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'Read', input: {} }] } }) + '\n';

function session(root: string, id: string, ageMs = 0) {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(f, line(id));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}

function follower(dirs: string[]) {
  const adopted: string[] = [];
  const src = new TranscriptSource({ projectsDir: dirs, pollMs: 50 }, {
    adopt: (id: string) => void adopted.push(id),
    ingest: () => {},
    touch: () => {},
  } as never);
  return { src, adopted, check: (full = true) => (src as unknown as { check(f: boolean): void }).check(full) };
}

describe('multiple projects folders (Windows + WSL)', () => {
  it('lists sessions across folders and spots network paths', () => {
    session(path.join(tmp, 'win'), 'a'); session(path.join(tmp, 'wsl'), 'b');
    expect(listSessions([path.join(tmp, 'win'), path.join(tmp, 'wsl')]).map((s) => path.basename(s.file))).toEqual(['a.jsonl', 'b.jsonl']);
    expect(isNetworkPath('\\\\wsl.localhost\\Ubuntu\\home\\joel\\.claude\\projects')).toBe(true);
    expect(isNetworkPath('C:\\Users\\me\\.claude\\projects')).toBe(false);
  });

  it('a brand-new session takes over; a busy known one does not steal the view', () => {
    const win = path.join(tmp, 'win'), wsl = path.join(tmp, 'wsl');
    session(win, 'mine', 1000);
    session(wsl, 'old', 5000);
    const { src, adopted, check } = follower([win, wsl]);
    src.start();
    expect(adopted.at(-1)).toBe('mine');

    // The other known session becomes the most recently written: no flip.
    fs.appendFileSync(path.join(wsl, 'proj', 'old.jsonl'), line('old'));
    check();
    expect(adopted.at(-1)).toBe('mine');

    // A new session appears in WSL: it takes over immediately.
    session(wsl, 'fresh');
    check();
    expect(adopted.at(-1)).toBe('fresh');
    src.stop();
  });

  it('switches to another active session once the shown one has been quiet for a minute', () => {
    const win = path.join(tmp, 'win'), wsl = path.join(tmp, 'wsl');
    session(win, 'quiet', 0);
    session(wsl, 'busy', 10_000);
    const { src, adopted, check } = follower([win, wsl]);
    src.start();
    expect(adopted.at(-1)).toBe('quiet');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(win, 'proj', 'quiet.jsonl'), old, old);
    fs.appendFileSync(path.join(wsl, 'proj', 'busy.jsonl'), line('busy'));
    check();
    expect(adopted.at(-1)).toBe('busy');
    src.stop();
  });
});
