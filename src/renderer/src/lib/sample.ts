import type { JSONContent } from '@tiptap/react';

/** Build an editor document from plain paragraphs (a leading "# " makes a heading). */
export function paragraphsToDoc(paragraphs: string[]): JSONContent {
  const content: JSONContent[] = paragraphs.map((text) => {
    const heading = /^(#{1,3}) (.*)$/.exec(text);
    if (heading) {
      return {
        type: 'heading',
        attrs: { level: heading[1].length },
        content: heading[2] ? [{ type: 'text', text: heading[2] }] : [],
      };
    }
    return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Turn pasted or imported plain text into paragraphs: blank lines and line breaks both split. */
export function textToDoc(text: string): JSONContent {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphsToDoc(paragraphs);
}

export const SAMPLE_TITLE = 'Welcome to Wordsmith';

/**
 * The first document a new user sees. The mistakes are deliberate: between them
 * they trigger every category, so the underlines and the Assistant panel have
 * something to show. (tests/engine/sample.test.ts keeps this honest.)
 */
export const SAMPLE_PARAGRAPHS = [
  'This sample has a few mistakes on purpose, so you can see how Wordsmith works. Hover over any underlined text to see a suggestion, then click it to accept.',
  'Their is alot of reasons to proofread you\'re email before you send it. A message with less mistakes is more easier to read, and it make a better impression.',
  'In order to keep your writing clear, Wordsmith also flags wordy phrases. The report was written by our team in a timely manner, and it is absolutely essential that we utilize it.',
  'I think the results were very good, but at the end of the day we need to think outside the box.',
  'Hey guys, I\'m gonna need the chairman to sign off on this today!!',
  'Did you find all the mistakes. Open the Assistant panel on the right to review them one by one, check your word count and readability, or set goals for your audience.',
];
