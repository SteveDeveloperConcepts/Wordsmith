/**
 * Delivery rules: confidence (hedging), formality, inclusive language,
 * politeness, strong language, and all-caps "shouting".
 */
import { FORMAL, GROUP_NOUNS, INCLUSIVE, POLITE, SLANG, STRONG_LANGUAGE } from './data/delivery';
import {
  PhraseTable,
  isSentenceStart,
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

const slang = new PhraseTable(SLANG);
const formal = new PhraseTable(FORMAL);
const inclusive = new PhraseTable(INCLUSIVE);
const polite = new PhraseTable(POLITE);
const strong = new PhraseTable(STRONG_LANGUAGE);

/* ------------------------------------------------------------------ */
/* Confidence                                                          */
/* ------------------------------------------------------------------ */

const CLAUSE_AHEAD =
  '(?= (?:we|you|they|he|she|it|this|that|there|the|an?|my|our|your|his|her|their|these|those|most|many|some|all|everyone|people|maybe|perhaps|probably)\\b)';

interface HedgeRule {
  re: RegExp;
  /** Capture group to remove; the whole match when omitted. */
  group?: number;
  /** Replacement options; removal when omitted. */
  options?: string[];
  sentenceStartOnly?: boolean;
  guard?: (m: RegExpExecArray, ctx: RuleContext) => boolean;
}

const HEDGES: HedgeRule[] = [
  // "I think we should go." → "We should go."
  { re: new RegExp(`\\bI (?:think|believe|guess|suppose)(?: that)?${CLAUSE_AHEAD}`, 'dg') },
  { re: new RegExp(`\\bI feel (?:that|like)(?= (?:we|you|they|he|she|it|this|that|there|I)\\b)`, 'dg') },
  {
    re: /\b(?:in my (?:humble |honest |personal )?opinion|if you ask me|as far as I can tell|to be honest|to be frank|for what it's worth),?/dgi,
  },
  { re: /\b(?:Honestly|Frankly|Personally),?(?= \p{L})/dgu, sentenceStartOnly: true },
  {
    // "It's kind of hard" but not "this kind of problem"
    re: /\b(?:kind of|sort of)\b(?= \p{L})/dgiu,
    guard: (m, ctx) =>
      !/^(?:this|that|what|which|any|some|every|each|an?|the|one|same|another|other|certain|new|different|right|wrong|best|worst|only|first|last|these|those|all|no|my|your|his|her|our|their|its|of)$/.test(
        previousWord(ctx.norm, m.index),
      ) &&
      // "That is kind of you" uses the adjective "kind".
      !/^(?:you|him|her|them|me|us)$/.test(nextWord(ctx.norm, m.index + m[0].length)),
  },
  { re: /\b(?:Maybe|Perhaps) (?=(?:we|you|they|I|it|this|that) (?:should|could|can|might|need|ought)\b)/dg, sentenceStartOnly: true },
  // "I just wanted to ask" → "I wanted to ask"
  { re: /\bI(?: was)? (just) (?=wanted|wondering|thought|think|checking|following|writing|reaching|hoping|need|needed)/dg, group: 1 },
  { re: /\b(Just) (?=checking in|following up)/dg, group: 1, sentenceStartOnly: true },
  {
    re: /\b(?:sorry to bother you|sorry for bothering you|I hate to bother you|I hate to ask)(?:,? but)?,?|\b(?:I might be wrong|I may be wrong|I could be wrong|I'm no expert|I'm not an expert|I'm not sure|this (?:might|may) be a (?:dumb|stupid|silly) question),? but,?|,? if that makes sense|,? if that's (?:okay|ok)\b|,? if it's not too much trouble/dgi,
  },
  {
    re: /\bI was (?:wondering if|hoping) you (?:could|would|might)(?: possibly| please)?(?= \p{L})/dgu,
    options: ['please', 'could you'],
  },
];

function hedging(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  for (const rule of HEDGES) {
    scan(t, rule.re, (m) => {
      let from = m.index;
      let to = from + m[0].length;
      if (rule.group) {
        const r = m.indices?.[rule.group];
        if (!r) return;
        [from, to] = r;
      }
      // A match that starts with ", " keeps the comma out of the highlight.
      while (from < to && /[,\s]/.test(t[from])) from++;
      while (to > from && /\s/.test(t[to - 1])) to--;
      if (rule.sentenceStartOnly && !isSentenceStart(ctx, from)) return;
      if (rule.guard && !rule.guard(m, ctx)) return;
      // Leave the hedge alone when nothing would remain: "I think so."
      const sentence = sentenceOf(ctx, from);
      if (sentence && sentence.words - t.slice(from, to).split(/\s+/).length < 2) return;

      const original = ctx.text.slice(from, to).replace(/,$/, '');
      const display = to - (t[to - 1] === ',' ? 1 : 0);
      push(ctx, out, {
        from,
        to: display,
        ruleId: 'ws/hedging',
        category: 'delivery',
        type: 'tone',
        title: 'Sound more confident',
        message: `“${original}” can make you sound unsure. If you stand behind the statement, say it directly.`,
        fixes: rule.options ? replacements(ctx, from, display, rule.options) : [removalFix(ctx, from, display)],
        priority: 33,
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Formality                                                           */
/* ------------------------------------------------------------------ */

/** Short forms that are real abbreviations when capitalized ("500 BC", "RN"). */
const LOWERCASE_ONLY = new Set(['bc', 'ty', 'np', 'rn', 'jk', 'msg', 'pic', 'pics', 'ur', 'imo', 'tho']);

const CONJUNCTION_ALTERNATIVES: Record<string, string[]> = {
  And: ['Additionally,', 'Also,'],
  But: ['However,'],
  So: ['Therefore,', 'Thus,'],
  Or: ['Alternatively,'],
};

function formality(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  const { profile } = ctx;

  if (profile.slang) {
    for (const m of slang.find(t)) {
      const original = ctx.text.slice(m.from, m.to);
      if (LOWERCASE_ONLY.has(m.key) && original !== original.toLowerCase()) continue;
      push(ctx, out, {
        from: m.from,
        to: m.to,
        ruleId: 'ws/informal',
        category: 'delivery',
        type: 'formality',
        title: 'Use standard wording',
        message: `“${original}” is informal shorthand. Spell it out unless you are writing casually.`,
        fixes: replacements(ctx, m.from, m.to, m.options),
        priority: 112, // exact knowledge: beats the spell checker's guesses
      });
    }
    // A lone lowercase "u" for "you" (but not "U-turn" or "U.S.").
    scan(t, /(?<![\p{L}\p{N}'.-])u(?![\p{L}\p{N}'.-])/gu, (m) => {
      push(ctx, out, {
        from: m.index,
        to: m.index + 1,
        ruleId: 'ws/informal',
        category: 'delivery',
        type: 'formality',
        title: 'Use standard wording',
        message: '“u” is informal shorthand for “you.”',
        fixes: replacements(ctx, m.index, m.index + 1, ['you']),
        priority: 112, // beats the spell checker's guesses for a one-letter word
      });
    });
    // A lone lowercase "r" for "are" (but not "the letter r" or "r = 5").
    scan(t, /(?<![\p{L}\p{N}'.-])r(?![\p{L}\p{N}'.-])(?! ?[=<>+*/])/gu, (m) => {
      if (previousWord(t, m.index) === 'letter') return;
      push(ctx, out, {
        from: m.index,
        to: m.index + 1,
        ruleId: 'ws/informal',
        category: 'delivery',
        type: 'formality',
        title: 'Use standard wording',
        message: '“r” is informal shorthand for “are.”',
        fixes: replacements(ctx, m.index, m.index + 1, ['are']),
        priority: 112,
      });
    });
  }

  if (!profile.formal) return;

  for (const m of formal.find(t)) {
    const following = nextWord(t, m.to);
    if (m.key === 'thanks' && following === 'to') continue; // "thanks to the team"
    if ((m.key === 'a bit' || m.key === 'a little bit') && following === 'of') continue;
    const original = ctx.text.slice(m.from, m.to);
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/formal-wording',
      category: 'delivery',
      type: 'formality',
      title: 'Use more formal wording',
      message: `“${original}” is conversational. A more formal alternative suits this document.`,
      fixes: replacements(ctx, m.from, m.to, m.options),
      priority: 32,
    });
  }

  for (const s of ctx.sentences) {
    // Exclamation points
    if (t[s.to - 1] === '!' && ctx.kind !== 'heading') {
      let from = s.to - 1;
      while (from > s.from && /[\p{L}\p{N}'-]/u.test(t[from - 1])) from--;
      push(ctx, out, {
        from,
        to: s.to,
        ruleId: 'ws/formal-exclamation',
        category: 'delivery',
        type: 'formality',
        title: 'Use a period',
        message: 'Exclamation points can seem out of place in formal writing.',
        fixes: [{ from: s.to - 1, to: s.to, text: '.', label: `${ctx.text.slice(from, s.to - 1)}.` }],
        priority: 31,
      });
    }
    // Sentence-initial conjunctions
    const m = /^(And|But|So|Or) (?=\p{L})/u.exec(t.slice(s.firstWord, s.to));
    if (m && s.words >= 4) {
      const from = s.firstWord;
      const to = from + m[1].length;
      const options = CONJUNCTION_ALTERNATIVES[m[1]];
      push(ctx, out, {
        from,
        to,
        ruleId: 'ws/formal-conjunction',
        category: 'delivery',
        type: 'formality',
        title: 'Rework the sentence opening',
        message: `Starting a sentence with “${m[1]}” is common in conversation but can read as informal in formal writing.`,
        fixes: [...options.map((text) => ({ from, to, text, label: text })), removalFix(ctx, from, to)],
        priority: 31,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Inclusive language                                                  */
/* ------------------------------------------------------------------ */

const GROUP_NOUN_FOLLOWERS =
  /^(?:are|were|is|was|have|had|who|need|needs|often|and|or|in|as|of|to|can|may|should|will|must|deserve|face|live|)$/;

function inclusiveLanguage(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  for (const m of inclusive.find(t)) {
    const original = ctx.text.slice(m.from, m.to);
    if (GROUP_NOUNS.has(m.key)) {
      // "the elderly man" is an ordinary adjective; "the elderly need…" is the group noun.
      const punctuated = /[.,;:!?)]/.test(t[m.to] ?? '.');
      if (!punctuated && !GROUP_NOUN_FOLLOWERS.test(nextWord(t, m.to))) continue;
    }
    // A capitalized title before a name: "Chairman Powell".
    if (/^\p{Lu}/u.test(original) && !isSentenceStart(ctx, m.from) && /^\s\p{Lu}/u.test(t.slice(m.to, m.to + 2))) continue;
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/inclusive',
      category: 'delivery',
      type: 'inclusive',
      title: 'Use inclusive language',
      message: m.note ?? `Consider a more inclusive alternative to “${original}.”`,
      fixes: replacements(ctx, m.from, m.to, m.options),
      priority: 34,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Politeness, strong language, shouting                               */
/* ------------------------------------------------------------------ */

const DEMAND_RE = /^(You need to|You have to|I need you to|I want you to|I expect you to) (?=\p{Ll})/u;

function politeness(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  for (const m of polite.find(t)) {
    const original = ctx.text.slice(m.from, m.to);
    const hasFix = m.options.length > 0;
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/politeness',
      category: 'delivery',
      type: 'tone',
      title: 'Soften the tone',
      message: `“${original}” can come across as ${hasFix ? 'curt or condescending' : 'accusatory or dismissive'}. Consider a friendlier way to say it.`,
      fixes: replacements(ctx, m.from, m.to, m.options),
      rewriteHint: hasFix ? undefined : 'Rewrite this sentence so it sounds polite and constructive, keeping the meaning.',
      priority: 33,
    });
  }
  for (const s of ctx.sentences) {
    const m = DEMAND_RE.exec(t.slice(s.firstWord, s.to));
    if (!m) continue;
    const from = s.firstWord;
    const to = from + m[1].length;
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/politeness',
      category: 'delivery',
      type: 'tone',
      title: 'Soften the tone',
      message: `“${m[1]}” can sound like a demand. A polite request is more likely to get a good response.`,
      fixes: [{ from, to, text: 'Please', label: 'Please' }],
      priority: 33,
    });
  }
}

function strongLanguage(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  for (const m of strong.find(t)) {
    const original = ctx.text.slice(m.from, m.to);
    const sentence = sentenceOf(ctx, m.from);
    if (sentence && sentence.words <= 2) continue; // an interjection such as "Damn it."
    // "This sucks." has a clean rewrite; "He sucks at math" does not.
    const options = m.key === 'sucks' && !/^[.!?]?$/.test(t[m.to] ?? '') ? [] : m.options;
    push(ctx, out, {
      from: m.from,
      to: m.to,
      ruleId: 'ws/strong-language',
      category: 'delivery',
      type: 'tone',
      title: 'Reconsider this language',
      message: `“${original}” may come across as offensive or unprofessional.`,
      fixes: replacements(ctx, m.from, m.to, options),
      priority: 34,
    });
  }
}

const SHOUT_RE = /(?<![\p{L}])(?:\p{Lu}{2,}['’]?\p{Lu}*[,;:]?\s+){2,}\p{Lu}{2,}(?![\p{Ll}])/gu;

function shouting(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'heading') return;
  scan(ctx.text, SHOUT_RE, (m) => {
    if (!/\p{Lu}{4,}/u.test(m[0])) return; // a run of short acronyms
    const from = m.index;
    const to = from + m[0].length;
    let text = m[0].toLowerCase().replace(/\bi\b/g, 'I');
    if (isSentenceStart(ctx, from)) text = text[0].toUpperCase() + text.slice(1);
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/all-caps',
      category: 'delivery',
      type: 'tone',
      title: 'Avoid all caps',
      message: 'Text in all capitals can read as shouting. Standard capitalization lets your words carry the emphasis.',
      fixes: [{ from, to, text, label: text }],
      priority: 33,
    });
  });
}

export function deliveryRules(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'code') return;
  const { profile } = ctx;
  if (profile.hedging) hedging(ctx, out);
  formality(ctx, out);
  if (profile.inclusive) inclusiveLanguage(ctx, out);
  if (profile.politeness) politeness(ctx, out);
  if (profile.profanity) strongLanguage(ctx, out);
  shouting(ctx, out);
}
