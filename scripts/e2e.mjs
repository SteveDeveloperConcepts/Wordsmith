// End-to-end test of the real desktop app, through the same app:// protocol and
// security policy as a packaged build.
//
//   npm run test:e2e                  the built app in out/ (run "npm run build" first)
//   npm run test:e2e -- --packaged    the packaged app in release/ (run "npm run dist:dir" first)
//   npm run test:e2e -- --anywhere    also test Check Anywhere (Windows only). This opens two small
//                                     windows of its own, and types Ctrl+C and Ctrl+V into them.
//
// Nothing here touches the writer's own documents: every run uses a temporary profile.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED = process.argv.includes('--packaged');
const ANYWHERE = process.argv.includes('--anywhere');
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron');
const PACKAGED_APP =
  process.platform === 'win32'
    ? join(ROOT, 'release', 'win-unpacked', 'Wordsmith.exe')
    : join(ROOT, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Wordsmith.app', 'Contents', 'MacOS', 'Wordsmith');

const work = mkdtempSync(join(tmpdir(), 'wordsmith-e2e-'));
const profile = join(work, 'profile');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
async function test(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${err.message?.split('\n').join('\n        ')}`);
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function launch() {
  const args = [`--user-data-dir=${profile}`];
  return _electron.launch({
    cwd: ROOT,
    executablePath: PACKAGED ? PACKAGED_APP : ELECTRON,
    args: PACKAGED ? args : ['.', ...args],
    // Keeps AI tests off the real service, whatever key they use.
    env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
  });
}

const problems = [];
function watch(page) {
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' || /Content Security Policy/i.test(text)) problems.push(text);
  });
  page.on('pageerror', (err) => problems.push(String(err)));
}

async function ready(app) {
  const page = await app.firstWindow();
  watch(page);
  await page.waitForFunction(() => document.querySelector('.statusbar__state')?.textContent === 'All checked', null, {
    timeout: 45_000,
  });
  return page;
}

/** Choose a menu item, as a person would. */
const chooseMenu = (app, label) =>
  app.evaluate(({ Menu }, wanted) => {
    const find = (items) => {
      for (const item of items) {
        if (item.label === wanted) return item;
        const inner = item.submenu && find(item.submenu.items);
        if (inner) return inner;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error(`No menu item called ${wanted}`);
    item.click();
  }, label);

const answerSaveDialog = (app, filePath) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, filePath);

const answerOpenDialog = (app, filePaths) =>
  app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
  }, filePaths);

async function waitForFile(path, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await sleep(100);
  }
  await sleep(150);
  return readFileSync(path);
}

/* ---------- One session ---------- */

console.log(`\nWordsmith end-to-end test (${PACKAGED ? 'packaged app' : 'built app'})\n`);

let app = await launch();
let page = await ready(app);

await test('the window is sandboxed', async () => {
  const seen = await page.evaluate(() => ({
    bridge: typeof window.wordsmith,
    require: typeof window.require,
    process: typeof window.process,
    url: location.href,
  }));
  check(seen.bridge === 'object', 'window.wordsmith is missing');
  check(seen.require === 'undefined', 'the page can reach require');
  check(seen.process === 'undefined', 'the page can reach process');
  check(seen.url.startsWith('app://wordsmith/'), `the page is at ${seen.url}`);
});

await test('the engine runs under the strict security policy', async () => {
  const underlines = await page.locator('[data-issue]').count();
  check(underlines > 5, `only ${underlines} underlines`);
  check(problems.length === 0, `console errors: ${problems.join(' | ')}`);
});

await test('fonts load', async () => {
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((font) => font.status === 'loaded').length;
  });
  check(loaded > 0, 'no fonts loaded');
});

await test('the shell reports its version', async () => {
  const info = await page.evaluate(() => window.wordsmith.info());
  check(/^\d+\.\d+\.\d+/.test(info.version), `version ${info.version}`);
  check(info.platform === process.platform, `platform ${info.platform}`);
});

await test('exports write real files', async () => {
  const exports = [
    ['Word Document (.docx)…', 'out.docx', (data) => data.subarray(0, 2).toString() === 'PK' && data.includes('word/document.xml')],
    ['PDF…', 'out.pdf', (data) => data.subarray(0, 5).toString() === '%PDF-'],
    ['Web Page (.html)…', 'out.html', (data) => data.toString().includes('Welcome to Wordsmith')],
    ['Markdown (.md)…', 'out.md', (data) => data.toString().startsWith('# Welcome to Wordsmith')],
    ['Plain Text (.txt)…', 'out.txt', (data) => data.toString().includes('Welcome to Wordsmith')],
  ];
  for (const [label, name, valid] of exports) {
    const path = join(work, name);
    await answerSaveDialog(app, path);
    await chooseMenu(app, label);
    check(valid(await waitForFile(path)), `${name} is not valid`);
  }
});

await test('a Word document imports as a new document', async () => {
  await answerOpenDialog(app, [join(work, 'out.docx')]);
  const before = await page.locator('.doc').count();
  await chooseMenu(app, 'Import…');
  await page
    .waitForFunction((count) => document.querySelectorAll('.doc').length === count + 1, before, { timeout: 15_000 })
    .catch(async () => {
      throw new Error(`no new document. The app said: ${await page.locator('.toast').allTextContents()}`);
    });
  const title = await page.inputValue('.title-input');
  check(title === 'out', `the title is ${title}`);
  check((await page.textContent('.ws-prose')).includes('proofread'), 'the text did not arrive');
});

await test('the theme setting reaches the system', async () => {
  await page.evaluate(() => window.wordsmith.setTheme('dark'));
  check(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors), 'dark did not take');
  await page.evaluate(() => window.wordsmith.setTheme('light'));
  check(!(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)), 'light did not take');
  await page.evaluate(() => window.wordsmith.setTheme('system'));
});

await test('the API key is stored encrypted', async () => {
  const key = 'sk-ant-test-not-a-real-key-1234567890';
  check(!(await page.evaluate(() => window.wordsmith.aiHasKey())), 'a key exists already');
  await page.evaluate((value) => window.wordsmith.aiSetKey(value), key);
  check(await page.evaluate(() => window.wordsmith.aiHasKey()), 'the key was not saved');
  const file = readFileSync(join(profile, 'wordsmith-settings.json'), 'utf8');
  check(!file.includes(key), 'the key is on disk in plain text');
});

await test('an unreachable service gives a friendly error, not a crash', async () => {
  const event = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const stop = window.wordsmith.onAiEvent((message) => {
          if (message.id !== 'e2e' || message.type === 'text') return;
          stop();
          resolve(message);
        });
        void window.wordsmith.aiStart('e2e', 'claude-opus-5-5', {
          kind: 'rewrite',
          text: 'Hello there.',
          instruction: 'Shorten it.',
          goals: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' },
          dialect: 'american',
        });
      }),
  );
  check(event.type === 'error', `got ${JSON.stringify(event)}`);
  check(event.error.code === 'network', `the error was ${event.error.code}`);
});

await test('removing the key works, and no key says so', async () => {
  await page.evaluate(() => window.wordsmith.aiClearKey());
  check(!(await page.evaluate(() => window.wordsmith.aiHasKey())), 'the key is still there');
  const code = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const stop = window.wordsmith.onAiEvent((message) => {
          if (message.id !== 'nokey' || message.type !== 'error') return;
          stop();
          resolve(message.error.code);
        });
        void window.wordsmith.aiStart('nokey', 'claude-opus-5-5', {
          kind: 'reader',
          reader: 'a teammate',
          document: 'Hello.',
        });
      }),
  );
  check(code === 'no-key', `the error was ${code}`);
});

await test('a downloaded update is offered, and can wait', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.isVisible());
    main.webContents.send('update:changed', { version: '9.9.9' });
  });
  await page.waitForSelector('.update-banner', { timeout: 5000 });
  check((await page.textContent('.update-banner')).includes('9.9.9'), 'the banner does not name the version');
  await page.click('.update-banner button:has-text("Later")');
  check((await page.locator('.update-banner').count()) === 0, 'Later did not hide the banner');
});

await test('checking for updates gives an answer', async () => {
  const { status } = await page.evaluate(() => window.wordsmith.checkForUpdates());
  const expected = PACKAGED ? ['latest', 'failed', 'downloading', 'ready'] : ['unavailable'];
  check(expected.includes(status), `the check said ${status}`);
});

await test('window size and documents survive a restart', async () => {
  const size = { width: 1240, height: 700 };
  await app.evaluate(({ BrowserWindow }, wanted) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.isVisible());
    main.setSize(wanted.width, wanted.height);
  }, size);
  await sleep(300);
  await page.locator('.ws-prose').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' A sentence typed before restarting.');
  await sleep(1200);
  const documents = await page.locator('.doc').count();

  await page.evaluate(() => window.wordsmith.setAnywhere({ enabled: false }));
  await app.close();
  app = await launch();
  page = await ready(app);

  const seen = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.isVisible());
    return main.getSize();
  });
  check(seen[0] === size.width && seen[1] === size.height, `the window came back at ${seen}`);
  check((await page.locator('.doc').count()) === documents, 'documents were lost');
  check((await page.textContent('.ws-prose')).includes('typed before restarting'), 'the new text was lost');
});

await test('the page cannot navigate away or open windows', async () => {
  const windows = app.windows().length;
  await page.evaluate(() => {
    window.open('https://example.com/');
    location.href = 'https://example.com/';
  });
  await sleep(800);
  check(page.url().startsWith('app://wordsmith/'), `navigated to ${page.url()}`);
  check(app.windows().length === windows, 'a window opened');
});

await test('closing the window quits when nothing needs the app running', async () => {
  const closed = new Promise((resolve) => app.process().once('exit', () => resolve(true)));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.isVisible())
      .close();
  });
  const quit = await Promise.race([closed, sleep(8000).then(() => false)]);
  check(quit, 'the process is still running');
});

/* ---------- Check Anywhere ---------- */

if (ANYWHERE && process.platform === 'win32') {
  const TARGET_SCRIPT = `param([string]$OutFile, [string]$StopFile, [string]$Text, [string]$Select)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Wordsmith test target'
$form.TopMost = $true
$form.Width = 700
$form.Height = 240
$form.StartPosition = 'CenterScreen'
$box = New-Object System.Windows.Forms.RichTextBox
$box.Dock = 'Fill'
$box.HideSelection = $false
$box.Text = $Text
$form.Controls.Add($box)
$form.Add_Shown({ $form.Activate(); $box.Focus() | Out-Null; $box.Select($box.Text.IndexOf($Select), $Select.Length) })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({ [IO.File]::WriteAllText($OutFile, $box.Text); if (Test-Path $StopFile) { $form.Close() } })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`;

  const RICH_TARGET = `const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const [outFile, stopFile] = process.argv.slice(-2);
app.setPath('userData', outFile + '.profile');
const page = \`<!doctype html><meta charset=utf-8><title>Rich target</title>
<div id=e contenteditable style="min-height:150px;padding:10px;font:16px Calibri,sans-serif">
<p>Keep this <b>bold</b> line. <span id=a>Their</span> is <b>alot</b> of <a href="https://example.com/">mistaks</a> <span id=z>here.</span> Keep this too.</p>
<p>Another paragraph stays.</p></div>
<script>
  const e = document.getElementById('e');
  e.focus();
  const r = document.createRange();
  r.setStartBefore(document.getElementById('a').firstChild);
  r.setEndAfter(document.getElementById('z').firstChild);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
</script>\`;
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 700, height: 260, alwaysOnTop: true });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  setInterval(async () => {
    if (fs.existsSync(stopFile)) app.quit();
    try { fs.writeFileSync(outFile, await win.webContents.executeJavaScript('document.getElementById("e").innerHTML')); } catch {}
  }, 100);
});
`;

  const launchQuick = async () => {
    app = await launch();
    page = await ready(app);
    await page.evaluate(() => window.wordsmith.setAnywhere({ enabled: true }));
    await sleep(500);
  };

  const openQuick = async () => {
    await chooseMenu(app, 'Check Text in Another App');
    let quick = null;
    for (let i = 0; i < 100 && !quick; i++) {
      quick = app.windows().find((window) => window.url().includes('view=quick')) ?? null;
      await sleep(100);
    }
    check(quick, 'the quick window did not open');
    watch(quick);
    await quick.waitForSelector('.quick__footer', { timeout: 15_000 });
    await quick.waitForFunction(() => document.querySelector('.quick__count')?.textContent?.includes('suggestion'), null, {
      timeout: 30_000,
    });
    return quick;
  };

  /** Fix everything, press Replace, and wait for the target app to report the change. */
  const fixAndReplace = async (quick, out, changed) => {
    await quick.click('button:has-text("Fix ")');
    await sleep(500);
    await quick.click('button:has-text("Replace in")');
    const deadline = Date.now() + 6000;
    while (!changed(readFileSync(out, 'utf8'))) {
      if (Date.now() > deadline) {
        const said = await quick.locator('.quick__problem').allTextContents();
        throw new Error(`nothing changed in the target app. The quick window said: ${said.join(' ') || 'nothing'}`);
      }
      await sleep(100);
    }
    // The clipboard goes back a little over a second after the paste.
    await sleep(1800);
  };

  await launchQuick();
  const documentsBefore = await page.locator('.doc').count();

  await test('Check Anywhere: plain text in another app is corrected in place', async () => {
    const out = join(work, 'plain.out');
    const stop = join(work, 'plain.stop');
    const script = join(work, 'target.ps1');
    writeFileSync(script, TARGET_SCRIPT);
    const text = 'Keep this line. Their is alot of mistaks in this sentense. Keep this too.';
    const select = 'Their is alot of mistaks in this sentense.';
    const target = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, out, stop, text, select], {
      stdio: 'ignore',
    });
    try {
      await waitForFile(out);
      await sleep(900);
      const quick = await openQuick();
      check((await quick.textContent('.ws-prose')) === select, 'the wrong text arrived');
      await fixAndReplace(quick, out, (now) => !now.includes('Their'));
      const after = readFileSync(out, 'utf8');
      check(after === 'Keep this line. There is a lot of mistakes in this sentence. Keep this too.', `the app now says: ${after}`);
    } finally {
      writeFileSync(stop, '1');
      await sleep(300);
      target.kill();
    }
  });

  await test('Check Anywhere: formatting survives, and the clipboard is put back', async () => {
    const out = join(work, 'rich.out');
    const stop = join(work, 'rich.stop');
    const dir = join(work, 'rich-target');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main.js'), RICH_TARGET);
    writeFileSync(join(dir, 'package.json'), '{ "name": "rich-target", "version": "0.0.0", "main": "main.js" }');
    await app.evaluate(({ clipboard }) => clipboard.writeText('what the writer copied earlier'));
    const target = spawn(ELECTRON, [dir, out, stop], { stdio: 'ignore' });
    try {
      await waitForFile(out);
      await sleep(1000);
      const quick = await openQuick();
      await fixAndReplace(quick, out, (now) => !now.includes('mistaks'));
      const after = readFileSync(out, 'utf8').replace(/\s+/g, ' ');
      check(after.includes('<b>a lot</b>'), `bold was lost: ${after}`);
      check(after.includes('<a href="https://example.com/">mistakes</a>'), `the link was lost: ${after}`);
      check(/Keep this <b>bold<\/b> line\./.test(after) && after.includes('Another paragraph stays.'), `other text changed: ${after}`);
      check((after.match(/<p>/g) ?? []).length === 2, `a paragraph was split: ${after}`);
      const clipboard = await app.evaluate(({ clipboard: board }) => board.readText());
      check(clipboard === 'what the writer copied earlier', `the clipboard now holds: ${clipboard}`);
    } finally {
      writeFileSync(stop, '1');
      await sleep(400);
      target.kill();
    }
  });

  await test('Check Anywhere: what it checks stays out of the document library', async () => {
    await page.reload();
    await ready(app);
    const stored = await page.locator('.doc').count();
    check(stored === documentsBefore, `the library went from ${documentsBefore} to ${stored} documents`);
  });

  await test('Check Anywhere: the app stays in the tray after its window closes', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().includes('view=quick'))
        .close();
    });
    await sleep(1500);
    check(app.process().exitCode === null, 'the app quit');
  });

  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await sleep(1200);
}

/* ---------- Summary ---------- */

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
if (problems.length > 0) console.log(`Console errors:\n  ${[...new Set(problems)].join('\n  ')}`);
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  // Windows can hold the profile open for a moment after exit; it is only a temp folder.
}
process.exit(failed.length > 0 ? 1 : 0);
