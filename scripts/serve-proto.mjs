// Serves the repo root so the prototypes in proto/ can load vendor/ art.
// Usage: npm run proto  →  http://127.0.0.1:4591/proto/pixel/
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT ?? 4591);
const types = { '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.md': 'text/plain' };

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(data);
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`Prototypes:\n  pixel  http://127.0.0.1:${port}/proto/pixel/\n  3d     http://127.0.0.1:${port}/proto/3d/`);
  });
