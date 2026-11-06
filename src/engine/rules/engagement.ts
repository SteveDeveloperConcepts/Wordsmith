/**
 * Engagement rules: weak intensifier pairs, clichés, and overused generic words.
 */
import { tokenize } from '../text';
import { CLICHES, INTENSIFIED, SYNONYMS } from './data/engagement';
import {
  PhraseTable,
  nextWord,
  previousWord,
  push,
  replacements,
  type PhraseRow,
  type RawIssue,
  type RuleContext,
} from './context';

const intensified = new PhraseTable(
  Object.entries(INTENSIFIED).flatMap(([adjective, options]): PhraseRow[] => [
    [`very ${adjective}`, options],
    [`really ${adjective}`, options],
  ]),
);
const cliches = new PhraseTable(CLICHES);

/** "moving forward with the plan" is literal; only the adverbial use is jargon. */
const ADVERBIAL_ONLY = new Set(['going forward', 'moving forward']);

export function engagementRules(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'code') return;
  const t = ctx.norm;

  for (const m of intensified.find(t)) {
    const before = previousWord(t, m.from);
    // "not very good" does not mean "not excellent".
    if (before === 'not' || before === 'never' || before.endsWith("n't")) continue;
    const original = ctx.text.slice(m.from, m.to);
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/intensifier',
      category: 'engagement',
      type: 'word-choice',
      title: 'Choose a stronger word',
      message: `“${original}” leans on an intensifier. One precise word has more impact.`,
      fixes: replacements(ctx, m.from, m.to, m.options),
      priority: 42,
    });
  }

  if (ctx.profile.cliches) {
    for (const m of cliches.find(t)) {
      if (ADVERBIAL_ONLY.has(m.key)) {
        const after = t[m.to];
        if (after !== undefined && after !== ',' && after !== '.') continue;
      }
      const original = ctx.text.slice(m.from, m.to);
      const hasFix = m.options.length > 0;
      push(ctx, out, {
        from: m.from,
        to: m.to,
        ruleId: 'ws/cliche',
        category: 'engagement',
        type: 'word-choice',
        title: hasFix ? 'Replace the cliché' : 'Rethink this cliché',
        message: hasFix
          ? `“${original}” is a well-worn phrase. A plainer alternative is more direct.`
          : `“${original}” is a well-worn phrase. Saying it in your own words will be more memorable.`,
        fixes: replacements(ctx, m.from, m.to, m.options),
        rewriteHint: hasFix ? undefined : 'Rewrite this sentence without the cliché, keeping the meaning.',
        priority: 40,
      });
    }
  }
}

/** Fixed expressions in which a "generic" word is not really a word choice. */
const FIXED_FOLLOWERS: Record<string, RegExp> = {
  good: /^(?:morning|afternoon|evening|night|luck|bye|grief|faith|news|at|for|enough)$/,
  great: /^(?:deal|britain)$/,
  big: /^(?:deal|data)$/,
  hard: /^(?:drive|disk|copy|work|to|time)$/,
  thing: /^(?:is|about)$/,
  help: /^(?:desk|center|page)$/,
  main: /^(?:street|menu)$/,
  major: /^(?:in|league)$/,
};

/**
 * Document-wide pass: flag generic words that keep recurring. Returns issues per block index.
 */
export function overusedWords(contexts: Array<RuleContext | null>, totalWords: number): Map<number, RawIssue[]> {
  const result = new Map<number, RawIssue[]>();
  if (totalWords < 60) return result;

  interface Occurrence {
    block: number;
    from: number;
    to: number;
  }
  const seen = new Map<string, Occurrence[]>();

  contexts.forEach((ctx, block) => {
    if (!ctx || ctx.kind === 'code' || ctx.kind === 'heading') return;
    for (const token of tokenize(ctx.norm)) {
      const lower = token.text.toLowerCase();
      if (!(lower in SYNONYMS)) continue;
      // A capital mid-sentence signals a name: "New York", "Good Friday".
      if (token.text[0] !== lower[0] && !ctx.sentenceStarts.has(token.from)) continue;
      const guard = FIXED_FOLLOWERS[lower];
      if (guard && guard.test(nextWord(ctx.norm, token.to))) continue;
      let list = seen.get(lower);
      if (!list) seen.set(lower, (list = []));
      list.push({ block, from: token.from, to: token.to });
    }
  });

  for (const [word, occurrences] of seen) {
    const entry = SYNONYMS[word];
    const count = occurrences.length;
    const density = count / totalWords;
    const overused = entry.generic ? count >= 3 && density >= 1 / 200 : count >= 4 && density >= 1 / 150;
    if (!overused) continue;
    const keep = entry.generic ? 1 : 2;
    for (const o of occurrences.slice(keep)) {
      const ctx = contexts[o.block];
      if (!ctx) continue;
      const issue: RawIssue = {
        from: o.from,
        to: o.to,
        ruleId: 'ws/overused-word',
        category: 'engagement',
        type: 'word-choice',
        title: 'Vary your word choice',
        message: `You have used “${word}” ${count} times. A synonym here keeps your writing fresh.`,
        fixes: replacements(ctx, o.from, o.to, entry.options),
        priority: 37,
      };
      const list = result.get(o.block) ?? [];
      push(ctx, list, issue);
      result.set(o.block, list);
    }
  }
  return result;
}
