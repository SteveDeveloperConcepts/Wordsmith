// Builds the browser extension into dist-extension/, a folder Chrome and Edge can
// load unpacked. Pages, the service worker, and the engine worker build together.
// The content script builds on its own, because a declared content script must be
// one classic script with no imports.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin } from 'vite';
import { renderIcon } from './src/extension/build/icons';
import { buildManifest, ICON_SIZES } from './src/extension/manifest';

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const outDir = dir('./dist-extension');
const target = 'es2022';

const alias = {
  '@engine': dir('./src/engine'),
  '@shared': dir('./src/shared'),
  '@renderer': dir('./src/renderer/src'),
};

function extensionFiles(): Plugin {
  return {
    name: 'wordsmith-extension-files',
    apply: 'build',
    generateBundle() {
      const { version } = JSON.parse(readFileSync(dir('./package.json'), 'utf8')) as { version: string };
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(buildManifest(version), null, 2)}\n`,
      });
      for (const size of ICON_SIZES) {
        this.emitFile({ type: 'asset', fileName: `icons/icon-${size}.png`, source: renderIcon(size) });
      }
    },
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { alias },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target,
          lib: {
            entry: dir('./src/extension/content/index.ts'),
            formats: ['iife'],
            name: 'wordsmithContent',
            fileName: () => 'content.js',
          },
        },
      });
    },
  };
}

export default defineConfig({
  root: dir('./src/extension'),
  base: './',
  publicDir: false,
  resolve: { alias },
  plugins: [extensionFiles()],
  worker: { format: 'es' },
  build: {
    outDir,
    emptyOutDir: true,
    target,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: {
        background: dir('./src/extension/background/index.ts'),
        popup: dir('./src/extension/popup/popup.html'),
        offscreen: dir('./src/extension/offscreen/offscreen.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
