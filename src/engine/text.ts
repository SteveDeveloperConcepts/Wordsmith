/**
 * Text utilities: word tokenizing, sentence splitting, syllable counting, hashing.
 * All offsets are UTF-16 code units, matching JavaScript string indices.
 */

export interface Token {
  text: string;
  from: number;
  to: number;
}

export interface Sentence {
  from: number;
  to: number;
  text: string;
  words: number;
  /** Offset of the first letter or digit (skipping opening quotes and brackets). */
  firstWord: number;
}

/** A word: letters/digits, optionally joined by apostrophes, hyphens, or inner periods (e.g. "don't", "well-known", "3.14"). */
const WORD_SOURCE = "[\\p{L}\\p{N}]+(?:[’'\\-.][\\p{L}\\p{N}]+)*";

export function wordRegex(): RegExp {
  return new RegExp(WORD_SOURCE, 'gu');
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = wordRegex();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], from: m.index, to: m.index + m[0].length });
  }
  return out;
}

export function countWords(text: string): number {
  const re = wordRegex();
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** Abbreviations whose trailing period does not end a sentence. Stored lowercase, without the final period. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'inc', 'ltd', 'co',
  'corp', 'fig', 'approx', 'dept', 'est', 'gen', 'gov', 'sen', 'rep', 'rev', 'hon', 'capt', 'col', 'lt',
  'sgt', 'cmdr', 'mt', 'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sept', 'oct', 'nov', 'dec', 'a.m', 'p.m',
  'u.s', 'u.k', 'u.n', 'u.s.a', 'ph.d', 'b.a', 'm.a', 'b.s', 'm.s', 'm.d', 'al', 'cf', 'viz', 'ave', 'blvd',
  'vol', 'pp', 'eds', 'misc', 'tel', 'ext', 'messrs', 'mmes',
]);

const TERMINATORS = '.!?…';
const CLOSERS = '"\'’”)]}»';
const OPENERS = '"\'‘“([{«';

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** The run of letters (and inner periods) immediately before index `i`. */
function wordBefore(text: string, i: number): string {
  let s = i;
  while (s > 0) {
    const ch = text[s - 1];
    if (isWordChar(ch)) s--;
    else if (ch === '.' && s - 2 >= 0 && isWordChar(text[s - 2])) s--;
    else break;
  }
  return text.slice(s, i);
}

/**
 * Split text into sentences. Handles common abbreviations, initials, decimals,
 * ellipses, and closing quotes or brackets after the end mark. Line breaks always split.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const n = text.length;

  const push = (a: number, b: number) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b <= a) return;
    const slice = text.slice(a, b);
    const words = countWords(slice);
    if (words === 0) {
      // Stray punctuation: attach to the previous sentence rather than counting a new one.
      if (out.length > 0) {
        const prev = out[out.length - 1];
        prev.to = b;
        prev.text = text.slice(prev.from, b);
      }
      return;
    }
    let first = a;
    while (first < b && OPENERS.includes(text[first])) first++;
    out.push({ from: a, to: b, text: slice, words, firstWord: first });
  };

  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') {
      push(start, i);
      start = i + 1;
      i++;
      continue;
    }
    if (TERMINATORS.includes(ch)) {
      let j = i + 1;
      while (j < n && TERMINATORS.includes(text[j])) j++;
      let k = j;
      while (k < n && CLOSERS.includes(text[k])) k++;
      const atEnd = k >= n;
      const followedBySpace = !atEnd && /\s/.test(text[k]);
      if (atEnd || followedBySpace) {
        let boundary = true;
        if (!atEnd && ch === '.' && j === i + 1) {
          const word = wordBefore(text, i);
          const lower = word.toLowerCase();
          let m = k;
          while (m < n && /[^\S\n]/.test(text[m])) m++;
          const next = m < n ? text[m] : '';
          if (ABBREVIATIONS.has(lower)) boundary = false;
          else if (lower === 'no' && /\d/.test(next)) boundary = false;
          else if (word.length === 1 && /\p{Lu}/u.test(word) && /\p{Lu}/u.test(next)) boundary = false;
        }
        if (boundary) {
          push(start, k);
          start = k;
        }
      }
      i = Math.max(k, i + 1);
      continue;
    }
    i++;
  }
  push(start, n);
  return out;
}

/** Index of the sentence containing `offset`, or -1. */
export function sentenceAt(sentences: Sentence[], offset: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sentences[mid];
    if (offset < s.from) hi = mid - 1;
    else if (offset >= s.to) lo = mid + 1;
    else return mid;
  }
  // Offsets in the whitespace between sentences belong to the following sentence if any.
  return -1;
}

const SYLLABLE_OVERRIDES: Record<string, number> = {
  the: 1, are: 1, were: 1, where: 1, there: 1, here: 1, one: 1, once: 1, some: 1, come: 1, done: 1, gone: 1,
  people: 2, every: 2, business: 2, different: 3, interesting: 3, area: 3, idea: 3, being: 2, doing: 2,
  going: 2, create: 2, created: 3, science: 2, quiet: 2, real: 1, really: 2, usually: 4, actually: 4,
  beautiful: 3, family: 3, evening: 2, average: 3, several: 3, camera: 3, chocolate: 3, comfortable: 3,
  vegetable: 3, queue: 1, eye: 1, eyes: 1, ok: 2, simile: 3, recipe: 3, maybe: 2, something: 2,
  someone: 2, somewhere: 2, sometimes: 2, anyone: 3, everyone: 3, everything: 3, hour: 1, our: 1, fire: 1,
};

/** Estimate the number of syllables in an English word. */
export function countSyllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return /\d/.test(word) ? 1 : 0;
  const override = SYLLABLE_OVERRIDES[w];
  if (override !== undefined) return override;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  w = w.replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** FNV-1a 32-bit hash, base-36 encoded. Used for stable issue ids and cache keys. */
export function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Number of user-perceived characters (code points), so an emoji counts once. */
export function countCodePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
