import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

const packsDir = fileURLToPath(new URL('./packs', import.meta.url));

/**
 * Serves the repo's gitignored packs/ folder at /packs, the way the daemon
 * does, so licensed art (LimeZu) works in `dev:web` and `vite preview`. The
 * packs are never part of the build output.
 */
function servePacks(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(packsDir, rel);
    if (!file.startsWith(packsDir + path.sep) || path.extname(file) !== '.png') return next();
    fs.readFile(file, (err, data) => {
      if (err) return next();
      res.setHeader('content-type', 'image/png');
      res.end(data);
    });
  };
  return {
    name: 'serve-packs',
    configureServer: (server) => void server.middlewares.use('/packs', handler),
    configurePreviewServer: (server) => void server.middlewares.use('/packs', handler),
  };
}

export default defineConfig({
  root: 'web',
  plugins: [vue(), servePacks()],
  resolve: { preserveSymlinks: true },
  build: { outDir: '../dist/web', emptyOutDir: true },
  // For `npm run dev:web` against a running daemon.
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:4580', ws: true } } },
});
