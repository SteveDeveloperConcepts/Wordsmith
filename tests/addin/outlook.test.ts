// @vitest-environment happy-dom
/// <reference types="office-js" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fix, Issue } from '@engine/types';
import { parseHtml, readHtmlBlocks, readPlainBlocks, replaceHtmlBlock, replacePlainBlock } from '../../src/addin/hosts/mail-body';
import { createOutlookHost } from '../../src/addin/hosts/outlook';
import type { Host, Snapshot } from '../../src/addin/hosts/types';
import { installFakeOffice, type FakeConfig, type FakeHandles } from './fake-office.mjs';

afterEach(() => vi.unstubAllGlobals());

function setUp(outlook: NonNullable<FakeConfig['outlook']>, platform: FakeConfig['platform'] = 'PC'): { fake: FakeHandles; host: Host } {
  const globals: { Office?: unknown } = {};
  const fake = installFakeOffice(globals, { host: 'Outlook', platform, outlook });
  vi.stubGlobal('Office', globals.Office);
  return { fake, host: createOutlookHost() };
}

const authored = (html: string) => readHtmlBlocks(parseHtml(html)).map((block) => block.text);

/** Fixes the first `find` in the first block that has it. */
function fixFor(snapshot: Snapshot, find: string, replacement: string): { issue: Issue; fix: Fix } {
  const block = snapshot.blocks.findIndex((candidate) => candidate.text.includes(find));
  expect(block, `"${find}" should be in a block`).toBeGreaterThanOrEqual(0);
  const from = snapshot.blocks[block].text.indexOf(find);
  const to = from + find.length;
  const fix: Fix = { label: replacement, from, to, text: replacement };
  const issue: Issue = {
    id: `rule:${find}`,
    block,
    from,
    to,
    category: 'correctness',
    type: 'spelling',
    ruleId: 'rule',
    title: 'Fix this',
    message: '',
    text: find,
    fixes: [fix],
    sentenceLevel: false,
    sentence: { from: 0, to },
  };
  return { issue, fix };
}

describe('telling the writer’s text from the rest', () => {
  it.each([
    ['a new message with no markers', '<div>Hello wrold.</div>', ['Hello wrold.']],
    [
      'a reply from Outlook on the web',
      '<div>My reply.</div><div id="Signature"><p>Steve</p></div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> A</div><div>Old text.</div>',
      ['My reply.'],
    ],
    [
      'a reply without the appendonsend marker',
      '<div>My reply.</div><hr tabindex="-1"><div id="divRplyFwdMsg"><b>From:</b> A</div><div>Old text.</div>',
      ['My reply.'],
    ],
    [
      'a reply from Word with the separator nested',
      '<div class="WordSection1"><p class="MsoNormal">My reply.<o:p></o:p></p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> A</p></div></div><p>Old.</p></div>',
      ['My reply.'],
    ],
    ['the Word bookmark before a quote', '<p class="MsoNormal">My reply.</p><a name="_MailOriginal"></a><p>Old.</p>', ['My reply.']],
    ['the Word bookmark before a signature', '<p>My reply.</p><a name="_MailAutoSig"></a><p>Steve</p>', ['My reply.']],
    ['a Gmail thread below', '<div>My reply.</div><div class="gmail_quote"><blockquote>Old.</blockquote></div>', ['My reply.']],
    ['an Apple quote', '<div>My reply.</div><blockquote type="cite">Old.</blockquote>', ['My reply.']],
    ['a Mac reply', '<div>My reply.</div><div id="OLK_SRC_BODY_SECTION"><p>Old.</p></div>', ['My reply.']],
    ['a signature with text after it', '<p>Body text.</p><div id="Signature">Steve</div><p>PS line.</p>', ['Body text.', 'PS line.']],
    ['a mobile signature', '<p>Body.</p><div id="ms-outlook-mobile-signature">Sent from my phone</div>', ['Body.']],
    [
      'a reply header left with no markers at all',
      '<p>My reply.</p><div><b>From:</b> Sam<br><b>Sent:</b> Monday<br><b>To:</b> Jo<br><b>Subject:</b> Hi</div><p>Old.</p>',
      ['My reply.'],
    ],
    ['an original message line', '<p>My reply.</p><p>-----Original Message-----</p><p>Old.</p>', ['My reply.']],
  ])('handles %s', (_name, html, expected) => {
    expect(authored(html)).toEqual(expected);
  });

  it('does not mistake a sentence about a sender for a reply header', () => {
    expect(authored('<p>From: the desk of Jo. Thanks for writing.</p><p>Next.</p>')).toHaveLength(2);
  });
});

describe('the HTML round trip', () => {
  const quoted =
    '<div id="appendonsend"></div><hr tabindex="-1"><div id="divRplyFwdMsg"><b>From:</b> Sam</div>' +
    '<div>Teh old text <img src="cid:image001.png@01DC" width=10></div>';
  const signature = '<div id="Signature"><p>Jo <b>Smith</b><br><img src="cid:logo@01DC"></p></div>';

  const once = (html: string, before: string, after: string) => {
    const was = authored(html);
    const patch = replaceHtmlBlock(html, was, was.indexOf(before), after);
    expect(patch.status).toBe('ok');
    return patch.status === 'ok' ? patch.body : '';
  };

  it('keeps bold on the word it fixes', () => {
    expect(once('<p>The <b>grammer</b> is off.</p>', 'The grammer is off.', 'The grammar is off.')).toBe(
      '<p>The <b>grammar</b> is off.</p>',
    );
  });

  it('keeps a link', () => {
    const html = '<p>Read <a href="https://example.com/a?b=1&amp;c=2">teh guide</a> now.</p>';
    expect(once(html, 'Read teh guide now.', 'Read the guide now.')).toBe(
      '<p>Read <a href="https://example.com/a?b=1&amp;c=2">the guide</a> now.</p>',
    );
  });

  it('keeps an inline picture between the words', () => {
    const html = '<p>See <img src="cid:one@x"> teh picture</p>';
    expect(once(html, 'See ￼ teh picture', 'See ￼ the picture')).toBe(
      '<p>See <img src="cid:one@x"> the picture</p>',
    );
  });

  it('leaves the signature and the quoted thread byte for byte as they were', () => {
    const head = '<div>Teh <b>report</b> is here.</div>';
    const html = head + signature + quoted;
    expect(once(html, 'Teh report is here.', 'The report is here.')).toBe(
      `<div>The <b>report</b> is here.</div>${signature}${quoted}`,
    );
  });

  it('keeps markup a browser would rewrite, byte for byte', () => {
    // Unquoted attributes, conditional comments, Word's own tags, and an entity
    // spelled the long way: reserializing a parsed document changes every one of them.
    const prolog = `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta http-equiv=Content-Type content="text/html; charset=utf-8">
<style><!-- p.MsoNormal {margin:0in;} --></style>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->
</head>
<body lang=EN-US link="#0563C1" style='word-wrap:break-word'>
<div class=WordSection1>
<p class=MsoNormal>`;
    const tail = `<o:p></o:p></p>
<p class=MsoListParagraph><![if !supportLists]><span>1.<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;</span></span><![endif]>Item&#39;s text<o:p></o:p></p>
<div style='border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in'>
<p class=MsoNormal><b>From:</b> Sam<br /><b>Sent:</b> Monday</p></div>
<p class=MsoNormal>Teh quoted text &amp; more<IMG SRC="cid:a@b"></p>
</div></body></html>`;
    const html = `${prolog}Thanks for you&#39;re help${tail}`;
    expect(once(html, "Thanks for you're help", 'Thanks for your help')).toBe(`${prolog}Thanks for your help${tail}`);
  });

  it('changes only the node a block runs through, across several runs', () => {
    expect(once('<p>at <b>this</b> point in <i>time</i> we go</p>', 'at this point in time we go', 'now we go')).toBe(
      '<p>now<b></b><i></i> we go</p>',
    );
  });

  it('escapes what the fix puts in', () => {
    expect(once('<p>Tom and Jerry</p>', 'Tom and Jerry', 'Tom & Jerry <3')).toBe('<p>Tom &amp; Jerry &lt;3</p>');
  });

  it('keeps the entities it did not touch', () => {
    const html = '<p>R&amp;D&nbsp;team&rsquo;s teh plan</p>';
    expect(once(html, 'R&D team’s teh plan', 'R&D team’s the plan')).toBe('<p>R&amp;D&nbsp;team&rsquo;s the plan</p>');
  });

  it('fixes text after whitespace the parser dropped', () => {
    const html = '\n<html>\n<body>\n<p>Some\nteh text</p>\n</body>\n</html>\n';
    expect(once(html, 'Some teh text', 'Some the text')).toBe('\n<html>\n<body>\n<p>Some\nthe text</p>\n</body>\n</html>\n');
  });

  it('copes with emoji that share half a surrogate pair', () => {
    expect(once('<p>Go 😀 now</p>', 'Go 😀 now', 'Go 😁 now')).toBe('<p>Go 😁 now</p>');
  });

  it('falls back to the parsed document when the markup cannot be lined up', () => {
    // The parser moves stray table text in front of the table, so source order is lost.
    const patched = once('<table>stray<tr><td>Teh cell</td></tr></table>', 'Teh cell', 'The cell');
    expect(patched).toContain('The cell');
    expect(patched).not.toContain('Teh cell');
  });

  it('keeps a whole document whole when it has to fall back', () => {
    const html = '<!DOCTYPE html><html><head><title>x</title></head><body><table>stray<tr><td>Teh cell</td></tr></table></body></html>';
    const patched = once(html, 'Teh cell', 'The cell');
    expect(patched.startsWith('<!DOCTYPE html><html>')).toBe(true);
    expect(patched).toContain('<title>x</title>');
  });

  it('reports a block that no longer says what it said', () => {
    expect(replaceHtmlBlock('<p>Changed.</p>', ['Original.'], 0, 'New.').status).toBe('stale');
  });

  it('follows a block that moved', () => {
    const patch = replaceHtmlBlock('<p>New.</p><p>Teh text.</p>', ['Teh text.'], 0, 'The text.');
    expect(patch).toEqual({ status: 'ok', body: '<p>New.</p><p>The text.</p>' });
  });

  it('tells copies of a block apart by their order', () => {
    const patch = replaceHtmlBlock('<p>New.</p><p>Same.</p><p>Same.</p>', ['Same.', 'Same.'], 1, 'Other.');
    expect(patch).toEqual({ status: 'ok', body: '<p>New.</p><p>Same.</p><p>Other.</p>' });
  });

  it('will not choose once a copy came or went', () => {
    expect(replaceHtmlBlock('<p>Same.</p>', ['Same.', 'Same.'], 1, 'Other.').status).toBe('stale');
  });
});

describe('plain text drafts', () => {
  it('stops at quotes, reply headers, and signatures', () => {
    const texts = (body: string) => readPlainBlocks(body).map((block) => block.text);
    expect(texts('Hello.\n\nBye.\n> Old text')).toEqual(['Hello.', 'Bye.']);
    expect(texts('Hello.\n-- \nJo')).toEqual(['Hello.']);
    expect(texts('Hello.\r\n-----Original Message-----\r\nOld')).toEqual(['Hello.']);
    expect(texts('Hello.\n________________________________\nFrom: Sam\nOld')).toEqual(['Hello.']);
    expect(texts('Hello.\nFrom: Sam\nSent: Monday\nTo: Jo\nSubject: Hi\nOld')).toEqual(['Hello.']);
  });

  it('keeps a line that only looks like a header', () => {
    expect(readPlainBlocks('From: Sam, with thanks.\nNext line.')).toHaveLength(2);
  });

  it('measures lines in the source, whatever the line ending', () => {
    const source = 'One\r\nTwo teh\nThree';
    const [, second] = readPlainBlocks(source);
    expect(source.slice(second.start, second.start + second.text.length)).toBe('Two teh');
  });

  it('writes a fix into the right line and leaves the rest alone', () => {
    const source = 'One\r\nTwo teh\r\n\r\n> Quoted teh';
    expect(replacePlainBlock(source, ['One', 'Two teh'], 1, 'Two the')).toEqual({
      status: 'ok',
      body: 'One\r\nTwo the\r\n\r\n> Quoted teh',
    });
  });

  it('keeps a non-breaking space the fix did not mean to change', () => {
    const source = 'Dr. Smith teh';
    expect(replacePlainBlock(source, ['Dr. Smith teh'], 0, 'Dr. Smith the')).toEqual({
      status: 'ok',
      body: 'Dr. Smith the',
    });
  });
});

describe('reading a draft', () => {
  it('checks the subject and the body, and nothing else', async () => {
    const { host } = setUp({
      subject: 'Quartely report',
      body: '<div>My reply.</div><div id="Signature">Jo</div><div id="divRplyFwdMsg">From: Sam</div><div>Old.</div>',
    });
    const { blocks } = await host.read();
    expect(blocks).toEqual([
      { text: 'Quartely report', kind: 'heading' },
      { text: 'My reply.', kind: 'paragraph' },
    ]);
  });

  it('hands the worker plain data, never the DOM behind a block', async () => {
    const { host } = setUp({ body: '<p>Hello there.</p>' });
    const { blocks } = await host.read();
    expect(() => structuredClone(blocks)).not.toThrow();
    expect(Object.keys(blocks[0]).sort()).toEqual(['kind', 'text']);
  });

  it('leaves out a subject the writer did not write', async () => {
    const { host } = setUp({ subject: 'RE: Quartely report', body: '<p>Thanks.</p>' });
    expect((await host.read()).blocks.map((block) => block.text)).toEqual(['Thanks.']);
  });

  it('uses email goals', () => {
    const { host } = setUp({ body: '' });
    expect(
      host.goals({ audience: 'general', formality: 'formal', domain: 'general', intent: 'inform' }),
    ).toEqual({ audience: 'general', formality: 'formal', domain: 'email', intent: 'inform' });
  });

  it('handles a whole document, as new Outlook on Mac returns', async () => {
    const { host } = setUp({ body: '<html><head><style>p{margin:0}</style></head><body><p>Hello.</p></body></html>' });
    expect((await host.read()).blocks.map((block) => block.text)).toEqual(['Hello.']);
  });

  it('reads plain text drafts as text', async () => {
    const { fake, host } = setUp({ bodyType: 'text', body: 'Hello.\n> Old' });
    expect((await host.read()).blocks.map((block) => block.text)).toEqual(['Hello.']);
    expect(fake.outlook.writes).toEqual([]);
  });

  it('explains itself when no draft is open', async () => {
    const { host } = setUp({ compose: false });
    const snapshot = await host.read();
    expect(snapshot.blocks).toEqual([]);
    expect(snapshot.empty).toContain('Open a message');
  });

  it('asks for the writer’s own view of the conversation, and keeps asking for it', async () => {
    const { fake, host } = setUp({
      body: '<p>Teh reply.</p><div id="divRplyFwdMsg">From: Sam</div><p>Old.</p>',
      conversationBody: '<p>Teh reply.</p>',
    });
    const snapshot = await host.read();
    const { issue, fix } = fixFor(snapshot, 'Teh', 'The');
    await host.apply(issue, fix);
    expect(fake.outlook.bodyOptions.length).toBeGreaterThan(1);
    expect(fake.outlook.bodyOptions.every((options) => options.bodyMode === 1)).toBe(true);
    // Grouped view leaves the thread out of the exchange, so it cannot be disturbed.
    expect(fake.outlook.conversationBody).toBe('<p>The reply.</p>');
    expect(fake.outlook.body).toContain('Old.');
  });
});

describe('what the pane tells the writer about each client', () => {
  const noticeFor = async (hostName: string, platform: FakeConfig['platform']) => {
    const { host } = setUp({ hostName, body: '<p>Hello.</p>' }, platform);
    return (await host.read()).notices.find((notice) => notice.id === 'rewrite')?.text;
  };

  it('classic Outlook: cursor to the start, no Ctrl+Z', async () => {
    const text = await noticeFor('Outlook', 'PC');
    expect(text).toContain('moves to the start');
    expect(text).toContain('Ctrl+Z cannot');
  });

  it('Outlook on Mac: cursor gone, no Command+Z', async () => {
    const text = await noticeFor('Outlook', 'Mac');
    expect(text).toContain('disappears');
    expect(text).toContain('Command+Z cannot');
  });

  it('new Outlook and the web: cursor to the end', async () => {
    expect(await noticeFor('newOutlookWindows', 'PC')).toContain('to the end');
    expect(await noticeFor('OutlookWebApp', 'OfficeOnline')).toContain('to the end');
  });

  it('warns about pictures', async () => {
    const { host } = setUp({ body: '<p>Hello <img src="cid:a@b"></p>' });
    expect((await host.read()).notices.map((notice) => notice.id)).toContain('pictures');
  });

  it('will not rewrite a draft crowded with pictures on the clients that truncate them', async () => {
    const images = '<img src="cid:a@b">'.repeat(10);
    const { host } = setUp({ hostName: 'newOutlookWindows', body: `<p>Hello.</p>${images}` });
    const snapshot = await host.read();
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.notices.map((notice) => notice.id)).toEqual(['crowded']);
  });

  it('allows the same draft on classic Outlook, which that bug does not touch', async () => {
    const images = '<img src="cid:a@b">'.repeat(10);
    const { host } = setUp({ hostName: 'Outlook', body: `<p>Hello.</p>${images}` });
    expect((await host.read()).readOnly).toBe(false);
  });
});

describe('applying a fix', () => {
  it('writes the patched body in the format it was read in', async () => {
    const { fake, host } = setUp({ body: '<div>Teh <b>report</b>.</div><div id="Signature">Jo</div>' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.outlook.body).toBe('<div>The <b>report</b>.</div><div id="Signature">Jo</div>');
    expect(fake.outlook.bodyOptions.at(-1)).toMatchObject({ call: 'set', coercionType: 'html' });
  });

  it('fixes a plain text draft as text', async () => {
    const { fake, host } = setUp({ bodyType: 'text', body: 'Teh report.\n> Old teh' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.outlook.body).toBe('The report.\n> Old teh');
    expect(fake.outlook.bodyOptions.at(-1)).toMatchObject({ call: 'set', coercionType: 'text' });
  });

  it('fixes the subject without touching the body', async () => {
    const { fake, host } = setUp({ subject: 'Quartely report', body: '<p>Hello.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Quartely', 'Quarterly');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.outlook.subject).toBe('Quarterly report');
    expect(fake.outlook.writes).toEqual([{ subject: 'Quarterly report' }]);
  });

  it('confirms the block before writing, and writes nothing if it changed', async () => {
    const { fake, host } = setUp({ body: '<p>Teh report.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    fake.outlook.body = '<p>Teh report has changed.</p>';
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.outlook.writes).toEqual([]);
  });

  it('confirms the subject before writing', async () => {
    const { fake, host } = setUp({ subject: 'Quartely report', body: '<p>Hello.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Quartely', 'Quarterly');
    fake.outlook.subject = 'Something else';
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.outlook.subject).toBe('Something else');
  });

  it('does not lose an earlier fix when a read returns the old body (office-js 5983)', async () => {
    const { fake, host } = setUp({ body: '<p>Teh one.</p><p>Teh two.</p>', staleReadsAfterWrite: 2 });
    const snapshot = await host.read();
    const first = fixFor(snapshot, 'Teh one', 'The one');
    expect(await host.apply(first.issue, first.fix)).toEqual({ ok: true });

    const second = fixFor(await host.read(), 'Teh two', 'The two');
    expect(await host.apply(second.issue, second.fix)).toEqual({ ok: true });
    expect(fake.outlook.body).toBe('<p>The one.</p><p>The two.</p>');
  });

  it('says so if the old body will not go away', async () => {
    const { host } = setUp({ body: '<p>Teh one.</p><p>Teh two.</p>', staleReadsAfterWrite: 100 });
    const snapshot = await host.read();
    const first = fixFor(snapshot, 'Teh one', 'The one');
    await host.apply(first.issue, first.fix);
    await expect(host.read()).rejects.toThrow('has not finished');
  }, 10_000);

  it('does not write over typing that lands while it reads (office-js 5846)', async () => {
    const { fake, host } = setUp({ body: '<p>Teh report.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    const typing = setTimeout(() => {
      fake.outlook.body = '<p>Teh report.</p><p>Just typed this.</p>';
    }, 100);
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    clearTimeout(typing);
    expect(fake.outlook.body).toBe('<p>The report.</p><p>Just typed this.</p>');
  });

  it('refuses a body Outlook would reject as too long', async () => {
    const { fake, host } = setUp({ body: `<p>Teh report.</p><p>${'x'.repeat(1_000_000)}</p>` });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'refused' });
    expect(fake.outlook.writes).toEqual([]);
  });

  it('notices when the client breaks a picture after a write (office-js 6997)', async () => {
    const { host } = setUp({
      hostName: 'newOutlookWindows',
      body: '<p>Teh report <img src="cid:one@x"></p>',
      rewriteOnWrite: (html) => html.replace('cid:one@x', 'cid:Local.ContentId.blob:one'),
    });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    await host.apply(issue, fix);
    expect((await host.read()).notices.map((notice) => notice.id)).toContain('pictures-changed');
  });

  it('does not cry wolf when the writer adds a picture', async () => {
    const { fake, host } = setUp({ body: '<p>Teh report <img src="cid:one@x"></p>' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    await host.apply(issue, fix);
    fake.outlook.body += '<img src="blob:new">';
    expect((await host.read()).notices.map((notice) => notice.id)).not.toContain('pictures-changed');
  });
});

describe('undo', () => {
  it('takes back fixes in turn, for clients that cannot', async () => {
    const original = '<p>Teh one.</p><p>Teh two.</p>';
    const { fake, host } = setUp({ body: original });
    expect(host.canUndo?.()).toBe(false);

    const first = fixFor(await host.read(), 'Teh one', 'The one');
    await host.apply(first.issue, first.fix);
    const second = fixFor(await host.read(), 'Teh two', 'The two');
    await host.apply(second.issue, second.fix);
    expect(fake.outlook.body).toBe('<p>The one.</p><p>The two.</p>');
    expect(host.canUndo?.()).toBe(true);

    await host.read();
    expect(await host.undo?.()).toEqual({ ok: true });
    await host.read();
    expect(await host.undo?.()).toEqual({ ok: true });
    expect(fake.outlook.body).toBe(original);
    expect(host.canUndo?.()).toBe(false);
  });

  it('takes back a subject fix', async () => {
    const { fake, host } = setUp({ subject: 'Quartely report', body: '<p>Hello.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Quartely', 'Quarterly');
    await host.apply(issue, fix);
    await host.undo?.();
    expect(fake.outlook.subject).toBe('Quartely report');
  });

  it('leaves the text alone if it moved on after the fix', async () => {
    const { fake, host } = setUp({ body: '<p>Teh one.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    await host.apply(issue, fix);
    await host.read();
    fake.outlook.body = '<p>Rewritten by hand.</p>';
    expect(await host.undo?.()).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.outlook.body).toBe('<p>Rewritten by hand.</p>');
  });
});

describe('a pinned pane', () => {
  it('starts over when the item changes', async () => {
    const { fake, host } = setUp({ body: '<p>Teh one.</p>' });
    const listener = vi.fn();
    const stop = host.onItemChange?.(listener);
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    await host.apply(issue, fix);
    expect(host.canUndo?.()).toBe(true);

    fake.outlook.switchItem({ body: '<p>Another draft.</p>' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(host.canUndo?.()).toBe(false);
    expect((await host.read()).blocks.map((block) => block.text)).toEqual(['Another draft.']);
    stop?.();
  });

  it('notices a new draft through polling when the event does not fire', async () => {
    const { fake, host } = setUp({ body: '<p>Same text.</p>' });
    const first = await host.fingerprint();
    const { mailbox } = Office.context as unknown as { mailbox: { item: object } };
    // Two drafts can say the same thing, so the text alone cannot tell them apart.
    mailbox.item = { ...mailbox.item };
    expect(await host.fingerprint()).not.toBe(first);
    expect(fake.outlook.writes).toEqual([]);
  });

  it('will not apply a fix from the previous draft to this one', async () => {
    const { fake, host } = setUp({ body: '<p>Teh one.</p>' });
    const { issue, fix } = fixFor(await host.read(), 'Teh', 'The');
    const { mailbox } = Office.context as unknown as { mailbox: { item: object } };
    mailbox.item = { ...mailbox.item };
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.outlook.writes).toEqual([]);
  });

  it('goes quiet when the pane is left on something that is not a draft', async () => {
    const { fake, host } = setUp({ body: '<p>Teh one.</p>' });
    await host.read();
    fake.outlook.switchItem({ compose: false });
    expect((await host.read()).empty).toContain('Open a message');
  });

  it('surfaces a failed read, so the pane can say so and keep polling (office-js 6800)', async () => {
    const { fake, host } = setUp({ body: '<p>Hello.</p>' });
    fake.outlook.failReadIn = 1;
    await expect(host.read()).rejects.toThrow('internal error');
    expect((await host.read()).blocks).toHaveLength(1);
  });
});

describe('dismissals', () => {
  it('belong to the draft, and stay out of the message', async () => {
    const { fake, host } = setUp({ body: '<p>Hello.</p>' });
    await host.saveDismissed(['rule:abc']);
    expect(await host.loadDismissed()).toEqual(['rule:abc']);
    fake.outlook.switchItem({ body: '<p>Another.</p>' });
    expect(await host.loadDismissed()).toEqual([]);
  });
});

describe('selecting', () => {
  it('says plainly that Outlook cannot', async () => {
    const { host } = setUp({ body: '<p>Teh one.</p>' });
    expect(host.canSelect).toBe(false);
    const { issue } = fixFor(await host.read(), 'Teh', 'The');
    expect(await host.select(issue)).toMatchObject({ ok: false, kind: 'refused' });
  });
});
