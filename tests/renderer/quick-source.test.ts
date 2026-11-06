// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { openCapture, paragraphsToContent } from '@renderer/quick/source';

describe('plain text', () => {
  it('shows one paragraph per line and keeps the line endings', () => {
    const doc = openCapture({ text: 'One\r\n\r\nTwo\r\n', html: null });
    expect(doc.paragraphs).toEqual(['One', '', 'Two', '']);
    expect(doc.finish(['One', '', 'Too', '']).text).toBe('One\r\n\r\nToo\r\n');
  });

  it('leaves unchanged text exactly as it was', () => {
    const text = 'First line\n  indented\n\n\nAfter a gap';
    const doc = openCapture({ text, html: null });
    expect(doc.finish(doc.paragraphs)).toEqual({ text, html: null });
  });
});

describe('rich text', () => {
  it('patches the edit into the original HTML, keeping the formatting', () => {
    const doc = openCapture({ text: 'Their is a bold word.', html: '<p>Their is a <b style="color:red">bold</b> word.</p>' });
    expect(doc.paragraphs).toEqual(['Their is a bold word.']);
    const result = doc.finish(['There is a bold word.']);
    expect(result.text).toBe('There is a bold word.');
    expect(result.html).toBe('There is a <b style="color:red">bold</b> word.');
  });

  it('keeps several paragraphs, and their styles', () => {
    const html = '<p class="MsoNormal">Teh start.</p><ul><li>An <a href="https://example.com">item</a></li></ul>';
    const doc = openCapture({ text: 'Teh start.\r\n\r\n•\tAn item\r\n', html });
    expect(doc.paragraphs).toEqual(['Teh start.', 'An item']);
    const result = doc.finish(['The start.', 'An item']);
    expect(result.html).toBe('<p class="MsoNormal">The start.</p><ul><li>An <a href="https://example.com">item</a></li></ul>');
  });

  it('pastes the inside of one paragraph, so as not to split the line it lands in', () => {
    const doc = openCapture({ text: 'Part of a line', html: '<div><p class="MsoNormal"><span lang="EN">Part of a line</span></p></div>' });
    expect(doc.finish(['Part of the line']).html).toBe('<span lang="EN">Part of the line</span>');
  });

  it('keeps the paragraph when the selection took in the paragraph mark', () => {
    const doc = openCapture({ text: 'A whole paragraph\r\n', html: '<p>A whole paragraph</p>' });
    expect(doc.finish(['A whole paragraf']).html).toBe('<p>A whole paragraf</p>');
  });

  it('survives text around inline images', () => {
    const doc = openCapture({ text: 'See teh chart', html: '<p>See <img src="cid:one"> teh chart</p>' });
    expect(doc.paragraphs[0]).toBe('See   teh chart');
    expect(doc.finish(['See   the chart']).html).toBe('See <img src="cid:one"> the chart');
  });

  it('falls back to simple paragraphs when the writer added or removed one', () => {
    const doc = openCapture({ text: 'One\nTwo', html: '<p><b>One</b></p><p>Two</p>' });
    const result = doc.finish(['One', 'Two', 'Three <new>']);
    expect(result.text).toBe('One\nTwo\nThree <new>');
    expect(result.html).toBe('<p>One</p><p>Two</p><p>Three &lt;new&gt;</p>');
  });

  it('can be finished more than once, as when a paste had to be retried', () => {
    const doc = openCapture({ text: 'Teh word', html: '<p>Teh <i>word</i></p>' });
    expect(doc.finish(['The word']).html).toBe('The <i>word</i>');
    expect(doc.finish(['The world']).html).toBe('The <i>world</i>');
  });

  it('ignores HTML that does not say what the text says', () => {
    const doc = openCapture({ text: 'A long sentence with many words in it.', html: '<p>Copied</p>' });
    expect(doc.paragraphs).toEqual(['A long sentence with many words in it.']);
    expect(doc.finish(doc.paragraphs).html).toBeNull();
  });
});

describe('paragraphsToContent', () => {
  it('builds paragraphs, empty ones, and line breaks', () => {
    expect(paragraphsToContent(['One', '', 'Two\nlines'])).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'paragraph' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Two' }, { type: 'hardBreak' }, { type: 'text', text: 'lines' }],
        },
      ],
    });
  });
});
