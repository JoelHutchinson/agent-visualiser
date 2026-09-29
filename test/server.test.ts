import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type Server } from '../src/daemon/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vis-srv-'));
const web = path.join(tmp, 'web');
const packs = path.join(tmp, 'packs');
let server: Server;
let bare: Server;

beforeAll(async () => {
  fs.mkdirSync(path.join(packs, 'office'), { recursive: true });
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), 'web');
  fs.writeFileSync(path.join(packs, 'office', 'pack.json'), '{"name":"office"}');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside both roots');
  fs.writeFileSync(path.join(web, 'packs-lookalike.txt'), 'web file');
  server = await startServer({ port: 0, webDir: web, packsDir: packs, snapshot: () => ({ kind: 'waiting' }) });
  bare = await startServer({ port: 0, webDir: web, snapshot: () => ({ kind: 'waiting' }) });
});
afterAll(async () => {
  await server.close();
  await bare.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Raw path so the client does not normalise "../" away before the server sees it.
const get = (port: number, rawPath: string) =>
  new Promise<{ status: number; body: string; type?: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, body, type: res.headers['content-type'] }));
      })
      .on('error', reject);
  });

describe('static server', () => {
  it('serves the front end', async () => {
    expect(await get(server.port, '/')).toMatchObject({ status: 200, body: 'web' });
  });

  it('serves /packs/* from the packs directory (not from the web root)', async () => {
    expect(await get(server.port, '/packs/office/pack.json')).toMatchObject({ status: 200, body: '{"name":"office"}', type: 'application/json' });
    expect((await get(server.port, '/packs/missing.json')).status).toBe(404);
    expect((await get(server.port, '/packs/packs-lookalike.txt')).status).toBe(404);
  });

  it('404s /packs/* when there is no packs directory', async () => {
    expect((await get(bare.port, '/packs/office/pack.json')).status).toBe(404);
  });

  it.each(['/packs/../secret.txt', '/packs/%2e%2e/secret.txt', '/packs/%2e%2e%2fsecret.txt', '/packs/office/../../secret.txt', '/packs/..%5csecret.txt'])(
    'blocks path traversal out of the packs directory: %s',
    async (p) => {
      const r = await get(server.port, p);
      expect(r.body).not.toContain('outside both roots');
      expect([403, 404]).toContain(r.status);
    },
  );

  it('blocks traversal from the web root too, and rejects malformed escapes', async () => {
    const r = await get(server.port, '/%2e%2e/secret.txt');
    expect(r.body).not.toContain('outside both roots');
    expect((await get(server.port, '/packs/%E0%A4%A')).status).toBe(400);
  });
});
