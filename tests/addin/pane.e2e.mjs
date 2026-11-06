// Drives the built task pane in real Chrome, with fake-office.mjs served in place of
// office.js. The engine, its worker and wasm, the CSP, and the layout are all real.
// Only Office is not. Build first with vite build --config vite.addin.config.mts, then:
//   node tests/addin/pane.e2e.mjs [folder for screenshots] [one section to run]
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = 5331;
const ORIGIN = `http://localhost:${PORT}`;
// Served from the same subpath as the real site, so a root-relative URL would show up here.
const MOUNT = '/Wordsmith/office/';
const PAGE = `${ORIGIN}${MOUNT}taskpane.html`;
const OFFICE_JS = 'https://officeapis.public.onecdn.static.microsoft/1/office.js';
const root = fileURLToPath(new URL('../../dist-addin/', import.meta.url));
const shots = process.argv[2] ?? join(tmpdir(), 'wordsmith-addin-e2e');
const fakeSource = (await readFile(new URL('./fake-office.mjs', import.meta.url), 'utf8')).replace(
  'export function installFakeOffice',
  'function installFakeOffice',
);

if (!existsSync(join(root, 'taskpane.html'))) {
  console.error('dist-addin is missing. Build the add-in first.');
  process.exit(1);
}
mkdirSync(shots, { recursive: true });

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.xml': 'application/xml',
};

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, ORIGIN).pathname);
  const path = normalize(join(root, pathname.slice(MOUNT.length)));
  if (!pathname.startsWith(MOUNT) || !path.startsWith(normalize(root)) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(response);
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch({ channel: 'chrome', headless: true });

let failures = 0;
function check(name, passed, detail = '') {
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${!passed && detail !== '' ? ` -> ${JSON.stringify(detail)}` : ''}`);
  if (!passed) failures++;
}

/** Opens the pane at task pane width with a fake Office, and tracks everything that goes wrong. */
async function open(config, { scheme = 'light', officeJs, width = 320, block } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 780 }, colorScheme: scheme });
  const page = await context.newPage();
  const problems = [];
  const outside = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  context.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(ORIGIN) && !url.startsWith('data:') && !url.startsWith('blob:') && url !== OFFICE_JS) outside.push(url);
  });
  await page.route(OFFICE_JS, (route) => {
    if (officeJs === 'blocked') return route.abort();
    const body = officeJs ?? `${fakeSource}\nwindow.__office = installFakeOffice(window, ${JSON.stringify(config)});`;
    return route.fulfill({ contentType: 'text/javascript', body });
  });
  if (block) await context.route(block, (route) => route.abort());
  await page.goto(PAGE);
  return { page, context, problems, outside };
}

const cards = (page) => page.locator('.card');
const card = (page, text) => page.locator('.card', { hasText: text }).first();

async function openCard(page, text) {
  const target = card(page, text);
  await target.locator('.card__summary').click();
  const opened = page.locator('.card.is-open');
  await opened.locator('.issue__title').waitFor();
  return opened;
}

async function noSideScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

async function finish(name, session) {
  check(`${name}: nothing logged as an error`, session.problems.length === 0, session.problems);
  check(`${name}: nothing requested from anywhere else`, session.outside.length === 0, session.outside);
  await session.context.close();
}

const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });

const WORD_DOC = [
  { text: 'Quarterly update', styleBuiltIn: 'Title' },
  'Their is alot of mistaks in this sentance, and teh team should fix them.',
  'We should utilize this approach in order to get results at this point in time.',
  { text: 'Buy teh milk', isListItem: true },
  { text: 'Zorblat is a name.', bold: [[0, 7]] },
];

async function word() {
  const session = await open({ host: 'Word', word: { paragraphs: WORD_DOC } });
  const { page } = session;

  await card(page, 'mistaks').waitFor({ timeout: 90_000 });
  check('word: the engine loaded and found suggestions', (await cards(page).count()) >= 4, await cards(page).count());
  check(
    'word: the grammar engine is running, not just built-in rules',
    (await page.getByText('The grammar engine did not load').count()) === 0,
  );
  check('word: a score shows', /\d+/.test(await page.locator('.score__number').innerText()));
  check('word: the privacy line shows', await page.getByText('Text is checked in this pane and is not sent anywhere.').isVisible());
  check('word: no sideways scrolling at 320px', await noSideScroll(page));
  await shot(page, 'word-light-list');

  const opened = await openCard(page, 'mistaks');
  await page.waitForFunction(() => window.__office.word.selection === 'mistaks');
  check('word: clicking a suggestion selects the text in the document', true);
  check('word: the button says what it does', (await opened.locator('.fix').first().evaluate((el) => getComputedStyle(el, '::before').content)) === '"Apply: "');
  await shot(page, 'word-light-open');

  // Twice on purpose: the second click must not reach Word with offsets the first one moved.
  await opened.locator('.fix--primary').dblclick();
  await page.waitForFunction(() => window.__office.word.paragraphs[1].text.includes('mistakes'));
  const paragraph = await page.evaluate(() => window.__office.word.paragraphs[1].text);
  check('word: Apply changed the document', paragraph.includes('mistakes') && paragraph.includes('Their is alot'), paragraph);
  check('word: Apply changed only the characters that differ', await page.evaluate(() => window.__office.word.log.at(-1).text.length < 4));
  await page.getByText('Fix applied.').waitFor();
  check('word: a double click applies the fix once', (await page.evaluate(() => window.__office.word.log.length)) === 1);
  await page.waitForFunction(() => !document.querySelector('.card')?.textContent.includes('mistaks'));
  check('word: the fixed suggestion is gone', (await page.locator('.card', { hasText: 'mistaks' }).count()) === 0);

  // Text changes between the check and the click: the fix must not land, and the pane must say so.
  const stale = await openCard(page, 'sentance');
  await page.evaluate(() => {
    window.__office.word.paragraphs[1].text = 'Their is a change to this sentance now.';
  });
  await stale.locator('.fix--primary').click();
  await page.getByText('This text has changed, so nothing was applied. Checking again.').waitFor();
  check('word: a stale fix says so and changes nothing', await page.evaluate(() => window.__office.word.paragraphs[1].text === 'Their is a change to this sentance now.'));

  await page.evaluate(() => window.__office.word.addParagraph('A brand new paragrph appears.'));
  await card(page, 'paragrph').waitFor({ timeout: 15_000 });
  check('word: polling picks up new text on its own', true);

  const dismissing = await openCard(page, 'paragrph');
  await dismissing.getByRole('button', { name: 'Dismiss' }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('paragrph'));
  const dismissed = await page.evaluate(() => window.__office.settings['wordsmith.dismissed']);
  check('word: Dismiss is saved in the document', dismissed?.length === 1, dismissed);

  const spelling = await openCard(page, 'Zorblat');
  await spelling.getByRole('button', { name: 'Add to dictionary' }).click();
  await page.locator('.card', { hasText: 'Zorblat' }).waitFor({ state: 'detached' });
  check('word: Add to dictionary clears the suggestion', true);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText('English dialect').waitFor();
  check('word: the dictionary lists the new word', await page.getByRole('list').getByText('Zorblat').isVisible());
  check('word: settings fit at 320px', await noSideScroll(page));
  await shot(page, 'word-light-settings');
  await page.getByLabel('English dialect').selectOption('british');
  const clarity = page.locator('.pane-toggle', { hasText: 'Clarity' }).locator('input');
  await clarity.uncheck();
  await page.getByRole('button', { name: 'Back to suggestions' }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('in order to'));
  check('word: turning a category off takes effect', true);

  await page.getByRole('button', { name: 'Recheck' }).focus();
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  check('word: the suggestions are reachable by keyboard', /notice__close|card__summary/.test(focused), focused);
  await page.keyboard.press('Enter');
  await shot(page, 'word-light-keyboard');
  await finish('word', session);

  const again = await open({ host: 'Word', word: { paragraphs: [...WORD_DOC, 'A brand new paragrph appears.'] }, settings: { 'wordsmith.dismissed': dismissed } });
  await card(again.page, 'mistaks').waitFor({ timeout: 90_000 });
  check('word: a dismissal survives reopening the document', !(await again.page.locator('body').innerText()).includes('paragrph'));
  await finish('word reopened', again);
}

async function themes() {
  const dark = await open({ host: 'Word', theme: { bodyBackgroundColor: '#262626' }, word: { paragraphs: WORD_DOC } });
  await card(dark.page, 'mistaks').waitFor({ timeout: 90_000 });
  check('theme: follows a dark Office theme', (await dark.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  check('theme: no sideways scrolling in dark at 320px', await noSideScroll(dark.page));
  await shot(dark.page, 'word-dark-list');
  await openCard(dark.page, 'mistaks');
  await shot(dark.page, 'word-dark-open');
  await finish('dark', dark);

  const light = await open({ host: 'Word', theme: { bodyBackgroundColor: '#FFFFFF' }, word: { paragraphs: WORD_DOC } }, { scheme: 'dark' });
  await card(light.page, 'mistaks').waitFor({ timeout: 90_000 });
  check('theme: Office wins over the system setting', (await light.page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await finish('light', light);

  const system = await open({ host: 'Word', word: { paragraphs: WORD_DOC } }, { scheme: 'dark' });
  await card(system.page, 'mistaks').waitFor({ timeout: 90_000 });
  check('theme: falls back to the system setting', (await system.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await finish('system', system);
}

/** Shaped like classic Outlook's output, with the line endings and markup a browser would rewrite. */
const SIGNATURE = '<div id="Signature"><p>Jo <b>Smith</b><br /><img src="cid:logo@01DC" width=80></p></div>';
const QUOTED =
  "<div id=appendonsend></div>\r\n<hr tabindex='-1'>\r\n<div id=divRplyFwdMsg><b>From:</b> Sam<br><b>Sent:</b> Monday</div>\r\n" +
  '<div>Teh quoted thread has mistaks &amp; more<IMG SRC="cid:image001.png@01DC"></div>';
const BODY_HEAD = '<html xmlns:o="urn:schemas-microsoft-com:office:office">\r\n<head>\r\n<style><!-- p {margin:0} --></style>\r\n</head>\r\n<body lang=EN-US>\r\n';
const BODY_TEXT =
  '<p class=MsoNormal>The <b>teh</b> report is&nbsp;here, and <a href="https://example.com">a linke</a> too.<o:p></o:p></p>\r\n' +
  "<p class=MsoListParagraph><![if !supportLists]><span>1.<span style='font:7.0pt \"Times New Roman\"'>&nbsp;</span></span><![endif]>Sam&#39;s item<o:p></o:p></p>\r\n";
const BODY = `${BODY_HEAD}${BODY_TEXT}${SIGNATURE}\r\n${QUOTED}\r\n</body>\r\n</html>\r\n`;

async function outlook() {
  const session = await open({
    host: 'Outlook',
    outlook: { subject: 'Quartely report', body: BODY, hostName: 'Outlook' },
  });
  const { page } = session;

  await card(page, 'Quartely').waitFor({ timeout: 90_000 });
  const text = await page.locator('.cards').innerText();
  check('outlook: the subject is checked', text.includes('Quartely'));
  check('outlook: the quoted thread and signature are left out', !text.includes('mistaks') && !text.includes('Smith'), text);
  check('outlook: the pane warns that Ctrl+Z cannot undo a fix', await page.getByText('Ctrl+Z cannot take it back').isVisible());
  check('outlook: the pane warns about pictures', await page.getByText('Check them before you send').isVisible());
  check('outlook: no sideways scrolling at 320px', await noSideScroll(page));
  await shot(page, 'outlook-light-list');

  const fix = await openCard(page, 'teh');
  check('outlook: opening a suggestion does not try to select', (await page.getByText('does not let an add-in').count()) === 0);
  await shot(page, 'outlook-light-open');
  await fix.locator('.fix--primary').click();
  await page.waitForFunction(() => window.__office.outlook.writes.length === 1);

  const body = await page.evaluate(() => window.__office.outlook.body);
  const expected = BODY.replace('<b>teh</b>', '<b>the</b>');
  check('outlook: real Chrome changed only the fixed characters, CRLFs and all', body === expected, body);
  check('outlook: the quoted thread is byte-stable', body.includes(QUOTED));
  check('outlook: the signature is byte-stable', body.includes(SIGNATURE));

  await page.getByText('Fix applied.').waitFor();
  await page.getByRole('button', { name: 'Undo' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.pane__actions button:last-child').disabled);
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText('Fix undone.').waitFor();
  check('outlook: Undo restores the original bytes', (await page.evaluate(() => window.__office.outlook.body)) === BODY);

  await page.waitForFunction(() => !document.querySelector('.pane__actions button:first-child').disabled);
  const subject = await openCard(page, 'Quartely');
  await subject.locator('.fix--primary').click();
  await page.waitForFunction(() => window.__office.outlook.subject === 'Quarterly report');
  check('outlook: a subject fix writes the subject alone', (await page.evaluate(() => window.__office.outlook.body)) === BODY);

  // The third read after this change is the one inside the check: the fingerprints before it succeed.
  await page.evaluate(() => {
    window.__office.outlook.body = '<div>A chnge made by hand.</div>';
    window.__office.outlook.failReadIn = 3;
  });
  await page.getByText('Could not read from Outlook. Wordsmith will keep trying.').waitFor({ timeout: 15_000 });
  await card(page, 'chnge').waitFor({ timeout: 15_000 });
  check('outlook: a failed read says so, and the pane recovers by itself', (await page.getByRole('alert').count()) === 0);

  await page.evaluate(() => window.__office.outlook.switchItem({ subject: 'Second draft', body: '<div>A secnd draft.</div>' }));
  await card(page, 'secnd').waitFor({ timeout: 15_000 });
  check('outlook: a pinned pane moves on to the next item', true);
  await finish('outlook', session);

  const dark = await open(
    { host: 'Outlook', theme: { bodyBackgroundColor: '#1F1F1F' }, outlook: { subject: 'Quartely report', body: BODY, hostName: 'newOutlookWindows' } },
    { scheme: 'dark' },
  );
  await card(dark.page, 'Quartely').waitFor({ timeout: 90_000 });
  check('outlook dark: says the cursor moves to the end', await dark.page.getByText('moves the cursor to the end').isVisible());
  check('outlook dark: no sideways scrolling at 320px', await noSideScroll(dark.page));
  await shot(dark.page, 'outlook-dark-list');
  await finish('outlook dark', dark);

  const crowded = await open({
    host: 'Outlook',
    outlook: { body: `<p>Teh report.</p>${'<img src="cid:a@b">'.repeat(12)}`, hostName: 'newOutlookWindows' },
  });
  await card(crowded.page, 'Teh').waitFor({ timeout: 90_000 });
  await openCard(crowded.page, 'Teh');
  check('outlook crowded: no Apply on a draft Outlook could damage', (await crowded.page.locator('.fix').count()) === 0);
  check('outlook crowded: the suggestion still shows', await crowded.page.getByText('Change “Teh” to The').isVisible());
  await shot(crowded.page, 'outlook-crowded');
  await finish('outlook crowded', crowded);

  const plain = await open({ host: 'Outlook', outlook: { bodyType: 'text', body: 'Teh report.\r\n> Old teh text', hostName: 'OutlookWebApp' } });
  await card(plain.page, 'Teh').waitFor({ timeout: 90_000 });
  const plainFix = await openCard(plain.page, 'Teh');
  await plainFix.locator('.fix--primary').click();
  await plain.page.waitForFunction(() => window.__office.outlook.writes.length === 1);
  check('outlook plain text: the fix keeps the rest', (await plain.page.evaluate(() => window.__office.outlook.body)) === 'The report.\r\n> Old teh text');
  await finish('outlook plain text', plain);

  const reading = await open({ host: 'Outlook', outlook: { compose: false } });
  await reading.page.getByText('Open a message you are writing').waitFor({ timeout: 30_000 });
  check('outlook: explains itself when no draft is open', true);
  await finish('outlook no draft', reading);
}

async function selection() {
  const powerpoint = await open({ host: 'PowerPoint', selection: { text: 'Teh slide title\rSecond line of text' } });
  const { page } = powerpoint;
  await page.getByText('Select some text, then choose Check selection.').waitFor({ timeout: 30_000 });
  check('powerpoint: waits to be asked', (await page.getByRole('button', { name: 'Recheck' }).count()) === 0);
  await page.getByRole('button', { name: 'Check selection' }).click();
  await card(page, 'Teh').waitFor({ timeout: 90_000 });
  await shot(page, 'powerpoint-light-list');
  const fix = await openCard(page, 'Teh');
  await fix.locator('.fix--primary').click();
  await page.waitForFunction(() => window.__office.selection.writes.length === 1);
  check('powerpoint: Apply replaced the selection', (await page.evaluate(() => window.__office.selection.text)) === 'The slide title\rSecond line of text');
  await finish('powerpoint', powerpoint);

  const excel = await open({ host: 'Excel', selection: { text: 'Teh total', formula: '=A1&" total"' } });
  await excel.page.getByRole('button', { name: 'Check selection' }).click();
  await card(excel.page, 'Teh').waitFor({ timeout: 90_000 });
  const refusal = await openCard(excel.page, 'Teh');
  await refusal.locator('.fix--primary').click();
  await excel.page.getByText('This cell holds a formula').waitFor();
  check('excel: a formula is not overwritten', (await excel.page.evaluate(() => window.__office.selection.writes.length)) === 0);
  await shot(excel.page, 'excel-light-refused');
  await finish('excel', excel);
}

async function outsideOffice() {
  const stub = 'window.Office = { onReady: () => Promise.resolve({ host: null, platform: null }) };';
  const browserTab = await open({}, { officeJs: stub, width: 900 });
  await browserTab.page.getByRole('heading', { name: 'Wordsmith for Office' }).waitFor();
  check('no office: shows the install steps', await browserTab.page.getByRole('link', { name: 'manifest-outlook.xml' }).isVisible());
  await shot(browserTab.page, 'no-office-wide');
  const manifest = await browserTab.page.request.get(`${ORIGIN}${MOUNT}manifest-outlook.xml`);
  check('no office: the manifest link works', manifest.ok());
  await finish('no office', browserTab);

  const narrow = await open({}, { officeJs: stub, scheme: 'dark' });
  await narrow.page.getByRole('heading', { name: 'Wordsmith for Office' }).waitFor();
  check('no office: fits at 320px', await noSideScroll(narrow.page));
  await shot(narrow.page, 'no-office-narrow-dark');
  await finish('no office narrow', narrow);

  const blocked = await open({}, { officeJs: 'blocked' });
  await blocked.page.getByRole('heading', { name: 'Wordsmith for Office' }).waitFor();
  check('no office: still explains itself if the library cannot load', true);
  const expected = blocked.problems.filter((text) => !text.includes('ERR_FAILED'));
  check('no office: the blocked script is the only complaint', expected.length === 0, expected);
  await blocked.context.close();
}

async function brokenEngine() {
  const session = await open({ host: 'Word', word: { paragraphs: WORD_DOC } }, { block: '**/assets/worker-*' });
  await session.page.getByText('The checker could not start, so nothing has been checked.').waitFor({ timeout: 30_000 });
  check('broken engine: says so', true);
  check('broken engine: does not claim the text is fine', (await session.page.getByText('No suggestions').count()) === 0);
  check('broken engine: stops the spinner', (await session.page.locator('.spinner').count()) === 0);
  check('broken engine: the header does not imply the text was read', await session.page.getByText('Nothing checked yet').isVisible());
  await shot(session.page, 'broken-engine');
  await session.context.close();
}

const sections = { word, themes, outlook, selection, outsideOffice, brokenEngine };
const only = process.argv[3];
try {
  for (const [name, run] of Object.entries(sections)) {
    if (only && only !== name) continue;
    console.log(`\n== ${name}`);
    try {
      await run();
    } catch (error) {
      failures++;
      console.log(`FAIL ${name} stopped: ${error.message}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nAll browser checks passed.' : `\n${failures} browser checks failed.`);
console.log(`Screenshots: ${shots}`);
process.exit(failures === 0 ? 0 : 1);
