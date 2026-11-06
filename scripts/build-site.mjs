// Builds what GitHub Pages serves: the web app at the root and the Office add-in under /office/.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const build = (config) => execFileSync(process.execPath, [vite, 'build', '--config', config], { cwd: ROOT, stdio: 'inherit' });

const site = join(ROOT, 'dist-site');
rmSync(site, { recursive: true, force: true });

build('vite.web.config.mts');
build('vite.addin.config.mts');

cpSync(join(ROOT, 'dist-web'), site, { recursive: true });
cpSync(join(ROOT, 'dist-addin'), join(site, 'office'), { recursive: true });

if (!existsSync(join(site, 'office', 'manifest-outlook.xml'))) throw new Error('The add-in build produced no Outlook manifest.');
console.log(`Site ready in ${site}`);
