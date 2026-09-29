import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerMessage } from '../shared/events.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface Server {
  broadcast(msg: ServerMessage): void;
  close(): Promise<void>;
  port: number;
}

/** Serves the built front end and a websocket on one port, bound to loopback. */
export function startServer(opts: {
  port: number;
  webDir: string;
  snapshot: () => ServerMessage;
}): Promise<Server> {
  const webRoot = path.resolve(opts.webDir);

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(webRoot, '.' + rel);
    if (!file.startsWith(webRoot + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => ws.send(JSON.stringify(opts.snapshot())));

  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  };

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, '127.0.0.1', () => {
      const addr = httpServer.address();
      resolve({
        broadcast,
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        close: () =>
          new Promise((done) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}
