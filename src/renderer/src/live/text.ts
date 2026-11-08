/**
 * The live overlay's text logic, apart from its page so that it can be tested: how the text of
 * a message or document splits into blocks for the engine, how an edit moves the underlines
 * with their words, and the fingerprint that tells the helper which text the offsets belong to.
 */
import type { Block, Issue } from '@engine/types';
import type { LiveRect } from '@shared/api';

/** Where a flagged word is: its issue, its place in the whole text, and where it is drawn. */
export interface Placed {
  issue: Issue;
  start: number;
  end: number;
  /** The block's text when it was checked. */
  blockText: string;
  rects: LiveRect[];
}

/** Word ends a paragraph with \r and a table cell with \u0007. Each break is a block boundary. */
const BREAKS = /\r\n|[\r\n\u0007]/g;

/** The text as the engine's blocks, with where each block starts in the text. */
export function toBlocks(text: string): { blocks: Block[]; starts: number[] } {
  const blocks: Block[] = [];
  const starts: number[] = [];
  let last = 0;
  const push = (from: number, to: number) => {
    // A soft line break (Shift+Enter, and how Outlook stores pasted lines) stays inside its
    // paragraph as an ordinary line break, one character for one, so offsets still match.
    blocks.push({ text: text.slice(from, to).replace(/\u000b/g, '\n'), kind: 'paragraph' });
    starts.push(from);
  };
  for (const match of text.matchAll(BREAKS)) {
    push(last, match.index);
    last = match.index + match[0].length;
  }
  push(last, text.length);
  return { blocks, starts };
}

/** What a range holds against what was flagged. Spacing is not the point, and apps copy it differently. */
export const squeeze = (text: string): string => text.replace(/\s+/g, '');

/** Paragraph and table cell ends. A soft line break stays inside its paragraph. */
const PARAGRAPH_END = /[\r\n\u0007]/g;

/** Where the paragraph holding `from` ends. */
export function paragraphEnd(text: string, from: number): number {
  PARAGRAPH_END.lastIndex = from;
  const match = PARAGRAPH_END.exec(text);
  return match ? match.index : text.length;
}

/**
 * A 32-bit FNV-1a hash of the text's UTF-16 code units. The helper computes the same, so that
 * it can refuse to measure offsets that belong to text it no longer has.
 */
export function fingerprint(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface Edit<T> {
  /** What the edit did not touch, with offsets that match the new text. */
  kept: T[];
  /** Where the edit starts, and where it ends in the new text. */
  start: number;
  end: number;
}

/**
 * Where the text changed between two readings. Ranges the edit touched come off; ranges after
 * it move with their words; ranges before it stay as they were.
 */
export function applyEdit<T extends { start: number; end: number }>(placed: T[], before: string, after: string): Edit<T> {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  const oldEnd = before.length - suffix;
  const delta = after.length - before.length;
  const kept = placed.flatMap((p) => {
    if (p.end < prefix) return [p];
    if (p.start >= oldEnd) return [{ ...p, start: p.start + delta, end: p.end + delta }];
    return [];
  });
  return { kept, start: prefix, end: oldEnd + delta };
}
