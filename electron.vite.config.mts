import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const alias = {
  '@engine': dir('./src/engine'),
  '@shared': dir('./src/shared'),
  '@renderer': dir('./src/renderer/src'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    // Bundle dependencies into the main-process file so the packaged app ships no node_modules.
    build: { externalizeDeps: false },
  },
  preload: {
    resolve: { alias },
    // A sandboxed preload must be one self-contained file.
    build: { externalizeDeps: false, isolatedEntries: true },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    worker: { format: 'es' },
    // Harper locates its WebAssembly file relative to its own module, which pre-bundling would break.
    optimizeDeps: { exclude: ['harper.js'] },
    build: { target: 'chrome130', chunkSizeWarningLimit: 4000 },
  },
});
