import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  resolve: { preserveSymlinks: true },
  build: { outDir: '../dist/web', emptyOutDir: true },
  // For `npm run dev:web` against a running daemon.
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:4580', ws: true } } },
});
