/**
 * Turning text copied from another app into something the quick editor can show,
 * and turning the edited paragraphs back into what gets pasted.
 *
 * The app's own formatting never enters the editor. Its HTML is kept aside, and
 * edits are patched into it, so that fonts, links, and bold survive the round trip
 * even though the writer only saw plain paragraphs.
 */
import type { JSONContent } from '@tiptap/core';
import { applyEdits, diffText, readBlocks } from '@shared/html-text';
import type { QuickResult } from '@shared/api';

export interface QuickDocument {
  paragraphs: string[];
  /** Build what to paste. Call with the paragraphs as they stand in the editor. */
  finish(edited: string[]): QuickResult;
}

interface Source {
  text: string;
  html: string | null;
}

/** Inline objects read as this in a block, and as a space in the editor, which keeps offsets equal. */
const OBJECT = /￼/g;
const showable = (text: string) => text.replace(OBJECT, ' ');

const lineEnding = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const endsWithNewline = (text: string) => /[\r\n]$/.test(text);
const compact = (text: string) => text.replace(/\s+/g, '');

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

function plainDocument({ text }: Source): QuickDocument {
  const eol = lineEnding(text);
  return {
    paragraphs: text.split(/\r\n|\r|\n/),
    finish: (edited) => ({ text: edited.join(eol), html: null }),
  };
}

/**
 * The markup to paste for a selection inside one paragraph. Pasting a whole <p>
 * makes Word and Outlook start a new paragraph in the middle of the writer's line.
 */
function innerContent(body: HTMLElement): string {
  let element: Element = body;
  for (;;) {
    const onlyChild = element.childElementCount === 1 ? element.firstElementChild : null;
    const hasOwnText = Array.from(element.childNodes).some((node) => node.nodeType === 3 && node.textContent?.trim());
    if (!onlyChild || hasOwnText || /^(a|b|i|u|em|strong|span|font|sub|sup|code|s|mark)$/i.test(onlyChild.tagName)) break;
    element = onlyChild;
  }
  return element.innerHTML;
}

/** Rebuild the HTML with the edits applied, or null if any of them cannot be placed. */
function patch(html: string, edited: string[], wholeParagraphs: boolean): string | null {
  const doc = parse(html);
  const blocks = readBlocks(doc.body);
  if (blocks.length !== edited.length) return null;
  for (const [index, block] of blocks.entries()) {
    const edits = diffText(showable(block.text), edited[index]);
    if (edits.length > 0 && !applyEdits(block, edits)) return null;
  }
  return blocks.length === 1 && !wholeParagraphs ? innerContent(doc.body) : doc.body.innerHTML;
}

function richDocument(source: Source & { html: string }, paragraphs: string[]): QuickDocument {
  const eol = lineEnding(source.text);
  const trailing = endsWithNewline(source.text);
  return {
    paragraphs,
    finish(edited) {
      const text = edited.join(eol) + (trailing ? eol : '');
      return {
        text,
        html: patch(source.html, edited, trailing) ?? edited.map((p) => `<p>${escapeHtml(p)}</p>`).join(''),
      };
    },
  };
}

/** Prepare captured text for the editor. */
export function openCapture(source: Source): QuickDocument {
  if (source.html === null) return plainDocument(source);
  const blocks = readBlocks(parse(source.html).body);
  const paragraphs = blocks.map((block) => showable(block.text));
  // Some apps put HTML on the clipboard that does not match the text, such as a
  // code editor's colored version. Only trust it if it says the same thing.
  const said = compact(paragraphs.join(''));
  const trusted = said.length > 0 && said.length >= compact(source.text).length * 0.8;
  return trusted ? richDocument({ ...source, html: source.html }, paragraphs) : plainDocument(source);
}

/** The editor's document for a list of paragraphs. A line break within one becomes a hard break. */
export function paragraphsToContent(paragraphs: string[]): JSONContent {
  return {
    type: 'doc',
    content: paragraphs.map((paragraph) => {
      const content: JSONContent[] = [];
      paragraph.split('\n').forEach((line, index) => {
        if (index > 0) content.push({ type: 'hardBreak' });
        if (line) content.push({ type: 'text', text: line });
      });
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}
