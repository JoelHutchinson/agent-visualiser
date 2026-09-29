import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Keep paths as given; realpath can point outside the sandbox on Windows.
  resolve: { preserveSymlinks: true },
  test: { include: ['test/**/*.test.ts'], testTimeout: 15000 },
});
