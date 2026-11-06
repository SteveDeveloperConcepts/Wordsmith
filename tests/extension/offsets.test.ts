// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { blockAt, blockRange, sameBlockText, sameFlaggedText } from '../../src/extension/content/offsets';
import { plainBlocks } from '../../src/extension/content/plainField';
import { readBlocks } from '@shared/html-text';

function read(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return { root, blocks: readBlocks(root) };
}

/** The exact stretch of DOM a range covers. */
function spanOf(range: Range | null) {
  if (!range) return null;
  return {
    start: [(range.startContainer as Text).data, range.startOffset],
    end: [(range.endContainer as Text).data, range.endOffset],
    text: range.toString(),
  };
}

describe('offsets into a block', () => {
  it('finds a word inside one text node', () => {
    const { blocks } = read('<div>Hello wrold today.</div>');
    const from = blocks[0].text.indexOf('wrold');
    expect(spanOf(blockRange(blocks[0], from, from + 5))?.text).toBe('wrold');
  });

  it('crosses text nodes where formatting splits a word', () => {
    const { blocks } = read('<div>One sen<b>ten</b>ce here.</div>');
    expect(blocks[0].text).toBe('One sentence here.');
    const span = spanOf(blockRange(blocks[0], 4, 12));
    expect(span?.start).toEqual(['One sen', 4]);
    expect(span?.end).toEqual(['ce here.', 2]);
    expect(span?.text).toBe('sentence');
  });

  it('crosses several nested elements', () => {
    const { blocks } = read('<div><span>a</span><i><u>b</u>c</i> <em>d</em></div>');
    expect(blocks[0].text).toBe('abc d');
    const span = spanOf(blockRange(blocks[0], 1, 5));
    expect(span?.start).toEqual(['b', 0]);
    expect(span?.end).toEqual(['d', 1]);
  });

  it('accounts for whitespace the browser collapses', () => {
    const { blocks } = read('<div>  One \n\n   two   three</div>');
    expect(blocks[0].text).toBe('One two three');
    const from = blocks[0].text.indexOf('three');
    const span = spanOf(blockRange(blocks[0], from, from + 5));
    expect(span?.text).toBe('three');
    expect(span?.start[1]).toBe('  One \n\n   two   '.length);
  });

  it('treats a non-breaking space as a space and keeps its place', () => {
    const { blocks } = read('<div>One two  three</div>');
    expect(blocks[0].text).toBe('One two three');
    expect(spanOf(blockRange(blocks[0], 8, 13))?.text).toBe('three');
  });

  it('keeps counting past a line break, which has no text node', () => {
    const { blocks } = read('<div>First line<br>Second lyne</div>');
    expect(blocks[0].text).toBe('First line\nSecond lyne');
    const from = blocks[0].text.indexOf('lyne');
    expect(spanOf(blockRange(blocks[0], from, from + 4))?.text).toBe('lyne');
  });

  it('skips a line break or image at the edge of the span', () => {
    const { blocks } = read('<div>One<br>two<img src="x">three</div>');
    expect(blocks[0].text).toBe('One\ntwo￼three');
    expect(spanOf(blockRange(blocks[0], 3, 7))?.text).toBe('two');
    expect(spanOf(blockRange(blocks[0], 7, 13))?.text).toBe('three');
  });

  it('gives nothing for a span with no text in it', () => {
    const { blocks } = read('<div>One<br>two</div>');
    expect(blockRange(blocks[0], 3, 4)).toBeNull();
  });

  it('refuses a span outside the block', () => {
    const { blocks } = read('<div>Short.</div>');
    expect(blockRange(blocks[0], 2, 40)).toBeNull();
    expect(blockRange(blocks[0], 4, 2)).toBeNull();
  });

  it('puts an insertion at the end of the text before it, so it takes on that formatting', () => {
    const { blocks } = read('<div><b>bold</b> plain</div>');
    const range = blockRange(blocks[0], 4, 4);
    expect(range?.collapsed).toBe(true);
    expect((range?.startContainer as Text).data).toBe('bold');
    expect(range?.startOffset).toBe(4);
  });

  it('puts an insertion at the very start before the first character', () => {
    const { blocks } = read('<div>  word</div>');
    const range = blockRange(blocks[0], 0, 0);
    expect(range?.collapsed).toBe(true);
    expect(range?.startOffset).toBe(2);
  });

  it('handles characters outside the basic plane, whose offsets count two units', () => {
    const { blocks } = read('<div>Hi 😀 tomorow</div>');
    const from = blocks[0].text.indexOf('tomorow');
    expect(from).toBe(6);
    expect(spanOf(blockRange(blocks[0], from, from + 7))?.text).toBe('tomorow');
  });
});

describe('finding the block under the caret', () => {
  it('matches the text node and offset', () => {
    const { root, blocks } = read('<div>One</div><div>Two <b>three</b></div>');
    const bold = root.querySelector('b')?.firstChild ?? null;
    expect(blockAt(blocks, bold, 2)).toBe(1);
    expect(blockAt(blocks, root.firstChild?.firstChild ?? null, 3)).toBe(0);
  });

  it('gives nothing when the caret is not in text', () => {
    const { root, blocks } = read('<div>One</div>');
    expect(blockAt(blocks, root, 0)).toBeUndefined();
    expect(blockAt(blocks, null, 0)).toBeUndefined();
  });
});

describe('comparing text', () => {
  it('ignores spacing and placeholders when comparing a range with flagged text', () => {
    expect(sameFlaggedText('one\n  two', 'one two')).toBe(true);
    expect(sameFlaggedText('onetwo', 'one\ntwo')).toBe(true);
    expect(sameFlaggedText('one two', 'one￼ two')).toBe(true);
    expect(sameFlaggedText('one', 'ones')).toBe(false);
  });

  it('notices a change of spacing between readings of a block, but not the kind of space', () => {
    expect(sameBlockText('one two', 'one two')).toBe(true);
    expect(sameBlockText('one,two', 'one, two')).toBe(false);
  });
});

describe('form field text', () => {
  it('gives one block per line, with offsets into the whole value', () => {
    const value = 'First line\n\n  Third line\nFourth';
    const blocks = plainBlocks(value);
    expect(blocks.map((block) => block.text)).toEqual(['First line', '  Third line', 'Fourth']);
    for (const { text, start } of blocks) expect(value.slice(start, start + text.length)).toBe(text);
  });

  it('gives nothing for an empty or blank value', () => {
    expect(plainBlocks('')).toEqual([]);
    expect(plainBlocks('  \n \n')).toEqual([]);
  });
});
