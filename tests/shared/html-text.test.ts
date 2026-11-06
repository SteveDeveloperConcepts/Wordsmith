// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { applyEdits, diffText, readBlocks, type ReadOptions, type TextEdit } from '@shared/html-text';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const read = (html: string, options?: ReadOptions) => readBlocks(parse(html).body, options);
const texts = (html: string, options?: ReadOptions) => read(html, options).map((b) => b.text);

/** Replace the first occurrence of `find` in the block, and return the resulting body HTML. */
function replace(html: string, find: string, text: string, block = 0): string {
  const doc = parse(html);
  const target = readBlocks(doc.body)[block];
  const from = target.text.indexOf(find);
  expect(from, `"${find}" should be in "${target.text}"`).toBeGreaterThanOrEqual(0);
  expect(applyEdits(target, [{ from, to: from + find.length, text }])).toBe(true);
  return doc.body.innerHTML;
}

describe('readBlocks', () => {
  it('makes one block per paragraph-like element', () => {
    expect(texts('<p>One.</p><div>Two.</div><h2>Three</h2><ul><li>Four</li><li>Five</li></ul>')).toEqual([
      'One.',
      'Two.',
      'Three',
      'Four',
      'Five',
    ]);
  });

  it('labels the kind of each block', () => {
    const kinds = read('<p>a</p><h1>b</h1><ul><li>c</li></ul><blockquote><p>d</p></blockquote><pre>e</pre>').map((b) => b.kind);
    expect(kinds).toEqual(['paragraph', 'heading', 'list', 'quote', 'code']);
  });

  it('joins inline elements into one block', () => {
    expect(texts('<p>This <b>is</b> <a href="#">one <i>line</i></a>.</p>')).toEqual(['This is one line.']);
  });

  it('collapses whitespace the way a browser renders it', () => {
    expect(texts('<p>\n   Too    many\n\tspaces   <b> here </b>  .  </p>')).toEqual(['Too many spaces here .']);
  });

  it('reads non-breaking spaces as plain spaces', () => {
    expect(texts('<p>One&nbsp;two&nbsp;&nbsp;three</p>')).toEqual(['One two three']);
  });

  it('turns <br> into a line break and drops trailing ones', () => {
    expect(texts('<p>First line <br>Second line<br></p>')).toEqual(['First line\nSecond line']);
  });

  it('keeps <pre> text exactly', () => {
    expect(texts('<pre>a   b\n  c</pre>')).toEqual(['a   b\n  c']);
  });

  it('ignores styles, scripts, and comments', () => {
    expect(texts('<style>p{color:red}</style><p>Text<!-- note --></p><script>alert(1)</script>')).toEqual(['Text']);
  });

  it('keeps an inline image as a placeholder so offsets stay honest', () => {
    const [block] = read('<p>See <img src="x.png"> here</p>');
    expect(block.text).toBe('See ￼ here');
    expect(block.sources).toHaveLength(block.text.length);
  });

  it('gives table cells their own blocks', () => {
    expect(texts('<table><tr><td>One</td><td>Two</td></tr></table>')).toEqual(['One', 'Two']);
  });

  it('leaves out skipped elements', () => {
    const skip = (el: Element) => el.id === 'Signature';
    expect(texts('<p>Hello.</p><div id="Signature"><p>Jo Smith</p></div><p>Bye.</p>', { skip })).toEqual(['Hello.', 'Bye.']);
  });

  it('stops at a boundary, leaving out all that follows', () => {
    const stop = (el: Element) => el.id === 'divRplyFwdMsg';
    const html = '<div><p>My reply.</p></div><hr><div id="divRplyFwdMsg"><b>From:</b> Sam</div><div>Quoted text.</div>';
    expect(texts(html, { stop })).toEqual(['My reply.']);
  });
});

describe('applyEdits', () => {
  it('changes only the text it touches', () => {
    const html = '<p style="color:red">Their is <b class="x">a lot</b> here.</p>';
    expect(replace(html, 'Their', 'There')).toBe('<p style="color:red">There is <b class="x">a lot</b> here.</p>');
  });

  it('keeps formatting on the word being replaced', () => {
    expect(replace('<p>The <b>grammer</b> is off.</p>', 'grammer', 'grammar')).toBe('<p>The <b>grammar</b> is off.</p>');
  });

  it('keeps links', () => {
    const html = '<p>Read <a href="https://example.com">teh guide</a> now.</p>';
    expect(replace(html, 'teh', 'the')).toBe('<p>Read <a href="https://example.com">the guide</a> now.</p>');
  });

  it('handles a fix that spans several formatted runs', () => {
    expect(replace('<p>at <b>this</b> point in <i>time</i> we go</p>', 'at this point in time', 'now')).toBe(
      '<p>now<b></b><i></i> we go</p>',
    );
  });

  it('deletes a collapsed run of whitespace as one character', () => {
    expect(replace('<p>one &nbsp; two</p>', 'one two', 'one-two')).toBe('<p>one-two</p>');
  });

  it('inserts with the formatting of the text before it', () => {
    const doc = parse('<p><b>However</b> we left.</p>');
    const [block] = readBlocks(doc.body);
    expect(applyEdits(block, [{ from: 7, to: 7, text: ',' }])).toBe(true);
    expect(doc.body.innerHTML).toBe('<p><b>However,</b> we left.</p>');
  });

  it('applies several edits in one block, in any order', () => {
    const doc = parse('<p>Their is <b>alot</b> of mistaks.</p>');
    const [block] = readBlocks(doc.body);
    const edits: TextEdit[] = [
      { from: 0, to: 5, text: 'There' },
      { from: 17, to: 24, text: 'mistakes' },
      { from: 9, to: 13, text: 'a lot' },
    ];
    expect(block.text.slice(9, 13)).toBe('alot');
    expect(block.text.slice(17, 24)).toBe('mistaks');
    expect(applyEdits(block, edits)).toBe(true);
    expect(doc.body.innerHTML).toBe('<p>There is <b>a lot</b> of mistakes.</p>');
  });

  it('leaves the rest of the document alone', () => {
    const before = '<p>Keep <i>this</i>.</p><p>Fix teh word.</p><p>Keep that.</p>';
    expect(replace(before, 'teh', 'the', 1)).toBe('<p>Keep <i>this</i>.</p><p>Fix the word.</p><p>Keep that.</p>');
  });

  it('works around an inline image', () => {
    const doc = parse('<p>See <img src="x.png"> teh picture</p>');
    const [block] = readBlocks(doc.body);
    const from = block.text.indexOf('teh');
    expect(applyEdits(block, [{ from, to: from + 3, text: 'the' }])).toBe(true);
    expect(doc.body.innerHTML).toBe('<p>See <img src="x.png"> the picture</p>');
  });

  it('refuses edits outside the block or overlapping each other', () => {
    const [block] = read('<p>Short.</p>');
    expect(applyEdits(block, [{ from: 2, to: 99, text: 'x' }])).toBe(false);
    expect(
      applyEdits(block, [
        { from: 0, to: 3, text: 'a' },
        { from: 2, to: 4, text: 'b' },
      ]),
    ).toBe(false);
  });

  it('survives a round trip through a full Outlook-style document', () => {
    const html = `<html><head><style>p{margin:0}</style></head><body lang="EN-US">
      <div class="WordSection1"><p class="MsoNormal"><span style="font-family:Calibri">Thanks for you&#39;re help,</span></p>
      <p class="MsoNormal"><span style="font-family:Calibri">&nbsp;</span></p></div></body></html>`;
    const doc = parse(html);
    const blocks = readBlocks(doc.body);
    expect(blocks.map((b) => b.text)).toEqual(["Thanks for you're help,"]);
    const from = blocks[0].text.indexOf("you're");
    expect(applyEdits(blocks[0], [{ from, to: from + 6, text: 'your' }])).toBe(true);
    const output = doc.documentElement.outerHTML;
    expect(output).toContain('Thanks for your help,');
    expect(output).toContain('font-family:Calibri');
    expect(output).toContain('class="MsoNormal"');
    expect(output).toContain('p{margin:0}');
  });
});

describe('diffText', () => {
  const apply = (before: string, edits: TextEdit[]) => {
    let out = before;
    for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
      out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
    }
    return out;
  };

  it.each([
    ['', ''],
    ['same', 'same'],
    ['', 'new text'],
    ['old text', ''],
    ['Their is alot of mistaks here.', 'There is a lot of mistakes here.'],
    ['One two three four five.', 'One three five.'],
    ['Hello world', 'Hello, wide world!'],
    ['a b c d e f', 'x b y d z f'],
    ['日本語のテキスト', '日本語の文章'],
    ['😀 emoji stays 😀', '😀 emoji moved 😀'],
  ])('turns %j into %j', (before, after) => {
    expect(apply(before, diffText(before, after))).toBe(after);
  });

  it('returns nothing when the text is unchanged', () => {
    expect(diffText('same', 'same')).toEqual([]);
  });

  it('keeps edits small, so untouched words keep their formatting', () => {
    const edits = diffText('Their is alot of reasons to stay here.', 'There is a lot of reasons to stay here.');
    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({ from: 3, to: 5, text: 're' });
    expect(edits.every((e) => e.to - e.from <= 5)).toBe(true);
  });

  it('turns a change into edits that the HTML layer can apply', () => {
    const doc = parse('<p>Their is <b>alot</b> of mistaks.</p>');
    const [block] = readBlocks(doc.body);
    expect(applyEdits(block, diffText(block.text, 'There is a lot of mistakes.'))).toBe(true);
    expect(doc.body.textContent).toBe('There is a lot of mistakes.');
    expect(doc.querySelector('b')?.textContent).toBe('a lot');
  });
});
