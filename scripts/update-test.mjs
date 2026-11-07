// Proves the whole update path on Windows: installs an old version, serves a newer one
// from a local server, lets the app download it, presses Restart now, and checks the new
// version is what runs afterwards. A broken updater strands every installed copy, and no
// later release can reach them to fix it, so this runs before anything ships.
//
// It really installs the app, so it only runs in CI: npm run test:update
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

if (process.platform !== 'win32' || !process.env.CI) {
  console.error('This installs Wordsmith on the machine it runs on, so it only runs on Windows in CI.');
  process.exit(1);
}

// In GitHub Actions, a failure shows on the run's summary, where it can be read without signing in.
process.on('uncaughtException', (err) => {
  const text = String(err.stack ?? err).slice(0, 1500).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  console.log(`::error title=The update test failed::${text}`);
  process.exit(1);
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '0.0.1';
const NEW = '0.0.2';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const work = mkdtempSync(join(tmpdir(), 'wordsmith-update-'));
const installed = join(work, 'installed');
const app = join(installed, 'Wordsmith.exe');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Null while the installer is swapping the files. */
function installedVersion() {
  try {
    const packageFile = asar.extractFile(join(installed, 'resources', 'app.asar'), 'package.json');
    return JSON.parse(packageFile.toString()).version;
  } catch {
    return null;
  }
}

function buildInstaller(version) {
  const output = `release/update-test/${version}`;
  const builder = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  execFileSync(
    process.execPath,
    [builder, '--win', '--x64', '--publish', 'never', `-c.extraMetadata.version=${version}`, `-c.directories.output=${output}`],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return join(ROOT, output);
}

function serve(folder) {
  const server = createServer((request, response) => {
    const file = join(folder, decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200);
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const launch = (profile) => _electron.launch({ executablePath: app, args: [`--user-data-dir=${profile}`] });

console.log('Building both versions');
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
});
const oldBuild = buildInstaller(OLD);
const newBuild = buildInstaller(NEW);

console.log(`Installing ${OLD}`);
const install = spawnSync(join(oldBuild, `Wordsmith-Setup-${OLD}.exe`), ['/S', `/D=${installed}`], { stdio: 'inherit' });
if (install.status !== 0 || !existsSync(app)) throw new Error(`The installer failed with status ${install.status}.`);
if (installedVersion() !== OLD) throw new Error(`Installed ${installedVersion()}, not ${OLD}.`);

// The installed copy looks here instead of at GitHub. Everything else is the shipped code.
const server = await serve(newBuild);
writeFileSync(
  join(installed, 'resources', 'app-update.yml'),
  `provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: wordsmith-updater\n`,
);

console.log('Starting the old version');
const running = await launch(join(work, 'profile'));
const exited = new Promise((resolve) => running.process().once('exit', resolve));
const page = await running.firstWindow();
await page.waitForFunction(() => document.querySelector('.statusbar__state')?.textContent === 'All checked', null, {
  timeout: 60_000,
});
// The hidden quick window must exist by now, because it is what could keep the app from quitting.
await sleep(5000);

console.log('Checking for updates');
const found = await page.evaluate(() => window.wordsmith.checkForUpdates());
if (found.status !== 'downloading' && found.status !== 'ready') throw new Error(`The check said: ${JSON.stringify(found)}`);
await page.waitForSelector('.update-banner', { timeout: 180_000 });
const banner = await page.textContent('.update-banner');
if (!banner.includes(NEW)) throw new Error(`The banner said: ${banner}`);

console.log('Restarting to install');
await page.click('.update-banner button:has-text("Restart now")');
const quit = await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)]);
if (!quit) throw new Error('The app did not quit to install the update.');

const deadline = Date.now() + 180_000;
while (installedVersion() !== NEW) {
  if (Date.now() > deadline) throw new Error(`Still on ${installedVersion()} after three minutes.`);
  await sleep(2000);
}
console.log(`Installed version is now ${installedVersion()}`);

// The installer starts the new version by itself. Close that one, so this run has it to itself.
await sleep(5000);
spawnSync('taskkill', ['/F', '/IM', 'Wordsmith.exe']);
await sleep(2000);

console.log('Starting the new version');
const updated = await launch(join(work, 'profile'));
const updatedPage = await updated.firstWindow();
await updatedPage.waitForFunction(() => document.querySelector('.statusbar__state')?.textContent === 'All checked', null, {
  timeout: 60_000,
});
const { version } = await updatedPage.evaluate(() => window.wordsmith.info());
if (version !== NEW) throw new Error(`The running app says it is ${version}.`);
await updated.evaluate(({ app: electronApp }) => electronApp.exit(0));

server.close();
console.log(`Passed: ${OLD} updated itself to ${NEW}, and the new version runs and checks text.`);
process.exit(0);
