// Drives the built extension in a real Chromium against local pages that imitate
// webmail compose bodies. It never touches a real mail site. Branded Chrome no longer
// side-loads from the command line, so this uses Playwright's own Chromium. Edge still does:
// set WORDSMITH_BROWSER=msedge to run the same checks in the installed Edge.
//
//   node tests/extension/browser/run.mjs [only-this-scenario]
//
// Screenshots go to the folder named by WORDSMITH_SHOTS, or a temp folder.
// Set WORDSMITH_HEADED=1 to watch it run.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const pagesDir = join(repo, 'tests/extension/pages');
const PORT = 5341;
const BASE = `http://localhost:${PORT}`;
const only = process.argv[2];

const work = mkdtempSync(join(tmpdir(), 'wordsmith-extension-'));
const shots = process.env.WORDSMITH_SHOTS ?? join(tmpdir(), 'wordsmith-extension-shots');
mkdirSync(shots, { recursive: true });

function buildExtension() {
  const vite = join(repo, 'node_modules/vite/bin/vite.js');
  execFileSync(
    process.execPath,
    [vite, 'build', '--config', 'vite.extension.config.mts', '--configLoader', 'runner', '--logLevel', 'warn'],
    { cwd: repo, stdio: 'inherit' },
  );

  // The test host goes in a copy, so the shipped manifest never carries it. 127.0.0.1 stands
  // in for a site the writer granted: it has a host permission but no declared content script.
  const copy = join(work, 'extension');
  cpSync(join(repo, 'dist-extension'), copy, { recursive: true });
  const path = join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*');
  manifest.content_scripts[0].matches.push('http://localhost/*');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return copy;
}

async function bundleProseMirror() {
  const { build } = await import('vite');
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: join(work, 'bundle'),
      emptyOutDir: true,
      lib: { entry: join(pagesDir, 'prosemirror.ts'), formats: ['es'], fileName: () => 'prosemirror.js' },
    },
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

// As strict as webmail or stricter, so anything the extension does that a page's policy can block shows up here.
const STRICT_POLICY = "default-src 'none'; require-trusted-types-for 'script'";

function serve() {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, BASE);
    const path = pathname.startsWith('/bundle/') ? join(work, pathname) : join(pagesDir, pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
    } else if (!resolve(path).startsWith(resolve(work)) && !resolve(path).startsWith(resolve(pagesDir))) {
      response.writeHead(403).end();
    } else if (existsSync(path)) {
      const headers = { 'content-type': TYPES[extname(path)] ?? 'text/plain' };
      if (pathname === '/strict.html') headers['content-security-policy'] = STRICT_POLICY;
      response.writeHead(200, headers).end(readFileSync(path));
    } else {
      response.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(PORT, () => done(server)));
}

const failures = [];
let passed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`);
  }
}

/** Every underlined piece of text on the page, by highlight name. */
const underlines = (page) =>
  page.evaluate(() => {
    const result = {};
    for (const [name, highlight] of CSS.highlights) {
      if (name.startsWith('wordsmith-')) result[name.slice(10)] = [...highlight].map((range) => range.toString());
    }
    return result;
  });

const allUnderlined = async (page) => Object.values(await underlines(page)).flat();

async function waitForUnderline(page, text, timeout = 15_000) {
  await page.waitForFunction(
    (wanted) =>
      [...CSS.highlights].some(
        ([name, highlight]) =>
          name.startsWith('wordsmith-') && [...highlight].some((range) => range.toString() === wanted),
      ),
    text,
    { timeout },
  );
}

async function waitForNoUnderline(page, text, timeout = 8_000) {
  await page.waitForFunction(
    (gone) =>
      ![...CSS.highlights].some(
        ([name, highlight]) =>
          name.startsWith('wordsmith-') && [...highlight].some((range) => range.toString() === gone),
      ),
    text,
    { timeout },
  );
}

/** Where an underlined word is on screen. */
const pointOn = (page, text) =>
  page.evaluate((wanted) => {
    for (const [name, highlight] of CSS.highlights) {
      if (!name.startsWith('wordsmith-')) continue;
      for (const range of highlight) {
        if (range.toString() !== wanted) continue;
        const rect = range.getClientRects()[0];
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }, text);

/**
 * How many pixels in a box are close to a color, read from a real screenshot. The
 * highlight registry only says what was asked for; this says what got drawn.
 */
async function paintedPixels(page, box, color) {
  const png = await page.screenshot({ clip: box });
  // Decoded in a blank page, because the page under test may forbid data: images.
  const scratch = await page.context().newPage();
  const count = await scratch.evaluate(
    async ([data, wanted]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const target = [1, 3, 5].map((i) => parseInt(wanted.slice(i, i + 2), 16));
      const { data: pixels } = context.getImageData(0, 0, image.width, image.height);
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (target.every((value, channel) => Math.abs(pixels[i + channel] - value) < 60)) count++;
      }
      return count;
    },
    [png.toString('base64'), color],
  );
  await scratch.close();
  await page.bringToFront();
  return count;
}

/** The strip below an underlined word, where its line is drawn. */
const stripUnder = (page, text, name = 'wordsmith-correctness') =>
  page.evaluate(
    ([wanted, highlightName]) => {
      const range = [...CSS.highlights.get(highlightName)].find((r) => !wanted || r.toString() === wanted);
      const rect = range.getClientRects()[0];
      return { x: rect.left, y: rect.bottom - 4, width: rect.width, height: 8 };
    },
    [text, name],
  );

const RED = '#e04a50';
const BLUE = '#2f7df0';

const card = (page) => page.locator('wordsmith-overlay .card');
const badge = (page) => page.locator('wordsmith-overlay .badge');

async function openCard(page, text) {
  await page.mouse.move(2, 2);
  const point = await pointOn(page, text);
  await page.mouse.move(point.x, point.y);
  await card(page).waitFor({ timeout: 4_000 });
}

/** End of the first line, which is above the signature and the thread. */
async function typeInFirstLine(page, text) {
  await page.click('#body .elementToProof');
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

/** Click a fix in the open card. The card closes once the fix has been applied and checked. */
async function applyFix(page, fix = card(page).locator('.card-fix').first()) {
  await fix.click();
  await card(page).waitFor({ state: 'hidden', timeout: 3_000 });
}

function watchConsole(page, log) {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') log.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => log.push(`pageerror: ${error.message}`));
}

async function openPage(context, path, log, origin = BASE) {
  const page = await context.newPage();
  watchConsole(page, log);
  await page.goto(`${origin}/${path}`);
  return page;
}

const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });

const scenarios = {
  async outlook({ context, worker, log }) {
    const page = await openPage(context, 'outlook.html', log);
    const started = Date.now();
    await page.click('#body');
    await waitForUnderline(page, 'budgett');
    console.log(`  first underline ${Date.now() - started} ms after focus, with the engine cold`);
    await shot(page, 'outlook-underlines');

    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    check('engine runs in one offscreen document', contexts.length === 1, contexts);

    const flagged = await allUnderlined(page);
    check('the writer\'s text is underlined', flagged.includes('budgett') && flagged.includes('wil'), flagged);
    const leaked = flagged.filter((text) => /Stephe|Hed|Sailes|Wordsmth|Incorported|Quartely|numbres|Pleese|befor|Oldfeld/.test(text));
    check('signature and quoted thread are not checked', leaked.length === 0, leaked);

    const before = await page.innerHTML('#body');
    check('underlines leave the DOM alone', !/wordsmith/i.test(before), before);
    const red = await paintedPixels(page, await stripUnder(page, 'budgett'), RED);
    check('an underline is drawn under the word', red > 20, red);
    const line = await paintedPixels(page, await page.evaluate(() => {
      const rect = document.querySelector('#Signature').getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }), RED);
    // A few pixels of colored text antialiasing are normal. A real underline is many more.
    check('nothing is drawn under the signature', line < 10, line);

    await openCard(page, 'budgett');
    await shot(page, 'outlook-card');
    const title = await card(page).locator('.card-title').innerText();
    check('hover opens the card', title.length > 0, title);
    check('card offers a fix', (await card(page).locator('.card-fix').count()) > 0);
    check('card offers Dismiss', await card(page).getByRole('button', { name: 'Dismiss' }).isVisible());
    check(
      'card offers Add to dictionary for spelling',
      await card(page).getByRole('button', { name: 'Add to dictionary' }).isVisible(),
    );

    await applyFix(page, card(page).locator('.card-fix', { hasText: 'budget' }).first());
    const fixed = await page.innerText('#body b');
    check('applying a fix changes the text', fixed === 'budget', fixed);
    const quoted = await page.innerText('#divRplyFwdMsg');
    check('the quoted thread is untouched', quoted.includes('Quartely numbres'), quoted);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#body b')?.textContent === 'budgett');
    check('Ctrl+Z undoes the fix', true);
    await waitForUnderline(page, 'budgett');
    check('the underline comes back after undo', true);

    await openCard(page, 'wil');
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
    await waitForNoUnderline(page, 'wil');
    await typeInFirstLine(page, ' Thanks.');
    await page.waitForTimeout(900);
    check('a dismissed issue stays dismissed', !(await allUnderlined(page)).includes('wil'));

    await openCard(page, 'budgett');
    await card(page).getByRole('button', { name: 'Add to dictionary' }).click();
    await waitForNoUnderline(page, 'budgett');
    await page.waitForTimeout(900);
    check('a dictionary word stays clear', !(await allUnderlined(page)).includes('budgett'));
    await page.keyboard.press('Escape');
    const stored = await worker.evaluate(() => chrome.storage.sync.get(null));
    check('the word is in synced storage', JSON.stringify(stored).includes('budgett'), stored);
    await worker.evaluate(() => chrome.storage.sync.clear());
    await page.close();
  },

  async selection({ context, log }) {
    const page = await openPage(context, 'selection.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'mispelled');
    await openCard(page, 'mispelled');
    await applyFix(page);
    const model = await page.evaluate(() => window.pageModel);
    check(
      'an editor tracking selectionchange gets the fix in the right place',
      model === 'This body has a misspelled word in it.',
      model,
    );
    await page.close();
  },

  async ownsItsText({ context, log }) {
    const page = await openPage(context, 'slate.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'mispelled');
    await openCard(page, 'mispelled');
    await applyFix(page);
    const model = await page.evaluate(() => window.pageModel);
    check('an editor that owns its text gets the fix through beforeinput', model.includes('misspelled'), model);
    const text = await page.innerText('#body');
    check('the page shows the fix once', text === 'This body has a misspelled word.', text);
    await page.close();
  },

  async frames({ context, log }) {
    const page = await openPage(context, 'frame.html', log);
    for (const id of ['srcdoc', 'blank']) {
      const handle = await page.$(`#${id}`);
      const frame = await handle.contentFrame();
      await frame.click(id === 'srcdoc' ? '#body' : 'body');
      await waitForUnderline(frame, 'mispelled');
      const box = await handle.boundingBox();
      const point = await pointOn(frame, 'mispelled');
      await page.mouse.move(box.x + point.x, box.y + point.y);
      await frame.locator('wordsmith-overlay .card').waitFor({ timeout: 4_000 });
      await applyFix(frame);
      const text = await frame.innerText('body');
      check(`a fix lands in the ${id} frame`, text.includes('misspelled'), text);
    }
    await shot(page, 'frames');
    await page.close();
  },

  async sentences({ context, log }) {
    const page = await openPage(context, 'textarea.html', log);
    await page.click('#area');
    await waitForUnderline(page, 'secnd');
    const marked = await underlines(page);
    check('a long sentence gets the lighter mark', (marked.sentence ?? []).length === 1, marked);
    await shot(page, 'sentence-mark');
    const dots = await paintedPixels(page, await stripUnder(page, '', 'wordsmith-sentence'), BLUE);
    check('the lighter mark is drawn', dots > 10, dots);

    const point = await pointOn(page, marked.sentence[0]);
    const clear = await page.evaluate(() => {
      const [range] = [...CSS.highlights.get('wordsmith-sentence')];
      const rect = range.getClientRects()[1];
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(clear.x, clear.y);
    await page.waitForTimeout(400);
    check('hovering a sentence does not open a card', !(await card(page).isVisible()), point);
    await page.mouse.click(clear.x, clear.y);
    await card(page).waitFor({ timeout: 2_000 });
    const title = await card(page).locator('.card-title').innerText();
    check('clicking a sentence opens its card', /sentence/i.test(title), title);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(100);
    check('clicking away closes the card', !(await card(page).isVisible()));

    await openCard(page, 'secnd');
    const inner = await card(page).locator('.card-title').innerText();
    check('a word inside a flagged sentence still opens its own card', /spelling/i.test(inner), inner);
    await page.close();
  },

  async scrolling({ context, log }) {
    const page = await openPage(context, 'outlook.html', log);
    await page.setViewportSize({ width: 1000, height: 200 });
    await page.click('#body');
    await waitForUnderline(page, 'budgett');
    await openCard(page, 'budgett');
    await page.mouse.wheel(0, 80);
    await page.waitForTimeout(200);
    check('a scroll closes the card', !(await card(page).isVisible()));
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.close();
  },

  async refused({ context, log }) {
    const page = await openPage(context, 'refuse.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'mispelled');
    await openCard(page, 'mispelled');
    await card(page).locator('.card-fix').first().click();
    await card(page).locator('.card-note').waitFor({ timeout: 2_000 });
    await page.waitForTimeout(700);
    check('the card says the page refused the change', await card(page).locator('.card-note').isVisible());
    const text = await page.innerText('#body');
    check('refused text is as it was', text === 'This body has a mispelled word.', text);
    check('the underline is back', (await allUnderlined(page)).includes('mispelled'));
    await page.close();
  },

  async strictPolicy({ context, log }) {
    const page = await openPage(context, 'strict.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'mispelled');
    await shot(page, 'strict-policy');
    const red = await paintedPixels(page, await stripUnder(page, 'mispelled'), RED);
    check('underlines are drawn under a strict policy', red > 20, red);
    await openCard(page, 'mispelled');
    const style = await card(page).evaluate((element) => getComputedStyle(element).position);
    check('the card is styled under a strict policy', style === 'fixed', style);
    await applyFix(page);
    const text = await page.innerText('#body');
    check('a fix lands under a strict policy', text.includes('misspelled'), text);
    await page.close();
  },

  async stale({ context, log }) {
    const page = await openPage(context, 'outlook.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'budgett');
    await openCard(page, 'budgett');
    // The page changes the block under the open card without a sound.
    await page.evaluate(() => {
      document.querySelector('#body b').firstChild.data = 'budgett plan';
    });
    await page.waitForTimeout(100);
    if (await card(page).isVisible()) await card(page).locator('.card-fix').first().click();
    await page.waitForTimeout(300);
    const text = await page.innerText('#body b');
    check('a fix is not applied to changed text', text === 'budgett plan', text);
    await page.close();
  },

  async gmail({ context, log }) {
    const page = await openPage(context, 'gmail.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'recieved');
    await shot(page, 'gmail-underlines-dark');
    const red = await paintedPixels(page, await stripUnder(page, 'recieved'), RED);
    check('an underline shows on a dark page', red > 20, red);
    const flagged = await allUnderlined(page);
    const leaked = flagged.filter((text) => /Stephe|Wordsmth|Incorported|Priya Sharm|Pleese|invoise|amont/.test(text));
    check('Gmail signature and quote are not checked', leaked.length === 0, leaked);

    await openCard(page, 'recieved');
    await shot(page, 'gmail-card-dark');
    const theme = await page.evaluate(() => document.querySelector('wordsmith-overlay').dataset.theme);
    check('the card follows a dark page', theme === 'dark', theme);
    await applyFix(page);
    const fixed = await page.innerText('#body');
    check('Gmail fix lands', fixed.startsWith('Hello Priya, i received the invoice'), fixed);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#body').textContent.includes('recieved'));
    check('Gmail Ctrl+Z undoes it', true);

    await page.click('.to');
    await page.waitForTimeout(200);
    check('the recipient field does not take over', await badge(page).isVisible());

    await page.fill('.subject', 'A subjct line');
    await waitForUnderline(page, 'subjct');
    check('the subject field takes over the underlines', !(await allUnderlined(page)).includes('recieved'));
    await page.click('#body');
    await waitForUnderline(page, 'recieved');
    check('returning to the body brings its underlines back', true);
    await page.close();
  },

  async prosemirror({ context, log }) {
    const page = await openPage(context, 'prosemirror.html', log);
    await page.click('.ProseMirror');
    await waitForUnderline(page, 'quik');
    await shot(page, 'prosemirror-underlines');
    await openCard(page, 'quik');
    await applyFix(page);
    const text = await page.evaluate(() => window.pageEditor.getText());
    check('ProseMirror\'s own document took the fix', text.startsWith('The quick fox'), text);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.pageEditor.getText().includes('quik'));
    check('ProseMirror undo reverts the fix', true);
    await waitForUnderline(page, 'quik');

    await waitForUnderline(page, 'mispelled');
    await openCard(page, 'mispelled');
    await applyFix(page);
    const bold = await page.evaluate(() => window.pageEditor.getHTML());
    check('a fix inside bold stays bold', /<strong>a misspelled<\/strong>/.test(bold), bold);
    await page.close();
  },

  async fields({ context, log }) {
    const page = await openPage(context, 'textarea.html', log);
    await page.click('#area');
    await waitForUnderline(page, 'sentance');
    await waitForUnderline(page, 'misake');
    await shot(page, 'textarea-mirror');
    const red = await paintedPixels(page, await stripUnder(page, 'sentance'), RED);
    check('the mirror draws an underline over a textarea', red > 20, red);
    const aligned = await page.evaluate(() => {
      const area = document.querySelector('#area');
      const [range] = [...CSS.highlights.get('wordsmith-correctness')].filter((r) => r.toString() === 'sentance');
      const style = getComputedStyle(area);
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const left = area.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      return { want: left + context.measureText('This ').width, got: range.getClientRects()[0].left };
    });
    check('the mirror lines up with a textarea\'s text', Math.abs(aligned.want - aligned.got) < 1, aligned);

    const sizes = await page.evaluate(() => {
      const area = document.querySelector('#area');
      const mirror = document.querySelector('wordsmith-overlay').shadowRoot.querySelector('.mirror');
      return { field: area.scrollHeight, copy: mirror.scrollHeight };
    });
    check('the mirror wraps like the field', Math.abs(sizes.field - sizes.copy) <= 1, sizes);

    await page.evaluate(() => {
      document.querySelector('#area').scrollTop = 40;
    });
    await page.waitForTimeout(100);
    const scrolled = await page.evaluate(() => {
      const mirror = document.querySelector('wordsmith-overlay').shadowRoot.querySelector('.mirror');
      return { field: document.querySelector('#area').scrollTop, copy: mirror.scrollTop };
    });
    check('the mirror scrolls with the field', scrolled.field === scrolled.copy, scrolled);
    await shot(page, 'textarea-scrolled');
    await page.evaluate(() => {
      document.querySelector('#area').scrollTop = 0;
    });
    await page.waitForTimeout(100);

    await openCard(page, 'sentance');
    await shot(page, 'textarea-card');
    await applyFix(page);
    const value = await page.inputValue('#area');
    check('a textarea fix lands', value.startsWith('This sentence has'), value);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#area').value.includes('sentance'));
    check('Ctrl+Z undoes a textarea fix', true);

    await page.click('#line');
    await waitForUnderline(page, 'singel');
    await shot(page, 'input-mirror');
    const lined = await page.evaluate(() => {
      const field = document.querySelector('#line');
      const [range] = [...CSS.highlights.get('wordsmith-correctness')];
      const style = getComputedStyle(field);
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const left = field.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      return { want: left + context.measureText('A ').width, got: range.getClientRects()[0].left };
    });
    check('the mirror lines up with an input\'s text', Math.abs(lined.want - lined.got) < 1, lined);
    await openCard(page, 'singel');
    await applyFix(page);
    const line = await page.inputValue('#line');
    check('an input fix lands', line === 'A single line of text', line);

    await page.evaluate(() => document.querySelector('#clipped').scrollIntoView({ block: 'center' }));
    await page.click('#clipped');
    await waitForUnderline(page, 'misake');
    await page.evaluate(() => {
      document.querySelector('.pane').scrollTop -= 50;
    });
    await page.waitForTimeout(150);
    await shot(page, 'textarea-clipped');
    const clip = await page.evaluate(
      () => document.querySelector('wordsmith-overlay').shadowRoot.querySelector('.mirror').style.clipPath,
    );
    check('a field in a scrolled pane is clipped', /inset\(/.test(clip) && clip !== 'inset(0px)', clip);
    await page.close();
  },

  async shadow({ context, log }) {
    const page = await openPage(context, 'shadow.html', log);
    await page.evaluate(() => window.pageField.focus());
    await page.waitForFunction(() => CSS.highlights.get('wordsmith-correctness')?.size > 0, null, { timeout: 15_000 });
    await shot(page, 'shadow-underline');
    const rect = await page.evaluate(() => {
      const [range] = [...CSS.highlights.get('wordsmith-correctness')];
      const { left, top, width, height } = range.getClientRects()[0];
      return { x: left + width / 2, y: top + height / 2, text: range.toString() };
    });
    check('an editor in a closed shadow root is checked', rect.text === 'mispelled', rect);
    await page.mouse.move(rect.x, rect.y);
    await card(page).waitFor({ timeout: 4_000 });
    await applyFix(page);
    const text = await page.evaluate(() => window.pageField.textContent);
    check('a fix lands in a closed shadow root', text.includes('misspelled'), text);
    await page.close();
  },

  async siteOff({ context, worker, log }) {
    const page = await openPage(context, 'outlook.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'budgett');
    await shot(page, 'badge');
    const text = await badge(page).innerText();
    check('the badge shows the count', /^W \d+$/.test(text), text);

    await badge(page).click();
    await page.locator('wordsmith-overlay .menu').waitFor();
    await shot(page, 'badge-menu');
    const notice = await page.locator('wordsmith-overlay .menu-note').isVisible();
    check('the grammar engine loaded, so no limited-checks notice shows', !notice);
    const focused = await page.evaluate(() => document.activeElement?.id);
    check('the badge leaves focus in the editor', focused === 'body', focused);
    await page.getByRole('button', { name: 'Turn off on localhost' }).click();
    await page.waitForFunction(() => !document.querySelector('wordsmith-overlay'));
    check('turning a site off removes the overlay', true);
    const names = await page.evaluate(() => [...CSS.highlights.keys()].filter((name) => name.startsWith('wordsmith-')));
    check('turning a site off clears the underlines', names.length === 0, names);
    const sheets = await page.evaluate(() => document.adoptedStyleSheets.length);
    check('turning a site off removes the stylesheet', sheets === 0, sheets);

    await page.click('#body');
    await page.keyboard.type('x');
    await page.waitForTimeout(900);
    check('nothing comes back while the site is off', !(await page.evaluate(() => CSS.highlights.size)));

    await worker.evaluate(() => chrome.storage.sync.clear());
    await page.waitForFunction(() => document.querySelector('wordsmith-overlay'));
    await waitForUnderline(page, 'budgett');
    check('turning the site back on restores checking', true);

    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.sync.get('settings');
      await chrome.storage.sync.set({ settings: { ...settings, enabled: false } });
    });
    await page.waitForFunction(() => !document.querySelector('wordsmith-overlay'));
    check('the global switch clears the page too', (await allUnderlined(page)).length === 0);
    await worker.evaluate(() => chrome.storage.sync.clear());
    await page.close();
  },

  async settings({ context, worker, log }) {
    const page = await openPage(context, 'outlook.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'budgett');
    await worker.evaluate(async () => {
      const off = { correctness: false, clarity: true, engagement: true, delivery: true };
      await chrome.storage.sync.set({ settings: { checks: off } });
    });
    await waitForNoUnderline(page, 'budgett');
    check('turning a category off clears its underlines', true);
    await worker.evaluate(() => chrome.storage.sync.clear());
    await waitForUnderline(page, 'budgett');
    check('turning it back on restores them', true);
    await page.close();
  },

  async lifecycle({ context, worker, log }) {
    const page = await openPage(context, 'outlook.html', log);
    await page.click('#body');
    await waitForUnderline(page, 'budgett');

    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup/popup.html`);
    const reached = await extensionPage.evaluate(() =>
      fetch('http://localhost:5341/outlook.html').then(
        () => 'reached',
        () => 'blocked',
      ),
    );
    check('extension pages cannot reach the network', reached === 'blocked', reached);
    await extensionPage.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-idle' }));
    await extensionPage.close();
    await page.bringToFront();
    await page.waitForTimeout(200);
    const closed = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    check('an idle offscreen document is closed', closed.length === 0, closed);
    await typeInFirstLine(page, ' Teh');
    await waitForUnderline(page, 'Teh');
    const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
    check('a closed offscreen document comes back', contexts.length === 1, contexts);

    const cdp = await context.newCDPSession(page);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((info) => info.type === 'service_worker');
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await page.waitForTimeout(500);
    await typeInFirstLine(page, ' Thier ');
    await waitForUnderline(page, 'Thier');
    check('checking survives the service worker being stopped', true);
    await page.close();
  },

  async tabs({ context, log }) {
    const first = await openPage(context, 'outlook.html', log);
    const second = await openPage(context, 'gmail.html', log);
    await first.bringToFront();
    await first.click('#body');
    await second.bringToFront();
    await second.click('#body');
    await Promise.all([waitForUnderline(first, 'budgett'), waitForUnderline(second, 'recieved')]);
    check('two tabs share the one engine', true);
    await first.close();
    await second.close();
  },

  async popup({ context, worker, log }) {
    const site = await openPage(context, 'outlook.html', log);
    await site.click('#body');
    await waitForUnderline(site, 'budgett');

    // The popup asks which tab is active. Opened in a tab of its own, it would find itself.
    const pretend = (url) => `chrome.tabs.query = async () => [{ url: ${JSON.stringify(url)} }];`;
    const popupUrl = `chrome-extension://${new URL(worker.url()).hostname}/popup/popup.html`;
    const open = async (url) => {
      const popup = await context.newPage();
      watchConsole(popup, log);
      await popup.addInitScript(pretend(url));
      await popup.goto(popupUrl);
      await popup.locator('#site').filter({ hasText: /\S/ }).waitFor();
      return popup;
    };

    const popup = await open(`${BASE}/outlook.html`);
    await popup.setViewportSize({ width: 320, height: 480 });
    await shot(popup, 'popup');
    check('the popup shows the site switch', await popup.locator('#site-on').isChecked());

    await popup.uncheck('#site-on');
    await site.waitForFunction(() => !document.querySelector('wordsmith-overlay'));
    check('the site switch clears the page', (await allUnderlined(site)).length === 0);
    await popup.check('#site-on');
    await site.waitForFunction(() => document.querySelector('wordsmith-overlay'));
    await waitForUnderline(site, 'budgett');
    check('the site switch restores it', true);

    await popup.uncheck('[data-category="correctness"]');
    await waitForNoUnderline(site, 'budgett');
    check('a category box reaches the page', true);
    await popup.check('[data-category="correctness"]');
    await waitForUnderline(site, 'budgett');

    await popup.selectOption('#dialect', 'british');
    const stored = await worker.evaluate(() => chrome.storage.sync.get('settings'));
    check('the dialect is saved', stored.settings?.dialect === 'british', stored);

    await popup.uncheck('#enabled');
    await site.waitForFunction(() => !document.querySelector('wordsmith-overlay'));
    check('the main switch clears the page', true);
    await popup.check('#enabled');
    await site.waitForFunction(() => document.querySelector('wordsmith-overlay'));
    await popup.close();

    const other = await open('https://forum.example.com/topic/1');
    const offer = await other.locator('#grant').innerText();
    check('an ungranted site gets an offer', offer === 'Turn on for forum.example.com', offer);
    await shot(other, 'popup-grant');
    await other.close();

    const docs = await open('https://docs.google.com/document/d/abc/edit');
    const docsNote = await docs.locator('#site').innerText();
    check('Google Docs is explained, not offered', /canvas/.test(docsNote), docsNote);
    check('no switch is shown for Google Docs', (await docs.locator('#grant, #site-on').count()) === 0);
    await docs.close();

    await worker.evaluate(() => chrome.storage.sync.clear());
    await site.close();
  },

  async grantedSite({ context, log }) {
    const page = await openPage(context, 'outlook.html', log, `http://127.0.0.1:${PORT}`);
    await page.click('#body');
    await waitForUnderline(page, 'budgett');
    check('a granted site gets the registered content script', true);
    await page.close();
  },
};

const extensionPath = buildExtension();
await bundleProseMirror();
const server = await serve();

// The browser's own squiggles would hide which underlines are the extension's in screenshots.
mkdirSync(join(work, 'profile/Default'), { recursive: true });
writeFileSync(
  join(work, 'profile/Default/Preferences'),
  JSON.stringify({ browser: { enable_spellchecking: false } }),
);

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: process.env.WORDSMITH_BROWSER ?? 'chromium',
  headless: process.env.WORDSMITH_HEADED !== '1',
  viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const workerLog = [];
  worker.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') workerLog.push(message.text());
  });
  console.log(`Chromium ${context.browser()?.version() ?? ''}, extension ${new URL(worker.url()).hostname}`);
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && only !== name) continue;
    console.log(name);
    const log = [];
    try {
      await run({ context, worker, log });
    } catch (error) {
      check(`${name} finished`, false, String(error).slice(0, 600));
    }
    check(`${name}: no console errors`, log.length === 0, log);
  }
  check('no service worker console errors', workerLog.length === 0, workerLog);
} finally {
  await context.close();
  server.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failures.length} failed. Screenshots: ${shots}`);
process.exitCode = failures.length > 0 ? 1 : 0;
