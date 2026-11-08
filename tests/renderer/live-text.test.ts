import { describe, expect, it } from 'vitest';
import { applyEdit, fingerprint, paragraphEnd, toBlocks } from '@renderer/live/text';

describe('blocks from Word text', () => {
  it('splits at paragraph marks, line ends, and table cell ends', () => {
    const { blocks, starts } = toBlocks('One\rTwo\r\nThree\u0007Four');
    expect(blocks.map((b) => b.text)).toEqual(['One', 'Two', 'Three', 'Four']);
    expect(starts).toEqual([0, 4, 9, 15]);
  });

  it('keeps a soft line break inside its paragraph, one character for one', () => {
    const { blocks, starts } = toBlocks('Hi Sam,\u000bThanks.\rBye');
    expect(blocks.map((b) => b.text)).toEqual(['Hi Sam,\nThanks.', 'Bye']);
    expect(starts).toEqual([0, 16]);
  });

  it('gives an empty block for an empty paragraph, so offsets stay right', () => {
    const { blocks, starts } = toBlocks('A\r\rB');
    expect(blocks.map((b) => b.text)).toEqual(['A', '', 'B']);
    expect(starts).toEqual([0, 2, 3]);
  });
});

describe('the end of a paragraph', () => {
  it('is the next paragraph mark or cell end', () => {
    expect(paragraphEnd('One two\rThree', 2)).toBe(7);
    expect(paragraphEnd('Cell\u0007Next', 0)).toBe(4);
  });

  it('is the end of the text in the last paragraph, and ignores soft line breaks', () => {
    expect(paragraphEnd('One\u000btwo', 0)).toBe(7);
  });
});

describe('the fingerprint the helper also computes', () => {
  it('is 32-bit FNV-1a over UTF-16 code units', () => {
    expect(fingerprint('')).toBe(0x811c9dc5);
    expect(fingerprint('a')).toBe(0xe40c292c);
    expect(fingerprint('foobar')).toBe(0xbf9cf968);
  });

  it('changes with a single character', () => {
    expect(fingerprint('Their is')).not.toBe(fingerprint('There is'));
  });
});

describe('moving underlines with an edit', () => {
  const text = 'Their is alot of reasons.';
  const their = { start: 0, end: 5 };
  const alot = { start: 9, end: 13 };

  it('moves later ranges by what was typed before them', () => {
    const edit = applyEdit([their, alot], text, `Hi Sam. ${text}`);
    expect(edit.kept).toEqual([
      { start: 8, end: 13 },
      { start: 17, end: 21 },
    ]);
    expect(edit.start).toBe(0);
    expect(edit.end).toBe(8);
  });

  it('leaves earlier ranges where they were', () => {
    const edit = applyEdit([their, alot], text, `${text} Thanks.`);
    expect(edit.kept).toEqual([their, alot]);
  });

  it('drops a range the edit touched', () => {
    const edit = applyEdit([their, alot], text, text.replace('alot', 'a lot'));
    expect(edit.kept).toEqual([their]);
  });

  it('drops a range being typed onto, until the next check', () => {
    const edit = applyEdit([their], text, text.replace('Their', 'Theirs'));
    expect(edit.kept).toEqual([]);
  });

  it('follows a deletion', () => {
    const edit = applyEdit([alot], text, text.replace('Their ', ''));
    expect(edit.kept).toEqual([{ start: 3, end: 7 }]);
  });

  it('copes with a repeated letter, where the edit could be in more than one place', () => {
    const edit = applyEdit([{ start: 4, end: 8 }], 'aa  word', 'aaa  word');
    expect(edit.kept).toEqual([{ start: 5, end: 9 }]);
  });
});
