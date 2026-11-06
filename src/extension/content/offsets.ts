/** Turning offsets into a block's text back into places in the page. */
import type { HtmlBlock } from '@shared/html-text';

/** Stands in for an inline object in block text. Has no counterpart in a Range's text. */
const OBJECT = '￼';

const FLAGGED_NOISE = new RegExp(`[\\s${OBJECT}]+`, 'g');

/**
 * Whether a Range still holds the text that was flagged. Block text collapses
 * whitespace and marks line breaks, and a Range's text does neither, so spacing is ignored.
 */
export const sameFlaggedText = (a: string, b: string): boolean =>
  a.replace(FLAGGED_NOISE, '') === b.replace(FLAGGED_NOISE, '');

const spaced = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Whether two readings of a block agree. The browser turns some typed spaces into non-breaking ones. */
export const sameBlockText = (a: string, b: string): boolean => spaced(a) === spaced(b);

/**
 * The DOM range for part of a block. It may cross text nodes, and it skips line
 * breaks and images at either end. An empty span gives a collapsed range that
 * joins the text before it, so an inserted comma takes on the word's formatting.
 */
export function blockRange(block: HtmlBlock, from: number, to: number): Range | null {
  const { sources } = block;
  if (from < 0 || to > sources.length || from > to) return null;

  if (from === to) {
    for (let i = from - 1; i >= 0; i--) {
      const source = sources[i];
      if (source) return collapsed(source.node, source.end);
    }
    const next = sources.slice(from).find(Boolean);
    return next ? collapsed(next.node, next.start) : null;
  }

  let first = from;
  while (first < to && !sources[first]) first++;
  let last = to - 1;
  while (last > first && !sources[last]) last--;
  const start = sources[first];
  const end = sources[last];
  if (!start || !end) return null;

  const range = start.node.ownerDocument.createRange();
  range.setStart(start.node, start.start);
  range.setEnd(end.node, end.end);
  return range;
}

function collapsed(node: Text, offset: number): Range {
  const range = node.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  return range;
}

/** The block holding a caret, if the caret sits in its text. */
export function blockAt(blocks: HtmlBlock[], node: Node | null, offset: number): number | undefined {
  if (!node) return undefined;
  const index = blocks.findIndex((block) =>
    block.sources.some((source) => source?.node === node && source.start <= offset && offset <= source.end),
  );
  return index === -1 ? undefined : index;
}
