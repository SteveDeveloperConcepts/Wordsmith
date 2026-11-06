import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': dir('./src/engine'),
      '@shared': dir('./src/shared'),
      '@renderer': dir('./src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
