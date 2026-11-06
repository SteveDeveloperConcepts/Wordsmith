// Builds the Office add-in: a static task pane plus the two manifests that point at it.
// Office fetches the page from the URL in the manifest, so that URL is fixed at build
// time. Set ADDIN_BASE_URL to host the pane somewhere else.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const DEFAULT_BASE_URL = 'https://stevedeveloperconcepts.github.io/Wordsmith/office/';
const MANIFESTS = ['manifest-office.xml', 'manifest-outlook.xml'];

function baseUrl(): URL {
  const value = process.env.ADDIN_BASE_URL || DEFAULT_BASE_URL;
  return new URL(value.endsWith('/') ? value : `${value}/`);
}

function manifests(): Plugin {
  return {
    name: 'wordsmith-addin-manifests',
    generateBundle() {
      const base = baseUrl();
      for (const fileName of MANIFESTS) {
        const template = readFileSync(dir(`./src/addin/manifest/${fileName}`), 'utf8');
        this.emitFile({
          type: 'asset',
          fileName,
          source: template.replaceAll('__ADDIN_BASE_URL__', base.href).replaceAll('__ADDIN_ORIGIN__', base.origin),
        });
      }
    },
  };
}

export default defineConfig({
  root: dir('./src/addin'),
  base: './',
  // The icons have to sit next to the page, at the URLs the manifests name.
  publicDir: dir('./src/addin/assets'),
  resolve: {
    alias: {
      '@engine': dir('./src/engine'),
      '@shared': dir('./src/shared'),
      '@renderer': dir('./src/renderer/src'),
    },
  },
  plugins: [react(), manifests()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['harper.js'] },
  preview: { port: 5331, strictPort: true },
  build: {
    outDir: dir('./dist-addin'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: dir('./src/addin/taskpane.html') },
  },
});
