/**
 * Shared plumbing for Wordsmith's built-in rules: the per-block context, the
 * goal-derived profile, and helpers for building fixes.
 */
import { capitalize, escapeRegExp, splitSentences, type Sentence } from '../text';
import type { BlockKind, Category, Dialect, EngineSettings, Fix, IssueType } from '../types';

/** Which rule families are active, derived from the writer's goals and options. */
export interface Profile {
  longSentences: boolean;
  /** Word count above which a sentence is flagged as hard to read. */
  longSentence: number;
  passive: 'all' | 'agent-only' | 'none';
  fillers: boolean;
  complexWords: boolean;
  hedging: boolean;
  slang: boolean;
  /** Formal writing: contractions, exclamation marks, sentence-initial conjunctions. */
  formal: boolean;
  politeness: boolean;
  fragments: boolean;
  cliches: boolean;
  weakWords: boolean;
  inclusive: boolean;
  profanity: boolean;
}

export function buildProfile(settings: EngineSettings): Profile {
  const g = settings.goals;
  const casual = g.domain === 'casual' || g.formality === 'informal';
  const creative = g.domain === 'creative';
  const story = g.intent === 'tell-story';
  const formal = g.formality === 'formal' || g.domain === 'academic';
  const base = g.audience === 'general' ? 28 : g.audience === 'knowledgeable' ? 33 : 40;
  const longSentence = creative || story ? Math.max(base, 42) : base;

  let passive: Profile['passive'] = 'all';
  if (!settings.options.passiveVoice || creative || story || casual) passive = 'none';
  else if (g.domain === 'academic' || g.audience === 'expert') passive = 'agent-only';

  return {
    longSentences: settings.options.longSentences,
    longSentence,
    passive,
    fillers: !casual && !creative,
    complexWords: g.audience !== 'expert' && g.domain !== 'academic' && !creative,
    hedging: !casual && !creative && !story,
    slang: !casual && !creative,
    formal,
    politeness: g.domain === 'email' || g.domain === 'business',
    fragments: !casual && !creative && !story,
    cliches: !casual,
    weakWords: true,
    inclusive: settings.options.inclusiveLanguage,
    profanity: !creative && !(g.domain === 'casual' && g.formality === 'informal'),
  };
}

export interface RuleContext {
  text: string;
  /** `text` with curly quotes straightened. Same length, so offsets are interchangeable. */
  norm: string;
  kind: BlockKind;
  sentences: Sentence[];
  profile: Profile;
  dialect: Dialect;
  /** True for the block being edited: rules that fire on unfinished text stay quiet. */
  editing: boolean;
  /** URLs, email addresses, handles: never flagged by the built-in rules. */
  protectedRanges: Array<[number, number]>;
  sentenceStarts: Set<number>;
}

export interface RawIssue {
  from: number;
  to: number;
  ruleId: string;
  category: Category;
  type: IssueType;
  title: string;
  message: string;
  fixes: Fix[];
  sentenceLevel?: boolean;
  rewriteHint?: string;
  word?: string;
  /** Higher wins when two issues overlap. */
  priority: number;
}

const PROTECTED_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?<![\p{L}\p{N}])[@#][\p{L}\p{N}_]+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|edu|gov|co)\b(?:\/[^\s]*)?/giu;

export function makeContext(
  text: string,
  kind: BlockKind,
  profile: Profile,
  dialect: Dialect,
  editing: boolean,
): RuleContext {
  const sentences = splitSentences(text);
  const protectedRanges: Array<[number, number]> = [];
  PROTECTED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED_RE.exec(text)) !== null) {
    protectedRanges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) PROTECTED_RE.lastIndex++;
  }
  return {
    text,
    norm: text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"'),
    kind,
    sentences,
    profile,
    dialect,
    editing,
    protectedRanges,
    sentenceStarts: new Set(sentences.map((s) => s.firstWord)),
  };
}

export function isProtected(ctx: RuleContext, from: number, to: number): boolean {
  for (const [a, b] of ctx.protectedRanges) if (from < b && to > a) return true;
  return false;
}

/** Add an issue unless it is empty or touches a protected range. */
export function push(ctx: RuleContext, out: RawIssue[], issue: RawIssue): void {
  if (issue.to <= issue.from) return;
  if (isProtected(ctx, issue.from, issue.to)) return;
  out.push(issue);
}

export function isSentenceStart(ctx: RuleContext, offset: number): boolean {
  return ctx.sentenceStarts.has(offset);
}

/** The sentence containing `offset`, or undefined. */
export function sentenceOf(ctx: RuleContext, offset: number): Sentence | undefined {
  for (const s of ctx.sentences) if (offset >= s.from && offset < s.to) return s;
  return undefined;
}

/** Give `replacement` the capitalization the original text had. */
export function applyCase(replacement: string, original: string, sentenceStart: boolean): string {
  if (!replacement) return replacement;
  const letters = original.replace(/[^\p{L}]/gu, '');
  // A shouted multi-word phrase stays shouted; a lone acronym ("OK", "ASAP") does not.
  if (/\s/.test(original) && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (sentenceStart) return capitalize(replacement);
  const first = original[0];
  if (first && first !== first.toLowerCase() && !/^I(?:$|[^\p{L}])/u.test(original)) return capitalize(replacement);
  return replacement;
}

export function fix(from: number, to: number, text: string, label?: string): Fix {
  return { from, to, text, label: label ?? (text || 'Remove') };
}

const CONSONANT_SOUND = /^(?:uni|use|usu|uti|eu|one\b|once\b|ubiq|user)/i;
const SILENT_H = /^(?:hour|honest|honor|heir)/i;

/** Does this word take "an" rather than "a"? */
export function startsWithVowelSound(word: string): boolean {
  if (SILENT_H.test(word)) return true;
  if (CONSONANT_SOUND.test(word)) return false;
  return /^[aeiou]/i.test(word);
}

/**
 * If "a" or "an" directly precedes `at` and no longer agrees with `word`,
 * return where the article is and what it should become.
 */
function articleBefore(text: string, at: number, word: string): { from: number; text: string } | null {
  const m = /(?<![\p{L}\p{N}'’-])(an?)(\s+)$/iu.exec(text.slice(Math.max(0, at - 6), at));
  if (!m || !/^\p{L}/u.test(word)) return null;
  const wanted = startsWithVowelSound(word) ? 'an' : 'a';
  if (m[1].toLowerCase() === wanted) return null;
  const article = m[1][0] === m[1][0].toUpperCase() ? wanted[0].toUpperCase() + wanted.slice(1) : wanted;
  return { from: at - m[0].length, text: article + m[2] };
}

/** Replacement fixes for a flagged range, with capitalization (and a preceding a/an) carried over. */
export function replacements(ctx: RuleContext, from: number, to: number, options: readonly string[]): Fix[] {
  const original = ctx.text.slice(from, to);
  const start = isSentenceStart(ctx, from);
  const seen = new Set<string>();
  const out: Fix[] = [];
  for (const option of options) {
    if (option === '') {
      if (!seen.has('')) out.push(removalFix(ctx, from, to));
      seen.add('');
      continue;
    }
    const text = applyCase(option, original, start);
    if (seen.has(text) || text === original) continue;
    seen.add(text);
    const article = articleBefore(ctx.text, from, text);
    if (article) out.push({ from: article.from, to, text: article.text + text, label: text });
    else out.push({ from, to, text, label: text });
  }
  return out;
}

/**
 * A fix that deletes [from, to) and tidies what is left: the neighbouring space,
 * a paired comma, and the capital letter if the phrase opened the sentence.
 */
export function removalFix(ctx: RuleContext, from: number, to: number, label = 'Remove'): Fix {
  const t = ctx.text;
  let a = from;
  let b = to;

  if (isSentenceStart(ctx, from)) {
    if (t[b] === ',') b++;
    while (b < t.length && t[b] === ' ') b++;
    let text = '';
    if (b < t.length && /\p{Ll}/u.test(t[b])) {
      text = t[b].toUpperCase();
      b++;
    }
    return { label, from: a, to: b, text };
  }

  // ", phrase," in the middle of a clause: drop both commas.
  if (t[b] === ',' && a >= 2 && t[a - 1] === ' ' && t[a - 2] === ',') {
    return { label, from: a - 2, to: b + 1, text: '' };
  }
  if (t[b] === ' ') {
    while (b < t.length && t[b] === ' ') b++;
    // "a really interesting idea" → "an interesting idea"
    const following = /^[\p{L}'’-]+/u.exec(t.slice(b))?.[0] ?? '';
    const article = following ? articleBefore(t, a, following) : null;
    if (article) return { label, from: article.from, to: b, text: article.text };
    return { label, from: a, to: b, text: '' };
  }
  // Followed by punctuation or the end: take the space (and a comma) before it instead.
  while (a > 0 && t[a - 1] === ' ') a--;
  if (a > 0 && t[a - 1] === ',' && /[.!?]/.test(t[b] ?? '')) a--;
  return { label, from: a, to: b, text: '' };
}

const CLAUSE_PUNCT = '.!?;:,—–(["“‘\n';
const CLAUSE_WORDS = new Set([
  'and', 'but', 'or', 'so', 'because', 'if', 'when', 'while', 'although', 'though', 'that', 'since', 'unless',
  'whether', 'then', 'yet', 'once', 'after', 'before', 'until', 'whereas', 'why', 'where',
]);

/**
 * True when the word at `index` opens a clause, so it is very likely the
 * grammatical subject (start of text, after punctuation, or after a conjunction).
 */
export function clauseInitial(text: string, index: number, exclude: readonly string[] = []): boolean {
  let i = index - 1;
  while (i >= 0 && text[i] === ' ') i--;
  if (i < 0) return true;
  if (CLAUSE_PUNCT.includes(text[i])) return !(text[i] === ',' && exclude.includes(','));
  let j = i;
  while (j >= 0 && /[\p{L}'’]/u.test(text[j])) j--;
  const word = text.slice(j + 1, i + 1).toLowerCase();
  return CLAUSE_WORDS.has(word) && !exclude.includes(word);
}

/** The word (lowercased) immediately before `index`, or ''. */
export function previousWord(text: string, index: number): string {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  let j = i;
  while (j >= 0 && /[\p{L}\p{N}'’-]/u.test(text[j])) j--;
  return text.slice(j + 1, i + 1).toLowerCase();
}

/** The word (lowercased) immediately after `index`, or ''. */
export function nextWord(text: string, index: number): string {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i++;
  let j = i;
  while (j < text.length && /[\p{L}\p{N}'’-]/u.test(text[j])) j++;
  return text.slice(i, j).toLowerCase();
}

export type PhraseRow = readonly [phrase: string, replacement: string | readonly string[], note?: string];

export interface PhraseMatch {
  from: number;
  to: number;
  text: string;
  key: string;
  options: readonly string[];
  note?: string;
}

function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * A table of fixed phrases compiled into one case-insensitive regex.
 * Whitespace runs and curly apostrophes in the text are tolerated.
 */
export class PhraseTable {
  private readonly regex: RegExp;
  private readonly map = new Map<string, { options: readonly string[]; note?: string }>();

  constructor(rows: readonly PhraseRow[]) {
    const keys: string[] = [];
    for (const [phrase, replacement, note] of rows) {
      const key = normalizePhrase(phrase);
      if (this.map.has(key)) continue;
      this.map.set(key, { options: typeof replacement === 'string' ? [replacement] : replacement, note });
      keys.push(key);
    }
    keys.sort((a, b) => b.length - a.length);
    const alternatives = keys.map((k) => escapeRegExp(k).replace(/'/g, "['’]").replace(/ /g, '\\s+'));
    this.regex = new RegExp(`(?<![\\p{L}\\p{N}'’-])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}-])`, 'giu');
  }

  get size(): number {
    return this.map.size;
  }

  find(text: string): PhraseMatch[] {
    const out: PhraseMatch[] = [];
    const re = this.regex;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = normalizePhrase(m[0]);
      const entry = this.map.get(key);
      if (entry) {
        out.push({ from: m.index, to: m.index + m[0].length, text: m[0], key, options: entry.options, note: entry.note });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }
}

/** Iterate over every match of a global regex (which should carry the `d` flag when groups are needed). */
export function scan(text: string, re: RegExp, each: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    each(m);
    if (m[0].length === 0) re.lastIndex++;
  }
}

/** [start, end) of capture group `n` in a match made with the `d` flag. */
export function groupRange(m: RegExpExecArray, n: number): [number, number] | null {
  const r = m.indices?.[n];
  return r ? [r[0], r[1]] : null;
}
