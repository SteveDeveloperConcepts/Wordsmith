/**
 * Clarity rules: wordy phrases, redundancies, inflated vocabulary, and filler words.
 */
import { COMPLEX, FILLERS, REDUNDANT, WORDY } from './data/clarity';
import {
  PhraseTable,
  nextWord,
  previousWord,
  push,
  removalFix,
  replacements,
  scan,
  sentenceOf,
  type RawIssue,
  type RuleContext,
} from './context';

const wordy = new PhraseTable(WORDY);
const redundant = new PhraseTable(REDUNDANT);
const complex = new PhraseTable(COMPLEX);

/** Quantifiers that need "of" before a determiner: "most of the students" but "most students". */
const QUANTIFIERS = new Set(['most', 'many', 'several', 'some', 'much', 'enough', 'a few']);
const DETERMINER = /^(?:the|these|those|this|that|my|your|our|their|his|her|its)$/;

const FILLER_RE = new RegExp(`(?<![\\p{L}\\p{N}'-])(${FILLERS.join('|')})(?![\\p{L}\\p{N}'-])`, 'giu');

export function clarityRules(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'code') return;
  const t = ctx.norm;

  for (const m of wordy.find(t)) {
    let options = [...m.options];
    if (m.key.endsWith(' of') && DETERMINER.test(nextWord(t, m.to))) {
      options = options
        .filter((o) => o !== 'various')
        .map((o) => (QUANTIFIERS.has(o) ? `${o} of` : o));
    }
    const original = ctx.text.slice(m.from, m.to);
    const removal = options.length === 1 && options[0] === '';
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/wordy',
      category: 'clarity',
      type: 'conciseness',
      title: removal ? 'Remove the phrase' : 'Use a shorter phrase',
      message: removal
        ? `“${original}” adds words without adding meaning. The sentence is clearer without it.`
        : `“${original}” is wordy. A shorter alternative says the same thing.`,
      fixes: replacements(ctx, m.from, m.to, options),
      priority: 60,
    });
  }

  for (const m of redundant.find(t)) {
    const original = ctx.text.slice(m.from, m.to);
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/redundant',
      category: 'clarity',
      type: 'conciseness',
      title: 'Remove the redundancy',
      message: `“${original}” says the same thing twice. “${m.options[0]}” is enough.`,
      fixes: replacements(ctx, m.from, m.to, m.options),
      priority: 58,
    });
  }

  if (ctx.profile.complexWords) {
    for (const m of complex.find(t)) {
      const original = ctx.text.slice(m.from, m.to);
      push(ctx, out, {
        from: m.from,
        to: m.to,
        ruleId: 'ws/complex-word',
        category: 'clarity',
        type: 'word-choice',
        title: 'Use a simpler word',
        message: `“${original}” can sound stiff. A plainer word is easier to read.`,
        fixes: replacements(ctx, m.from, m.to, m.options),
        priority: 50,
      });
    }
  }

  if (ctx.profile.fillers) {
    scan(t, FILLER_RE, (m) => {
      const from = m.index;
      const to = from + m[0].length;
      const before = previousWord(t, from);
      if (before === 'not' || before.endsWith("n't") || before === 'never') return; // "not really"
      const sentence = sentenceOf(ctx, from);
      if (sentence && sentence.words <= 2) return; // "Really?"
      const after = t[to];
      if (after === undefined || /[.!?]/.test(after)) return; // "I mean it, really."
      push(ctx, out, {
        from,
        to,
        ruleId: 'ws/filler',
        category: 'clarity',
        type: 'conciseness',
        title: 'Remove the filler word',
        message: `“${ctx.text.slice(from, to)}” rarely adds meaning here. The sentence is stronger without it.`,
        fixes: [removalFix(ctx, from, to)],
        priority: 30,
      });
    });
  }
}
