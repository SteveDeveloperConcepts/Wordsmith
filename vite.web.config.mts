// Builds the same UI as a plain web app (no Electron). Used for browser previews
// during development and for hosting Wordsmith as a static site.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: dir('./src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@engine': dir('./src/engine'),
      '@shared': dir('./src/shared'),
      '@renderer': dir('./src/renderer/src'),
    },
  },
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['harper.js'] },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: dir('./dist-web'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
