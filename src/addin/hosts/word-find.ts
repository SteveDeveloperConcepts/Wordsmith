/**
 * Turning a character offset into something Word can find.
 *
 * Word's API cannot make a range from an offset. The only route is search, and
 * search answers with every match, so a target has to be named by its text plus
 * which match it is, counted from the paragraph text. Everything here is plain
 * string work, so it can be tested without Word.
 */
import { OBJECT } from '@shared/html-text';

/** The longest search string Word accepts, counted after escaping. */
export const MAX_QUERY = 255;

/**
 * Footnote marks, pictures, and field markers sit in Word's text stream as single
 * placeholder characters, which have no search notation.
 */
const UNSEARCHABLE = /[\u0000-\u0008\n\f\r\u000E-\u001D￼�]/;

const NOTATION: Record<string, string> = {
  '^': '^^',
  '\t': '^t',
  '\v': '^l',
  ' ': '^s',
  '\u001E': '^~',
  '\u001F': '^-',
};

export function escapeQuery(raw: string): string {
  return raw.replace(/[\^\t\v \u001E\u001F]/g, (ch) => NOTATION[ch]);
}

/**
 * The text the engine sees, the same length as Word's, so offsets carry across
 * unchanged. Placeholders read as objects, soft line breaks as line breaks, and
 * non-breaking spaces and hyphens as the plain characters a writer sees.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000E-\u001D�]/g, OBJECT)
    .replace(/[\v\f\r]/g, '\n')
    .replace(/ /g, ' ')
    .replace(/\u001E/g, '-');
}

export interface Term {
  raw: string;
  query: string;
  /** Offset of `raw` in the text being searched. */
  start: number;
}

export interface Plan {
  /** One term, or a first and a last when the text is too long or holds an object. */
  terms: Term[];
  /** The span the terms cover, which is narrower if the text starts or ends with an object. */
  from: number;
  to: number;
}

const isLowSurrogate = (ch: string | undefined) => ch !== undefined && ch >= '\uDC00' && ch <= '\uDFFF';

function term(text: string, start: number, end: number): Term {
  const raw = text.slice(start, end);
  return { raw, query: escapeQuery(raw), start };
}

function headTerm(text: string, from: number, to: number): Term {
  let length = 0;
  let end = from;
  while (end < to && !UNSEARCHABLE.test(text[end])) {
    length += escapeQuery(text[end]).length;
    if (length > MAX_QUERY) break;
    end++;
  }
  if (end < to && isLowSurrogate(text[end])) end--;
  return term(text, from, end);
}

function tailTerm(text: string, from: number, to: number): Term {
  let length = 0;
  let start = to;
  while (start > from && !UNSEARCHABLE.test(text[start - 1])) {
    length += escapeQuery(text[start - 1]).length;
    if (length > MAX_QUERY) break;
    start--;
  }
  if (start > from && isLowSurrogate(text[start])) start++;
  return term(text, start, to);
}

/** The searches that pin down text[from, to), or null if nothing in it can be searched for. */
export function planSearch(text: string, from: number, to: number): Plan | null {
  let start = from;
  let end = to;
  while (start < end && UNSEARCHABLE.test(text[start])) start++;
  while (end > start && UNSEARCHABLE.test(text[end - 1])) end--;
  if (start === end) return null;

  const head = headTerm(text, start, end);
  if (head.start + head.raw.length === end) return { terms: [head], from: start, to: end };
  return { terms: [head, tailTerm(text, start, end)], from: start, to: end };
}

/** Word's Find treats these as the same character, so a search can match more than an exact count finds. */
function fold(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ');
}

function occurrences(text: string, raw: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(raw); at !== -1; at = text.indexOf(raw, at + raw.length)) found.push(at);
  return found;
}

/**
 * Which of Word's matches is the wanted one, or -1 if that cannot be known.
 *
 * A count alone would not be enough: tracked deletions hide matches and folded
 * characters add them, and either would shift the target onto the wrong text. So a
 * count is trusted only if every match lines up with the text at the offset the
 * count predicts for it.
 */
export function pickMatch(text: string, wanted: Term, matches: string[]): number {
  for (const view of [(s: string) => s, fold]) {
    const expected = occurrences(view(text), view(wanted.raw));
    const index = expected.indexOf(wanted.start);
    if (index === -1 || expected.length !== matches.length) continue;
    const agrees = expected.every((at, i) => matches[i] === text.slice(at, at + wanted.raw.length));
    if (agrees) return index;
  }
  return -1;
}

const isBreak = (ch: string) => /\s/.test(ch) || UNSEARCHABLE.test(ch);

/**
 * Widens [from, to) to whole words, so a one-letter change is not hunted as a
 * one-letter search with hundreds of matches. An insertion between two spaces leans
 * on the word before it, or failing that the word after.
 */
export function anchorFor(text: string, from: number, to: number): { from: number; to: number } | null {
  let start = from;
  let end = to;
  while (start > 0 && !isBreak(text[start - 1])) start--;
  while (end < text.length && !isBreak(text[end])) end++;
  if (start < end) return { from: start, to: end };

  while (start > 0 && isBreak(text[start - 1])) start--;
  if (start > 0) {
    while (start > 0 && !isBreak(text[start - 1])) start--;
    return { from: start, to: end };
  }
  start = from;
  while (end < text.length && isBreak(text[end])) end++;
  if (end === text.length) return null;
  while (end < text.length && !isBreak(text[end])) end++;
  return { from: start, to: end };
}

/** True when an edit would overwrite something that is not plain text. */
export function coversObject(text: string, from: number, to: number): boolean {
  return UNSEARCHABLE.test(text.slice(from, to));
}
