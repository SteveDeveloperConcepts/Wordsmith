/**
 * The analyzer: runs Harper and Wordsmith's own rules over a document, merges
 * and de-duplicates the findings, and computes statistics, tone, and a score.
 */
import type { BinaryModule } from 'harper.js';
import { HarperEngine, type HarperLint } from './harper';
import {
  buildProfile,
  makeContext,
  overusedWords,
  runBlockRules,
  type Profile,
  type RawIssue,
  type RuleContext,
} from './rules';
import { sentenceOf } from './rules/context';
import { computeStats } from './stats';
import { hash } from './text';
import { detectTones } from './tone';
import {
  CATEGORIES,
  DEFAULT_ENGINE_SETTINGS,
  ISSUE_TYPES,
  type AnalysisResult,
  type AnalyzeRequest,
  type Category,
  type EngineSettings,
  type Fix,
  type Issue,
  type IssueType,
} from './types';

interface Mapping {
  category: Category;
  type: IssueType;
  title: string;
  /** Harper's suggestions for this rule are not useful (e.g. "****"). */
  dropFixes?: boolean;
}

const map = (category: Category, type: IssueType, title: string, dropFixes = false): Mapping => ({
  category,
  type,
  title,
  dropFixes,
});

/** How each Harper lint kind is presented. */
const KIND: Record<string, Mapping> = {
  Spelling: map('correctness', 'spelling', 'Correct your spelling'),
  Typo: map('correctness', 'spelling', 'Correct the typo'),
  BoundaryError: map('correctness', 'spelling', 'Correct your spelling'),
  Capitalization: map('correctness', 'spelling', 'Fix the capitalization'),
  Regionalism: map('correctness', 'spelling', 'Use the regional form'),
  Grammar: map('correctness', 'grammar', 'Correct the grammar'),
  Agreement: map('correctness', 'grammar', 'Fix the agreement'),
  WordOrder: map('correctness', 'grammar', 'Fix the word order'),
  Miscellaneous: map('correctness', 'grammar', 'Correct the grammar'),
  Usage: map('correctness', 'grammar', 'Change the wording'),
  Eggcorn: map('correctness', 'grammar', 'Correct the phrase'),
  Malapropism: map('correctness', 'grammar', 'Correct the word'),
  Nonstandard: map('correctness', 'grammar', 'Use the standard form'),
  WordChoice: map('correctness', 'grammar', 'Change the word'),
  Repetition: map('correctness', 'grammar', 'Remove the repeated word'),
  Punctuation: map('correctness', 'punctuation', 'Fix the punctuation'),
  Formatting: map('correctness', 'punctuation', 'Fix the spacing'),
  Redundancy: map('clarity', 'conciseness', 'Remove the redundancy'),
  Readability: map('clarity', 'sentence', 'Make this easier to read'),
  Style: map('clarity', 'conciseness', 'Improve the style'),
  Enhancement: map('engagement', 'word-choice', 'Choose a stronger word'),
};

/** Per-rule overrides where the kind alone would misfile the issue. */
const RULE: Record<string, Mapping> = {
  Gonna: map('delivery', 'formality', 'Use standard wording'),
  Wanna: map('delivery', 'formality', 'Use standard wording'),
  Gotta: map('delivery', 'formality', 'Use standard wording'),
  AvoidContractions: map('delivery', 'formality', 'Avoid the contraction'),
  AvoidCurses: map('delivery', 'tone', 'Reconsider this language', true),
  Hedging: map('delivery', 'tone', 'Sound more confident'),
  FillerWords: map('clarity', 'conciseness', 'Remove the filler word'),
  OxfordComma: map('correctness', 'punctuation', 'Add a comma'),
  NoOxfordComma: map('correctness', 'punctuation', 'Remove the comma'),
  CommaFixes: map('correctness', 'punctuation', 'Fix the comma'),
  DiscourseMarkers: map('correctness', 'punctuation', 'Add a comma'),
  PluralDecades: map('correctness', 'punctuation', 'Remove the apostrophe'),
  WrongApostrophe: map('correctness', 'punctuation', 'Fix the apostrophe'),
  Cant: map('correctness', 'punctuation', 'Add an apostrophe'),
  Spaces: map('correctness', 'punctuation', 'Remove the extra space'),
  NoFrenchSpaces: map('correctness', 'punctuation', 'Remove the extra space'),
  EllipsisLength: map('correctness', 'punctuation', 'Fix the ellipsis'),
  UnclosedQuotes: map('correctness', 'punctuation', 'Close the quotation'),
  AnA: map('correctness', 'grammar', 'Change the article'),
  SentenceCapitalization: map('correctness', 'spelling', 'Capitalize the first word'),
  CapitalizePersonalPronouns: map('correctness', 'spelling', 'Capitalize “I”'),
};

const HARPER_PRIORITY: Record<Category, number> = { correctness: 100, clarity: 58, engagement: 45, delivery: 35 };
const INFORMAL_HARPER_RULES = new Set(['Gonna', 'Wanna', 'Gotta']);

/** Give a punctuation- or space-only finding a visible, clickable range. */
function displayRange(text: string, from: number, to: number): [number, number] {
  if (/[\p{L}\p{N}]/u.test(text.slice(from, to))) return [from, to];
  let a = from;
  let b = to;
  while (a > 0 && /\s/.test(text[a - 1])) a--;
  while (a > 0 && /[\p{L}\p{N}'’-]/u.test(text[a - 1])) a--;
  while (b < text.length && /[^\s\p{L}\p{N}]/u.test(text[b])) b++;
  if (a === from) {
    while (b < text.length && /\s/.test(text[b])) b++;
    while (b < text.length && /[\p{L}\p{N}'’-]/u.test(text[b])) b++;
  }
  return [a, b];
}

/** What the flagged text will look like once `fix` is applied. */
function labelFor(text: string, from: number, to: number, fix: Omit<Fix, 'label'>): string {
  if (fix.from === from && fix.to === to) return fix.text || 'Remove';
  const a = Math.min(from, fix.from);
  const b = Math.max(to, fix.to);
  const result = (text.slice(a, fix.from) + fix.text + text.slice(fix.to, b)).replace(/\s+/g, ' ').trim();
  return result || 'Remove';
}

function fromHarper(ctx: RuleContext, lint: HarperLint, profile: Profile): RawIssue | null {
  const text = ctx.text;
  const flagged = text.slice(lint.from, lint.to);
  const mapping = RULE[lint.rule] ?? KIND[lint.kind] ?? KIND.Grammar;

  if (lint.rule === 'SpellCheck') {
    // Acronyms, identifiers, and anything with digits are not spelling mistakes.
    if (/^[\p{Lu}\d]{2,}s?$/u.test(flagged) || /\d/.test(flagged) || /\p{Ll}\p{Lu}/u.test(flagged)) return null;
  }
  if (INFORMAL_HARPER_RULES.has(lint.rule) && !profile.slang) return null;
  if (lint.rule === 'AvoidCurses' && !profile.profanity) return null;

  const [from, to] = displayRange(text, lint.from, lint.to);
  const fixes: Fix[] = [];
  if (!mapping.dropFixes) {
    const seen = new Set<string>();
    for (const s of lint.suggestions) {
      const edit =
        s.kind === 'insert-after'
          ? { from: lint.to, to: lint.to, text: s.text }
          : { from: lint.from, to: lint.to, text: s.kind === 'remove' ? '' : s.text };
      const key = `${edit.from}:${edit.to}:${edit.text}`;
      if (seen.has(key) || (edit.from !== edit.to && edit.text === flagged)) continue;
      seen.add(key);
      fixes.push({ ...edit, label: labelFor(text, from, to, edit) });
      if (fixes.length === 3) break;
    }
  }

  let title = mapping.title;
  const first = lint.suggestions[0];
  if (mapping.type === 'punctuation' && first && first.kind === 'insert-after') {
    title = first.text === ',' ? 'Add a comma' : first.text === '.' ? 'Add a period' : 'Add the missing punctuation';
  }

  let message = lint.message.replace(/`([^`]+)`/g, '“$1”');
  if (lint.rule === 'SpellCheck') {
    message = `“${flagged}” is not in the dictionary. Check the spelling, or add the word to your dictionary if it is correct.`;
  }

  return {
    from,
    to,
    ruleId: `harper/${lint.rule}`,
    category: mapping.category,
    type: mapping.type,
    title,
    message,
    fixes,
    word: mapping.type === 'spelling' && lint.rule === 'SpellCheck' ? flagged : undefined,
    priority: HARPER_PRIORITY[mapping.category],
  };
}

const overlaps = (a: RawIssue, b: RawIssue) => a.from < b.to && b.from < a.to;

/**
 * Keep the highest-priority finding wherever two overlap. Sentence-level
 * findings may sit on top of word-level ones, but not on each other.
 */
function resolveOverlaps(issues: RawIssue[]): RawIssue[] {
  const sorted = [...issues].sort((a, b) => b.priority - a.priority);
  const kept: RawIssue[] = [];
  for (const issue of sorted) {
    const level = Boolean(issue.sentenceLevel);
    if (kept.some((k) => Boolean(k.sentenceLevel) === level && overlaps(k, issue))) continue;
    kept.push(issue);
  }
  return kept.sort((a, b) => a.from - b.from || a.to - b.to);
}

const SCORE_WEIGHT: Record<Category, number> = { correctness: 1, clarity: 0.45, engagement: 0.25, delivery: 0.25 };

/** Minimum words before a score is shown. */
export const MIN_SCORE_WORDS = 15;

function computeScore(issues: Issue[], words: number): number | null {
  if (words < MIN_SCORE_WORDS) return null;
  let weighted = 0;
  for (const issue of issues) weighted += SCORE_WEIGHT[issue.category];
  const density = weighted / Math.max(words, 30);
  return Math.max(0, Math.min(100, Math.round(100 * Math.exp(-5.5 * density))));
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const MAX_RULE_CACHE = 4000;

export class Analyzer {
  private readonly harper: HarperEngine | null;
  private settings: EngineSettings = DEFAULT_ENGINE_SETTINGS;
  private profile: Profile = buildProfile(DEFAULT_ENGINE_SETTINGS);
  private disabledRules = new Set<string>();
  private ruleCache = new Map<string, RawIssue[]>();

  /** Pass Harper's WebAssembly binary to enable the grammar engine; omit it to run the built-in rules only. */
  constructor(binary?: BinaryModule | null) {
    this.harper = binary ? new HarperEngine(binary) : null;
    this.configure(DEFAULT_ENGINE_SETTINGS);
  }

  configure(settings: EngineSettings): void {
    this.settings = settings;
    this.profile = buildProfile(settings);
    this.disabledRules = new Set(settings.disabledRules);
    this.ruleCache.clear();
    this.harper?.configure({
      dialect: settings.dialect,
      dictionary: settings.dictionary,
      disabledRules: settings.disabledRules.filter((r) => r.startsWith('harper/')).map((r) => r.slice(7)),
      avoidContractions: this.profile.formal,
      oxfordComma: settings.options.oxfordComma,
    });
  }

  get grammarEngineReady(): boolean {
    return this.harper?.ready ?? false;
  }

  get engineError(): string | undefined {
    return this.harper?.error ?? undefined;
  }

  /** Load the grammar engine ahead of the first analysis. */
  async warmUp(): Promise<void> {
    await this.harper?.setup();
  }

  private enabled(issue: RawIssue): boolean {
    return this.settings.checks[issue.category] && !this.disabledRules.has(issue.ruleId);
  }

  async analyze(request: AnalyzeRequest): Promise<AnalysisResult> {
    const started = now();
    const { blocks } = request;
    const dismissed = new Set(request.dismissed ?? []);
    const { stats, readability } = computeStats(blocks);

    const contexts: Array<RuleContext | null> = [];
    const perBlock: RawIssue[][] = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.kind === 'code' || !block.text.trim()) {
        contexts.push(null);
        perBlock.push([]);
        continue;
      }
      const editing = i === request.caretBlock;
      const ctx = makeContext(block.text, block.kind, this.profile, this.settings.dialect, editing);
      contexts.push(ctx);

      const key = `${block.kind}|${editing ? 1 : 0}|${block.text}`;
      let builtIn = this.ruleCache.get(key);
      if (!builtIn) {
        builtIn = runBlockRules(ctx);
        if (this.ruleCache.size >= MAX_RULE_CACHE) this.ruleCache.clear();
        this.ruleCache.set(key, builtIn);
      }
      const raw = [...builtIn];
      if (this.harper) {
        for (const lint of await this.harper.lint(block.text)) {
          const issue = fromHarper(ctx, lint, this.profile);
          if (issue) raw.push(issue);
        }
      }
      perBlock.push(raw);
    }

    for (const [block, extra] of overusedWords(contexts, stats.words)) perBlock[block].push(...extra);

    const issues: Issue[] = [];
    const idCounts = new Map<string, number>();
    for (let i = 0; i < blocks.length; i++) {
      const ctx = contexts[i];
      if (!ctx) continue;
      for (const raw of resolveOverlaps(perBlock[i].filter((r) => this.enabled(r)))) {
        const flagged = ctx.text.slice(raw.from, raw.to);
        const s = sentenceOf(ctx, raw.from);
        const sentence = s ? { from: s.from, to: Math.max(s.to, raw.to) } : { from: raw.from, to: raw.to };
        const base = `${raw.ruleId}:${hash(`${flagged}\u0001${ctx.text.slice(sentence.from, sentence.to)}`)}`;
        const n = idCounts.get(base) ?? 0;
        idCounts.set(base, n + 1);
        const id = n === 0 ? base : `${base}~${n}`;
        if (dismissed.has(id)) continue;
        issues.push({
          id,
          block: i,
          from: raw.from,
          to: raw.to,
          category: raw.category,
          type: raw.type,
          ruleId: raw.ruleId,
          title: raw.title,
          message: raw.message,
          text: flagged,
          fixes: raw.fixes,
          sentenceLevel: Boolean(raw.sentenceLevel),
          sentence,
          rewriteHint: raw.rewriteHint,
          word: raw.word,
        });
      }
    }

    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
    const byType = Object.fromEntries(ISSUE_TYPES.map((t) => [t, 0])) as Record<IssueType, number>;
    for (const issue of issues) {
      byCategory[issue.category]++;
      byType[issue.type]++;
    }

    const prose = blocks
      .filter((b) => b.kind !== 'code')
      .map((b) => b.text)
      .join('\n');

    return {
      issues,
      stats,
      readability,
      tones: detectTones(prose, stats.words, stats.sentences),
      score: computeScore(issues, stats.words),
      counts: { total: issues.length, byCategory, byType },
      grammarEngineReady: this.grammarEngineReady,
      engineError: this.engineError,
      elapsedMs: Math.round(now() - started),
    };
  }
}
