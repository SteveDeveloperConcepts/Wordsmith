// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopBridge, PickedFile, SaveFileRequest } from '@shared/api';
import type { JSONContent } from '@tiptap/core';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importFile } from '@renderer/lib/importers';
import { parseHtml, renderHtml } from '@renderer/lib/schema';
import { documentToDocx, documentToHtml, documentToMarkdown, documentToText } from '@renderer/lib/exporters';

const text = (value: string, ...marks: string[]): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});

const linked = (value: string, href: string, ...marks: string[]): JSONContent => ({
  type: 'text',
  text: value,
  marks: [...marks.map((type) => ({ type })), { type: 'link', attrs: { href } }],
});

const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const heading = (level: number, value: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const item = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content });
const bullets = (...content: JSONContent[]): JSONContent => ({ type: 'bulletList', content });
const numbers = (...content: JSONContent[]): JSONContent => ({ type: 'orderedList', content });
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content });

const RICH = doc(
  heading(1, 'First heading'),
  paragraph(
    text('Plain, '),
    text('bold', 'bold'),
    text(', '),
    text('italic', 'italic'),
    text(', '),
    text('underlined', 'underline'),
    text(', '),
    text('struck', 'strike'),
    text(', '),
    text('all three', 'bold', 'italic', 'underline'),
    text(', '),
    text('code()', 'code'),
    text(' and a '),
    linked('link', 'https://example.com/a?b=1&c=2'),
    text('.'),
  ),
  heading(2, 'Second heading'),
  bullets(
    item(paragraph(text('Bullet one')), bullets(item(paragraph(text('Nested bullet'))), item(paragraph(text('Another'))))),
    item(paragraph(text('Bullet two'))),
  ),
  heading(3, 'Third heading'),
  numbers(
    item(paragraph(text('Number one')), numbers(item(paragraph(text('Nested number'))))),
    item(paragraph(text('Number two'))),
  ),
  { type: 'blockquote', content: [paragraph(text('A quotation with '), text('weight', 'bold'))] },
  { type: 'horizontalRule' },
  { type: 'codeBlock', attrs: { language: null }, content: [text('line one\n  line two')] },
  paragraph(text('The end'), { type: 'hardBreak' }, text('of the text')),
);

/** The same document as the editor would hold it, with every attribute filled in. */
const canonical = (content: JSONContent): JSONContent => parseHtml(renderHtml(content));

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const picked = (name: string, data: string | Uint8Array): PickedFile => ({
  name,
  data: typeof data === 'string' ? utf8(data) : data,
});
const fixture = (name: string): PickedFile => ({
  name,
  data: new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures', name))),
});

function nodesOfType(node: JSONContent, type: string): JSONContent[] {
  return [...(node.type === type ? [node] : []), ...(node.content ?? []).flatMap((child) => nodesOfType(child, type))];
}

const plainText = (node: JSONContent): string => node.text ?? (node.content ?? []).map(plainText).join('');

/** Every block's text, in order, which is how the checks below look for lost or merged content. */
const blockTexts = (content: JSONContent): string[] => (content.content ?? []).map(plainText);

describe('round trips', () => {
  it('keeps everything through HTML', async () => {
    const page = documentToHtml('Round trip', RICH);
    const result = await importFile(picked('Round trip.html', page));
    expect(result.title).toBe('Round trip');
    expect(result.content).toEqual(canonical(RICH));
    expect(result.warnings).toBeUndefined();
  });

  it('keeps everything through Markdown', async () => {
    const markdown = documentToMarkdown('Round trip', RICH);
    const result = await importFile(picked('Round trip.md', markdown));
    expect(result.title).toBe('Round trip');
    expect(result.content).toEqual(canonical(RICH));
  });

  it('keeps everything through Word', async () => {
    const bytes = await documentToDocx('Round trip', RICH);
    const result = await importFile(picked('Round trip.docx', bytes));
    expect(result.title).toBe('Round trip');
    expect(result.content).toEqual(canonical(RICH));
    expect(result.warnings).toBeUndefined();
  });

  it('keeps the words through plain text', async () => {
    const result = await importFile(picked('Round trip.txt', documentToText('Round trip', RICH)));
    expect(result.title).toBe('Round trip');
    const lines = blockTexts(result.content);
    expect(lines[0]).toBe('First heading');
    expect(lines).toContain('Second heading');
    expect(lines).toContain('- Bullet one');
    expect(lines).toContain('- Nested bullet');
    expect(lines).toContain('1. Number one');
    expect(lines).toContain('> A quotation with weight');
    expect(lines.join(' ')).toContain('underlined, struck, all three, code() and a link.');
  });

  it('does not add a copy of the title on every round trip', async () => {
    let content = doc(paragraph(text('Body')));
    for (let i = 0; i < 3; i += 1) {
      const bytes = await documentToDocx('Q3: Plans & goals', content);
      content = (await importFile(picked('Q3 Plans & goals.docx', bytes))).content;
    }
    expect(blockTexts(content)).toEqual(['Body']);
  });

  it('keeps a first heading that only looks like the title once it is the second block', async () => {
    const content = doc(heading(1, 'Intro'), paragraph(text('Body')));
    const result = await importFile(picked('Intro.md', documentToMarkdown('Intro', content)));
    expect(blockTexts(result.content)).toEqual(['Intro', 'Body']);
  });

  it('survives text that looks like markup', async () => {
    const tricky = doc(
      paragraph(text('Use <script>alert(1)</script> & &amp; carefully')),
      paragraph(text('2 * 3 * 4, snake_case_name, ~~not struck~~, [not a link](x), `not code`')),
      paragraph(text('# not a heading')),
      paragraph(text('1. not a list')),
      paragraph(text('- not a bullet')),
    );
    for (const [name, data] of [
      ['Tricky.md', documentToMarkdown('Tricky', tricky)],
      ['Tricky.html', documentToHtml('Tricky', tricky)],
      ['Tricky.docx', await documentToDocx('Tricky', tricky)],
    ] as const) {
      const result = await importFile(picked(name, data));
      expect(result.content, name).toEqual(canonical(tricky));
    }
  });

  it('keeps marks that touch each other and marks inside a word', async () => {
    const tight = doc(
      paragraph(text('un'), text('believ', 'italic'), text('able')),
      paragraph(text('a', 'italic'), text('b', 'bold')),
      paragraph(text('a', 'bold'), text('b', 'italic')),
      paragraph(linked('whole', 'https://example.com'), text(' '), linked('bold link', 'https://example.org', 'bold')),
    );
    const result = await importFile(picked('Tight.md', documentToMarkdown('Tight', tight)));
    expect(result.content).toEqual(canonical(tight));
  });

  it('keeps list numbering, multi-paragraph items and mixed nesting', async () => {
    const lists = doc(
      { type: 'orderedList', attrs: { start: 4 }, content: [item(paragraph(text('Fourth'))), item(paragraph(text('Fifth')))] },
      paragraph(text('Between')),
      bullets(
        item(
          paragraph(text('Mixed')),
          numbers(item(paragraph(text('Inner one'))), item(paragraph(text('Inner two')))),
        ),
      ),
      paragraph(text('Between again')),
      numbers(
        item(
          paragraph(text('Lead')),
          paragraph(text('Follow-up')),
          { type: 'blockquote', content: [paragraph(text('Quoted in an item'))] },
          { type: 'codeBlock', attrs: { language: null }, content: [text('code in an item\n  indented')] },
        ),
        item(paragraph(text('Next'))),
      ),
      { type: 'blockquote', content: [bullets(item(paragraph(text('Listed in a quote'))))] },
    );
    for (const [name, data] of [
      ['Lists.md', documentToMarkdown('Lists', lists)],
      ['Lists.html', documentToHtml('Lists', lists)],
    ] as const) {
      expect((await importFile(picked(name, data))).content, name).toEqual(canonical(lists));
    }
  });
});

describe('documentToMarkdown', () => {
  it('writes ATX headings, dash bullets and fenced code', () => {
    const markdown = documentToMarkdown('The title', RICH);
    expect(markdown.split('\n')).toEqual(
      expect.arrayContaining([
        '# The title',
        '# First heading',
        '## Second heading',
        '### Third heading',
        '- Bullet one',
        '  - Nested bullet',
        '  - Another',
        '- Bullet two',
        '1. Number one',
        '   1. Nested number',
        '2. Number two',
        '> A quotation with **weight**',
        '---',
        '```',
      ]),
    );
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('~~struck~~');
    expect(markdown).toContain('<u>underlined</u>');
    expect(markdown).toContain('`code()`');
    expect(markdown).toContain('[link](https://example.com/a?b=1&c=2)');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('keeps a list tight when no item has more than one paragraph', () => {
    const markdown = documentToMarkdown('', doc(bullets(item(paragraph(text('One'))), item(paragraph(text('Two'))))));
    expect(markdown).toBe('- One\n- Two\n');
  });

  it('leaves the title out when there is none', () => {
    expect(documentToMarkdown('  ', doc(paragraph(text('Body'))))).toBe('Body\n');
  });
});

describe('documentToText', () => {
  it('writes plain lines with the title first', () => {
    expect(
      documentToText(
        'Plan',
        doc(
          heading(1, 'Start'),
          paragraph(text('One'), { type: 'hardBreak' }, text('Two')),
          bullets(item(paragraph(text('Bullet')), bullets(item(paragraph(text('Inner')))))),
          { type: 'orderedList', attrs: { start: 3 }, content: [item(paragraph(text('Third')))] },
          { type: 'blockquote', content: [paragraph(text('Quoted')), paragraph(text('Again'))] },
          { type: 'horizontalRule' },
          { type: 'codeBlock', content: [text('a\n  b')] },
        ),
      ),
    ).toBe(
      ['Plan', 'Start', 'One\nTwo', '- Bullet\n  - Inner', '3. Third', '> Quoted\n> \n> Again', '---', 'a\n  b'].join('\n\n') + '\n',
    );
  });
});

describe('documentToHtml', () => {
  it('is a complete page with an escaped title', () => {
    const page = documentToHtml('Fish & <chips>', doc(paragraph(text('Body'))));
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<title>Fish &amp; &lt;chips&gt;</title>');
    expect(page).toContain('<h1>Fish &amp; &lt;chips&gt;</h1>');
    expect(page).toContain('<p>Body</p>');
    expect(page).toContain('@media print');
    expect(page.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('still has a page title for an untitled document', () => {
    const page = documentToHtml('', doc(paragraph(text('Body'))));
    expect(page).toContain('<title>Untitled</title>');
    expect(page).not.toContain('<h1>');
  });
});

describe('documentToDocx', () => {
  async function parts(bytes: Uint8Array): Promise<Record<string, string>> {
    const zip = await JSZip.loadAsync(bytes);
    const out: Record<string, string> = {};
    for (const name of Object.keys(zip.files)) {
      if (!zip.files[name].dir) out[name] = await zip.files[name].async('string');
    }
    return out;
  }

  function xml(source: string): Document {
    const parsed = new DOMParser().parseFromString(source, 'application/xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    return parsed;
  }

  const paragraphsOf = (documentXml: string): string[] => documentXml.match(/<w:p[ >].*?<\/w:p>/gs) ?? [];

  it('is a well-formed package whose references all resolve', async () => {
    const files = await parts(await documentToDocx('The title', RICH));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml']),
    );
    for (const [name, source] of Object.entries(files)) {
      if (/\.(xml|rels)$/.test(name)) xml(source);
    }

    const document = files['word/document.xml'];
    const numbering = files['word/numbering.xml'];
    const styles = files['word/styles.xml'];
    const rels = files['word/_rels/document.xml.rels'];

    const usedStyles = new Set([...document.matchAll(/<w:(?:p|r)Style w:val="([^"]+)"/g)].map((m) => m[1]));
    for (const style of usedStyles) expect(styles, `style ${style}`).toContain(`w:styleId="${style}"`);

    const usedLists = new Set([...document.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]));
    expect(usedLists.size).toBe(4);
    for (const id of usedLists) expect(numbering, `list ${id}`).toContain(`<w:num w:numId="${id}"`);

    const usedLinks = [...document.matchAll(/<w:hyperlink [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    expect(usedLinks).toHaveLength(1);
    expect(rels).toContain(`Id="${usedLinks[0]}"`);
  });

  it('writes the title, headings and marks', async () => {
    const files = await parts(await documentToDocx('The title', RICH));
    const document = files['word/document.xml'];
    const blocks = paragraphsOf(document);
    expect(blocks[0]).toContain('<w:pStyle w:val="Title"/>');
    expect(blocks[0]).toContain('The title');
    expect(files['docProps/core.xml']).toContain('<dc:title>The title</dc:title>');
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('<w:pStyle w:val="Heading2"/>');
    expect(document).toContain('<w:pStyle w:val="Heading3"/>');

    const run = (word: string) => document.match(new RegExp(`<w:r>(?:(?!</w:r>).)*${word}.*?</w:r>`, 's'))?.[0] ?? '';
    expect(run('>bold<')).toContain('<w:b/>');
    expect(run('>italic<')).toContain('<w:i/>');
    expect(run('>underlined<')).toMatch(/<w:u w:val="single"/);
    expect(run('>struck<')).toContain('<w:strike/>');
    expect(run('>code\\(\\)<')).toContain('<w:rStyle w:val="Code"/>');
    expect(run('>all three<')).toMatch(/<w:b\/>.*<w:i\/>.*<w:u /s);
  });

  it('writes links as real hyperlinks', async () => {
    const files = await parts(await documentToDocx('T', RICH));
    expect(files['word/document.xml']).toMatch(/<w:hyperlink [^>]*r:id="[^"]+"[^>]*>.*?>link<.*?<\/w:hyperlink>/s);
    expect(files['word/_rels/document.xml.rels']).toMatch(
      /Target="https:\/\/example\.com\/a\?b=1&amp;c=2" TargetMode="External"|TargetMode="External" Target="https:\/\/example\.com\/a\?b=1&amp;c=2"/,
    );
  });

  it('keeps neighboring runs with the same target in one hyperlink', async () => {
    const content = doc(paragraph(linked('one ', 'https://a.example/'), linked('two', 'https://a.example/', 'bold'), linked('three', 'https://b.example/')));
    const files = await parts(await documentToDocx('', content));
    expect(files['word/document.xml'].match(/<w:hyperlink /g)).toHaveLength(2);
  });

  it('writes targets Word accepts, and plain text for those it cannot', async () => {
    const content = doc(
      paragraph(linked('spaces', 'https://example.com/a b')),
      paragraph(linked('unsafe', 'javascript:alert(1)')),
      paragraph(linked('relative', 'notes/today.html')),
    );
    const files = await parts(await documentToDocx('', content));
    expect(files['word/document.xml'].match(/<w:hyperlink /g)).toHaveLength(1);
    expect(files['word/_rels/document.xml.rels']).toContain('https://example.com/a%20b');
    expect(files['word/_rels/document.xml.rels']).not.toContain('javascript:');
    expect(files['word/document.xml']).toContain('>unsafe<');
    expect(files['word/document.xml']).toContain('>relative<');
  });

  it('gives bullets and numbers real numbering, nested and restarting', async () => {
    const content = doc(
      numbers(item(paragraph(text('A1'))), item(paragraph(text('A2')))),
      paragraph(text('Between')),
      numbers(item(paragraph(text('B1')))),
      bullets(item(paragraph(text('C1')), numbers(item(paragraph(text('C1a'))))), item(paragraph(text('C2')), numbers(item(paragraph(text('C2a')))))),
      { type: 'orderedList', attrs: { start: 7 }, content: [item(paragraph(text('D7')))] },
    );
    const files = await parts(await documentToDocx('', content));
    const blocks = paragraphsOf(files['word/document.xml']);
    const listOf = (word: string) => {
      const block = blocks.find((b) => b.includes(`>${word}<`)) ?? '';
      return { id: block.match(/<w:numId w:val="(\d+)"/)?.[1], level: block.match(/<w:ilvl w:val="(\d+)"/)?.[1] };
    };

    expect(listOf('A1').id).toBe(listOf('A2').id);
    expect(listOf('B1').id).not.toBe(listOf('A1').id);
    expect(listOf('C1').id).toBe(listOf('C2').id);
    expect(listOf('C1a').id).not.toBe(listOf('C2a').id);
    expect(listOf('A1').level).toBe('0');
    expect(listOf('C1a').level).toBe('1');
    expect(blocks.find((b) => b.includes('>Between<'))).not.toContain('w:numPr');

    const numbering = xml(files['word/numbering.xml']);
    const abstractOf = (id: string | undefined) =>
      Array.from(numbering.getElementsByTagName('w:num'))
        .find((num) => num.getAttribute('w:numId') === id)
        ?.getElementsByTagName('w:abstractNumId')[0]
        .getAttribute('w:val');
    const levelOf = (word: string) => {
      const { id, level } = listOf(word);
      const abstract = Array.from(numbering.getElementsByTagName('w:abstractNum')).find(
        (candidate) => candidate.getAttribute('w:abstractNumId') === abstractOf(id),
      );
      return Array.from(abstract?.getElementsByTagName('w:lvl') ?? []).find((lvl) => lvl.getAttribute('w:ilvl') === level);
    };
    const format = (word: string) => levelOf(word)?.getElementsByTagName('w:numFmt')[0].getAttribute('w:val');
    const start = (word: string) => levelOf(word)?.getElementsByTagName('w:start')[0].getAttribute('w:val');

    expect(format('A1')).toBe('decimal');
    expect(format('C1')).toBe('bullet');
    expect(format('C1a')).toBe('decimal');
    expect(start('D7')).toBe('7');
    // Each list counts by itself, so a nested list cannot carry on from the one before it.
    expect(abstractOf(listOf('C1a').id)).not.toBe(abstractOf(listOf('C2a').id));
  });

  it('lines up the paragraphs of a list item, and quotes and code inside it', async () => {
    const content = doc(
      bullets(
        item(
          paragraph(text('Lead')),
          paragraph(text('Follow-up')),
          { type: 'blockquote', content: [paragraph(text('Inner quote'))] },
          { type: 'codeBlock', content: [text('inner code')] },
        ),
      ),
    );
    const files = await parts(await documentToDocx('', content));
    const blocks = paragraphsOf(files['word/document.xml']);
    const block = (word: string) => blocks.find((b) => b.includes(`>${word}<`)) ?? '';
    expect(block('Follow-up')).toContain('w:left="360"');
    expect(block('Follow-up')).not.toContain('w:numPr');
    expect(block('Inner quote')).toContain('<w:pStyle w:val="Quote"/>');
    expect(block('Inner quote')).toContain('w:left="720"');
    expect(block('inner code')).toContain('<w:pStyle w:val="CodeBlock"/>');
    expect(block('inner code')).toContain('w:left="360"');
  });

  it('keeps a list inside a quote indented at every level', async () => {
    const content = doc({
      type: 'blockquote',
      content: [bullets(item(paragraph(text('Outer')), bullets(item(paragraph(text('Inner'))))))],
    });
    const files = await parts(await documentToDocx('', content));
    const numbering = xml(files['word/numbering.xml']);
    const leftAt = (abstract: Element, level: string) =>
      Number(
        Array.from(abstract.getElementsByTagName('w:lvl'))
          .find((lvl) => lvl.getAttribute('w:ilvl') === level)
          ?.getElementsByTagName('w:ind')[0]
          .getAttribute('w:left'),
      );
    const ours = Array.from(numbering.getElementsByTagName('w:abstractNum')).filter((abstract) => {
      const first = Array.from(abstract.getElementsByTagName('w:lvl'))[0];
      return first?.getElementsByTagName('w:lvlText')[0].getAttribute('w:val') === '•';
    });
    expect(ours).toHaveLength(2);
    expect(leftAt(ours[0], '0')).toBe(720);
    expect(leftAt(ours[1], '1')).toBe(1080);
  });

  it('writes quotes, rules, line breaks and tabs as Word elements', async () => {
    const content = doc(
      { type: 'blockquote', content: [paragraph(text('Quoted'))] },
      { type: 'horizontalRule' },
      paragraph(text('one'), { type: 'hardBreak' }, text('two')),
      { type: 'codeBlock', content: [text('a\n\tb')] },
    );
    const files = await parts(await documentToDocx('', content));
    const document = files['word/document.xml'];
    expect(document).toContain('<w:pStyle w:val="Quote"/>');
    expect(document).toContain('<w:pStyle w:val="HorizontalRule"/>');
    expect(files['word/styles.xml']).toMatch(/w:styleId="HorizontalRule".*?<w:pBdr>.*?<w:bottom /s);
    expect(document.match(/<w:br\/>/g)).toHaveLength(2);
    expect(document).toContain('<w:tab/>');
    expect(document).not.toContain('\t');
  });

  it('never writes characters XML cannot carry', async () => {
    const bad = 'a\u0001b\u0008c\u000bd\u000ce\u001ff\ufffeg\uffffh\ud800i\udc00j';
    const files = await parts(await documentToDocx(`Title ${bad}`, doc(paragraph(text(bad)), paragraph(linked('x', `https://example.com/${bad}`)))));
    for (const name of ['word/document.xml', 'docProps/core.xml', 'word/_rels/document.xml.rels']) {
      xml(files[name]);
      expect(files[name], name).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])/);
    }
    expect(files['word/document.xml']).toContain('abcdefghij');
    // Emoji are surrogate pairs and must not be mistaken for broken ones.
    const emoji = await parts(await documentToDocx('', doc(paragraph(text('Good 😀 work')))));
    expect(emoji['word/document.xml']).toContain('Good 😀 work');
  });

  it('writes an empty document that still has a paragraph', async () => {
    const files = await parts(await documentToDocx('', { type: 'doc', content: [{ type: 'paragraph' }] }));
    expect(paragraphsOf(files['word/document.xml']).length + (files['word/document.xml'].match(/<w:p\/>/g)?.length ?? 0)).toBe(1);
  });

  it('does not let Word show its compatibility mode banner', async () => {
    const files = await parts(await documentToDocx('T', RICH));
    expect(files['word/settings.xml']).toMatch(/<w:compatSetting w:val="15" w:name="compatibilityMode"/);
  });
});

describe('importFile', () => {
  it('takes the title from the file name, whatever its case or dots', async () => {
    expect((await importFile(picked('Report.final.TXT', 'Hello'))).title).toBe('Report.final');
    expect((await importFile(picked('.txt', 'Hello'))).title).toBe('Untitled');
  });

  it('keeps a text file as paragraphs', async () => {
    const result = await importFile(picked('notes.txt', 'First line\r\nSecond line\n\n# A heading\n'));
    expect(result.content).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'A heading' }] },
      ],
    });
  });

  it('gives an empty file one empty paragraph', async () => {
    for (const name of ['empty.txt', 'empty.md', 'empty.html']) {
      expect((await importFile(picked(name, ''))).content, name).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    }
  });

  it('reads a web page through the schema', async () => {
    const result = await importFile(fixture('page.html'));
    expect(result.title).toBe('page');
    const all = plainText(result.content);
    expect(all).not.toMatch(/stolen|leaked|script text|color: (red|blue)|Ignored page title/);

    expect(result.content.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(nodesOfType(result.content, 'text').find((n) => n.text === 'bold')?.marks).toEqual([{ type: 'bold' }]);
    expect(nodesOfType(result.content, 'text').find((n) => n.text === 'italic')?.marks).toEqual([{ type: 'italic' }]);
    expect(nodesOfType(result.content, 'text').find((n) => n.text === 'underlined')?.marks).toEqual([{ type: 'underline' }]);

    const link = nodesOfType(result.content, 'text').find((n) => n.text === 'The report')?.marks?.[0];
    expect(link?.attrs?.href).toBe('https://example.com/report?a=1&b=2');
    expect(nodesOfType(result.content, 'text').find((n) => n.text?.includes('a bad link'))?.marks).toBeUndefined();

    // Deeper headings stay headings, at the deepest level the editor has.
    expect(result.content.content?.find((n) => plainText(n) === 'A deep heading')).toMatchObject({ type: 'heading', attrs: { level: 3 } });
    expect(nodesOfType(result.content, 'bulletList').length).toBeGreaterThanOrEqual(2);
    expect(blockTexts(result.content)).toEqual(expect.arrayContaining(['Targets', 'Region', 'Goal', 'North', '12', 'In a cell']));
    expect(nodesOfType(result.content, 'bulletList').some((list) => plainText(list) === 'In a cell')).toBe(true);

    expect(result.warnings).toEqual(['1 image was left out, because Wordsmith documents hold text only.']);
    // The picture's paragraph goes with it.
    expect(blockTexts(result.content)).not.toContain('');
  });

  it('reads Markdown through the same path', async () => {
    const result = await importFile(fixture('notes.md'));
    const texts = nodesOfType(result.content, 'text');
    const marksOf = (word: string) => texts.find((n) => n.text === word)?.marks?.map((m) => m.type);
    expect(result.content.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(result.content.content?.find((n) => plainText(n) === 'Actions')).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(marksOf('bold')).toEqual(['bold']);
    expect(marksOf('italic')).toEqual(['italic']);
    expect(marksOf('struck')).toEqual(['strike']);
    expect(marksOf('code')).toEqual(['code']);
    expect(marksOf('underlined')).toEqual(['underline']);
    expect(marksOf('link')).toEqual(['link']);
    expect(nodesOfType(result.content, 'bulletList')).toHaveLength(2);
    expect(nodesOfType(result.content, 'orderedList')[0].attrs?.start).toBe(3);
    expect(nodesOfType(result.content, 'blockquote')).toHaveLength(1);
    expect(nodesOfType(result.content, 'codeBlock')[0]).toMatchObject({ attrs: { language: 'js' } });
    expect(nodesOfType(result.content, 'horizontalRule')).toHaveLength(1);
    expect(blockTexts(result.content)).toEqual(expect.arrayContaining(['Name', 'Role', 'Ana', 'Lead']));
    expect(result.warnings).toEqual(['1 image was left out, because Wordsmith documents hold text only.']);
  });

  it('flattens tables so that no two cells run together', async () => {
    const result = await importFile(
      picked('t.html', '<table><tr><td>One</td><td><b>Two</b></td></tr><tr><td><table><tr><td>Inner</td></tr></table></td><td><p>A</p><p>B</p></td></tr></table>'),
    );
    expect(blockTexts(result.content)).toEqual(['One', 'Two', 'Inner', 'A', 'B']);
    expect(nodesOfType(result.content, 'text')[1].marks).toEqual([{ type: 'bold' }]);
  });

  it('counts dropped images in the plural', async () => {
    const result = await importFile(picked('i.html', '<p>Text <img src="a.png"> more</p><img src="b.png"><img src="c.png">'));
    expect(result.warnings).toEqual(['3 images were left out, because Wordsmith documents hold text only.']);
    expect(blockTexts(result.content)).toEqual(['Text more']);
  });

  it('leaves no empty line where a linked picture was', async () => {
    const result = await importFile(picked('i.html', '<p>Before</p><p><a href="https://example.com"><img src="a.png"></a></p><p>After</p>'));
    expect(blockTexts(result.content)).toEqual(['Before', 'After']);
  });

  it('keeps the text of a first block that only matches because neither has any letters', async () => {
    const result = await importFile(picked('---.txt', '***\n\nBody'));
    expect(blockTexts(result.content)).toEqual(['***', 'Body']);
  });

  it('removes a first block that repeats the file name, in any format', async () => {
    expect(blockTexts((await importFile(picked('Plan.txt', 'Plan\n\nBody'))).content)).toEqual(['Body']);
    expect(blockTexts((await importFile(picked('Plan.md', '# Plan\n\nBody'))).content)).toEqual(['Body']);
    expect(blockTexts((await importFile(picked('Plan.html', '<h2>plan</h2><p>Body</p>'))).content)).toEqual(['Body']);
    expect((await importFile(picked('Plan.txt', 'Plan'))).content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('reads a Word file from part of a larger buffer', async () => {
    const bytes = await documentToDocx('Body', doc(paragraph(text('Inside'))));
    const padded = new Uint8Array(bytes.length + 64);
    padded.set(bytes, 32);
    const result = await importFile(picked('Other.docx', padded.subarray(32, 32 + bytes.length)));
    expect(blockTexts(result.content)).toEqual(['Body', 'Inside']);
  });
});

describe('files written by Word itself', () => {
  /** How many lists a piece of text sits inside, or -1 if it is not in the document. */
  function listDepth(node: JSONContent, wanted: string, depth = 0): number {
    if (node.text === wanted) return depth;
    const here = node.type === 'bulletList' || node.type === 'orderedList' ? depth + 1 : depth;
    for (const child of node.content ?? []) {
      const found = listDepth(child, wanted, here);
      if (found >= 0) return found;
    }
    return -1;
  }

  it('keeps what matters from a document typed in Word', async () => {
    const result = await importFile(fixture('word-authored.docx'));
    expect(result.title).toBe('word-authored');
    expect(result.warnings).toEqual(['1 image was left out, because Wordsmith documents hold text only.']);

    const blocks = result.content.content ?? [];
    const block = (wanted: string) => blocks.find((candidate) => plainText(candidate) === wanted);
    expect(block('Annual report')).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(block('Overview')).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(block('Details')).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(block('Finer points')).toMatchObject({ type: 'heading', attrs: { level: 3 } });
    expect(block('A fourth-level heading')).toMatchObject({ type: 'heading', attrs: { level: 3 } });

    const texts = nodesOfType(result.content, 'text');
    const marksOf = (wanted: string) => texts.find((node) => node.text === wanted)?.marks?.map((mark) => mark.type);
    expect(marksOf('bold words')).toEqual(['bold']);
    expect(marksOf('italic words')).toEqual(['italic']);
    expect(marksOf('underlined words')).toEqual(['underline']);
    expect(marksOf('struck words')).toEqual(['strike']);
    expect(texts.find((node) => node.text === 'the full report')?.marks?.[0].attrs?.href).toBe('https://example.com/report?year=2026');

    expect(nodesOfType(result.content, 'bulletList').map(plainText)).toEqual(['First bulletMiddle bulletSecond bullet']);
    expect(nodesOfType(result.content, 'orderedList').map(plainText)).toEqual(['First stepMiddle stepSecond step']);
    expect(nodesOfType(result.content, 'blockquote').map(plainText)).toEqual(['A wise person said this.']);

    const order = blockTexts(result.content);
    expect(order.slice(order.indexOf('Before the table'), order.indexOf('Before the table') + 6)).toEqual([
      'Before the table',
      'Region',
      'Sales',
      'North',
      'Up 12%',
      'Before the picture',
    ]);
    expect(order).not.toContain('');
  });

  it('keeps nested lists in our own export after it was edited and saved in Word', async () => {
    const { data } = fixture('edited-in-word.docx');
    const result = await importFile(picked('Lists in Word.docx', data));
    const blocks = blockTexts(result.content);
    expect(blocks[0]).toBe('A: plain numbers');
    expect(blocks.at(-1)).toBe('Added in Word.');

    expect(listDepth(result.content, 'A1')).toBe(1);
    expect(listDepth(result.content, 'C1')).toBe(1);
    expect(listDepth(result.content, 'C1a')).toBe(2);
    expect(listDepth(result.content, 'C2a')).toBe(2);
    expect(listDepth(result.content, 'E1a-ii')).toBe(3);
    expect(listDepth(result.content, 'Depth 5')).toBe(5);
    // Mammoth stops nesting at five levels, but the words beyond that must still arrive.
    for (let depth = 6; depth <= 11; depth += 1) expect(plainText(result.content)).toContain(`Depth ${depth}`);

    const lists = nodesOfType(result.content, 'bulletList').filter((list) => plainText(list).startsWith('C1'));
    expect(nodesOfType(lists[0], 'orderedList').map(plainText)).toEqual(['C1aC1b', 'C2a']);
  });
});

describe('text decoding', () => {
  const SAMPLE = 'Café “quoted” — 日本語 😀';

  function utf16(value: string, littleEndian: boolean): Uint8Array {
    const bytes = new Uint8Array(2 + value.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, littleEndian);
    for (let i = 0; i < value.length; i += 1) view.setUint16(2 + i * 2, value.charCodeAt(i), littleEndian);
    return bytes;
  }

  it('reads UTF-8 and strips its byte order mark', async () => {
    expect(blockTexts((await importFile(picked('a.txt', SAMPLE))).content)).toEqual([SAMPLE]);
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(SAMPLE)]);
    expect(blockTexts((await importFile(picked('a.txt', withMark))).content)).toEqual([SAMPLE]);
  });

  it('honors UTF-16 byte order marks in both directions', async () => {
    for (const littleEndian of [true, false]) {
      const result = await importFile(picked('a.txt', utf16(SAMPLE, littleEndian)));
      expect(blockTexts(result.content)).toEqual([SAMPLE]);
      expect(result.warnings).toBeUndefined();
    }
  });

  it('applies to Markdown and web pages too', async () => {
    const markdown = await importFile(picked('a.md', utf16(`# ${SAMPLE}\n\nBody`, true)));
    expect(markdown.content.content?.[0]).toMatchObject({ type: 'heading', content: [{ text: SAMPLE }] });
    const page = await importFile(picked('a.html', utf16(`<p>${SAMPLE}</p>`, false)));
    expect(blockTexts(page.content)).toEqual([SAMPLE]);
  });

  it('warns about text that is not valid UTF-8', async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const result = await importFile(picked('a.txt', latin1));
    expect(result.warnings?.[0]).toContain('UTF-8');
  });
});

describe('bad input', () => {
  it('rejects unsupported types and says what is supported', async () => {
    await expect(importFile(picked('photo.png', new Uint8Array([1, 2, 3])))).rejects.toThrow(
      'Wordsmith can\'t import "photo.png". Choose a .docx, .html, .htm, .md, .markdown, or .txt file.',
    );
    await expect(importFile(picked('README', 'Hello'))).rejects.toThrow('Choose a .docx');
  });

  it('tells people what to do with an old .doc file', async () => {
    await expect(importFile(picked('Old.DOC', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])))).rejects.toThrow(
      '"Old.DOC" uses the older .doc format. Open it in Word, save it as .docx, and import that.',
    );
  });

  it('rejects files that are not Word documents at all', async () => {
    for (const data of [new Uint8Array(0), utf8('this is not a zip file'), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]) {
      await expect(importFile(picked('Fake.docx', data))).rejects.toThrow(/"Fake\.docx" could not be opened.*save a new copy as \.docx/);
    }
  });

  it('rejects a Word file cut off in the middle', async () => {
    const bytes = await documentToDocx('T', RICH);
    await expect(importFile(picked('Cut.docx', bytes.slice(0, bytes.length / 2)))).rejects.toThrow('"Cut.docx" could not be opened');
  });

  it('rejects a zip file that holds no document', async () => {
    const zip = new JSZip();
    zip.file('notes.txt', 'Hello');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(importFile(picked('Other.docx', bytes))).rejects.toThrow('"Other.docx" could not be opened');
  });

  it('rejects a Word file whose document is not valid XML', async () => {
    const zip = await JSZip.loadAsync(await documentToDocx('T', RICH));
    zip.file('word/document.xml', '<w:document><w:body><w:p>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(importFile(picked('Broken.docx', bytes))).rejects.toThrow('"Broken.docx" could not be opened');
  });

  it('rejects binary data with a text file name', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    for (const name of ['Picture.txt', 'Picture.md', 'Picture.html']) {
      await expect(importFile(picked(name, png))).rejects.toThrow(`"${name}" is not a text file`);
    }
  });
});

describe('saving, copying and printing', () => {
  const titled = doc(heading(1, 'Heading'), paragraph(text('Body '), text('bold', 'bold')));

  /** happy-dom has no window.print to spy on. */
  function stubPrint() {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    return print;
  }

  async function load(bridge?: Partial<DesktopBridge>) {
    vi.resetModules();
    window.wordsmith = bridge as DesktopBridge | undefined;
    return import('@renderer/lib/exporters');
  }

  afterEach(() => {
    delete window.wordsmith;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('on the desktop', () => {
    const decoded = (request: SaveFileRequest) => new TextDecoder().decode(request.data);

    it.each([
      ['html', 'Web page', '<h1>Heading</h1>'],
      ['md', 'Markdown', '# Heading'],
      ['txt', 'Plain text', 'Body bold'],
    ] as const)('saves %s through the file dialog', async (kind, description, expected) => {
      const saveFile = vi.fn(async () => ({ saved: true, path: `C:/out.${kind}` }));
      const { exportDocument } = await load({ saveFile });
      const result = await exportDocument(kind, 'Plan: A/B', titled);
      expect(result).toEqual({ saved: true, path: `C:/out.${kind}` });
      const request = saveFile.mock.calls[0] as unknown as [SaveFileRequest];
      expect(request[0]).toMatchObject({ defaultName: `Plan A B.${kind}`, description, extensions: [kind] });
      expect(decoded(request[0])).toContain(expected);
    });

    it('saves a Word file that opens as a zip', async () => {
      const saveFile = vi.fn(async (_request: SaveFileRequest) => ({ saved: false }));
      const { exportDocument } = await load({ saveFile });
      expect(await exportDocument('docx', 'Plan', titled)).toEqual({ saved: false });
      const [request] = saveFile.mock.calls[0];
      expect(request).toMatchObject({ defaultName: 'Plan.docx', description: 'Word document', extensions: ['docx'] });
      expect(Object.keys((await JSZip.loadAsync(request.data)).files)).toContain('word/document.xml');
    });

    it('saves a PDF through the shell', async () => {
      const savePdf = vi.fn(async () => ({ saved: true, path: 'C:/out.pdf' }));
      const print = stubPrint();
      const { exportDocument } = await load({ savePdf });
      expect(await exportDocument('pdf', 'Plan: A', titled)).toEqual({ saved: true, path: 'C:/out.pdf' });
      expect(savePdf).toHaveBeenCalledWith('Plan A.pdf');
      expect(print).not.toHaveBeenCalled();
    });

    it('prints through the shell', async () => {
      const printBridge = vi.fn(async () => undefined);
      const print = stubPrint();
      const { printDocument } = await load({ print: printBridge });
      await printDocument();
      expect(printBridge).toHaveBeenCalledOnce();
      expect(print).not.toHaveBeenCalled();
    });

    it('copies as plain text through the shell when the clipboard refuses formats', async () => {
      const writeClipboard = vi.fn(async () => undefined);
      vi.stubGlobal('ClipboardItem', class {});
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: vi.fn().mockRejectedValue(new Error('denied')) } });
      const { copyFormatted } = await load({ writeClipboard });
      await copyFormatted(titled);
      expect(writeClipboard).toHaveBeenCalledWith('Heading\n\nBody bold');
    });
  });

  describe('in a browser', () => {
    it('downloads a file with the right name and type', async () => {
      const { exportDocument } = await load();
      const blobs: Blob[] = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        blobs.push(blob as Blob);
        return 'blob:test';
      });
      const clicked: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      });
      expect(await exportDocument('md', 'Plan', titled)).toEqual({ saved: true });
      expect(clicked).toEqual(['Plan.md']);
      expect(blobs[0].type).toBe('text/markdown');
      expect(await blobs[0].text()).toContain('# Plan\n\n# Heading');
    });

    it('prints for a PDF and does not claim anything was saved', async () => {
      const print = stubPrint();
      const { exportDocument } = await load();
      expect(await exportDocument('pdf', 'Plan', titled)).toEqual({ saved: false });
      expect(print).toHaveBeenCalledOnce();
    });

    it('prints the page', async () => {
      const print = stubPrint();
      const { printDocument } = await load();
      await printDocument();
      expect(print).toHaveBeenCalledOnce();
    });

    it('copies as plain text if formatted copying is missing', async () => {
      const writeText = vi.fn(async () => undefined);
      vi.stubGlobal('ClipboardItem', undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      const { copyFormatted } = await load();
      await copyFormatted(titled);
      expect(writeText).toHaveBeenCalledWith('Heading\n\nBody bold');
    });
  });

  describe('the formatted copy', () => {
    let items: Record<string, Blob>[];

    beforeEach(() => {
      items = [];
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(public parts: Record<string, Blob>) {}
        },
      );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          write: vi.fn(async (written: { parts: Record<string, Blob> }[]) => {
            items = written.map((entry) => entry.parts);
          }),
        },
      });
    });

    async function copied(content: JSONContent) {
      const { copyFormatted } = await load();
      await copyFormatted(content);
      expect(items).toHaveLength(1);
      expect(items[0]['text/html'].type).toBe('text/html');
      expect(items[0]['text/plain'].type).toBe('text/plain');
      const html = await items[0]['text/html'].text();
      const parsed = new DOMParser().parseFromString(html, 'text/html').body;
      return { html, parsed, text: await items[0]['text/plain'].text() };
    }

    it('writes both flavors', async () => {
      const { text: plain, parsed } = await copied(RICH);
      expect(plain).toContain('- Bullet one\n  - Nested bullet');
      expect(plain).not.toContain('<');
      expect(parsed.querySelector('h1')?.textContent).toBe('First heading');
      expect(parsed.querySelector('strong')?.textContent).toBe('bold');
      expect(parsed.querySelector('em')?.textContent).toBe('italic');
      expect(parsed.querySelector('u')?.textContent).toBe('underlined');
      expect(parsed.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a?b=1&c=2');
      expect(parsed.querySelectorAll('ul ul li')).toHaveLength(2);
      expect(parsed.querySelectorAll('ol ol li')).toHaveLength(1);
    });

    it('inlines the styling Word and Outlook need', async () => {
      const { parsed } = await copied(RICH);
      for (const selector of ['h1', 'h2', 'h3', 'p', 'li']) {
        expect(parsed.querySelector(selector)?.getAttribute('style'), selector).toMatch(/font-family:.*font-size:/);
      }
      expect(parsed.querySelector('h1')?.getAttribute('style')).toContain('font-weight:bold');
      expect(parsed.querySelector('strong')?.getAttribute('style')).toContain('font-weight:bold');
      expect(parsed.querySelector('em')?.getAttribute('style')).toContain('font-style:italic');
      expect(parsed.querySelector('a')?.getAttribute('style')).toContain('text-decoration:underline');
      expect(parsed.querySelector('ul')?.getAttribute('style')).toContain('padding-left');
    });

    it('puts the look of a quote on its paragraphs, where Word keeps it', async () => {
      const { parsed } = await copied(doc({ type: 'blockquote', content: [paragraph(text('Quoted'))] }, paragraph(text('Not quoted'))));
      const [quoted, plain] = Array.from(parsed.querySelectorAll('p'));
      expect(quoted.getAttribute('style')).toMatch(/margin:0 0 8pt;margin-left:12pt;.*border-left:/);
      expect(plain.getAttribute('style')).not.toContain('border-left');
    });

    it('unwraps single paragraphs in list items but keeps real ones', async () => {
      const { parsed } = await copied(
        doc(bullets(item(paragraph(text('Solo'))), item(paragraph(text('One')), paragraph(text('Two'))), item(paragraph(text('Lead')), bullets(item(paragraph(text('Inner'))))))),
      );
      const [solo, pair, lead] = Array.from(parsed.querySelectorAll('ul')[0].children);
      expect(solo.querySelector('p')).toBeNull();
      expect(solo.textContent).toBe('Solo');
      expect(pair.querySelectorAll('p')).toHaveLength(2);
      expect(lead.querySelector('p')).toBeNull();
      expect(lead.firstChild?.textContent).toBe('Lead');
      expect(lead.querySelector('ul li')?.textContent).toBe('Inner');
    });
  });

  it('keeps a copy of the title for printing, so that it can wrap', async () => {
    document.body.innerHTML = '<div class="page"><input class="title-input" value="A very long title"></div>';
    stubPrint();
    const { printDocument } = await load();
    await printDocument();
    expect(document.querySelector('.page')?.getAttribute('data-print-title')).toBe('A very long title');

    document.querySelector<HTMLInputElement>('.title-input')!.value = 'Changed';
    window.dispatchEvent(new Event('beforeprint'));
    expect(document.querySelector('.page')?.getAttribute('data-print-title')).toBe('Changed');
    document.body.innerHTML = '';
  });
});
