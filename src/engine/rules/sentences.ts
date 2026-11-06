/**
 * Sentence-level rules: sentences that are too long, run-ons, fragments,
 * repetitive openings, and passive constructions.
 */
import { push, type RawIssue, type RuleContext } from './context';

/* ------------------------------------------------------------------ */
/* Long sentences and run-ons                                          */
/* ------------------------------------------------------------------ */

const CLAUSE_CHAIN = /\b(?:and|but|so|then)\s+(?:I|we|they|he|she|it|you)\b/g;

function lengthAndRunOns(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'heading') return;
  const t = ctx.norm;
  for (const s of ctx.sentences) {
    const sentence = t.slice(s.from, s.to);
    const chained = sentence.match(CLAUSE_CHAIN)?.length ?? 0;
    const noCommas = !sentence.includes(',');
    if (chained >= 3 || (chained >= 2 && noCommas && s.words >= 20)) {
      push(ctx, out, {
        from: s.from,
        to: s.to,
        ruleId: 'ws/run-on',
        category: 'clarity',
        type: 'sentence',
        title: 'Break up this run-on sentence',
        message:
          'This sentence strings several complete thoughts together with “and,” “but,” or “so.” Split it into shorter sentences so each idea stands on its own.',
        fixes: [],
        sentenceLevel: true,
        rewriteHint: 'Split this run-on sentence into two or more clear sentences, keeping the meaning.',
        priority: 26,
      });
      continue;
    }
    if (ctx.profile.longSentences && s.words > ctx.profile.longSentence) {
      const veryLong = s.words > ctx.profile.longSentence + 15;
      push(ctx, out, {
        from: s.from,
        to: s.to,
        ruleId: 'ws/long-sentence',
        category: 'clarity',
        type: 'sentence',
        title: veryLong ? 'Split this very long sentence' : 'Split this long sentence',
        message: `This sentence has ${s.words} words, which can be hard to follow. Try splitting it in two or cutting words that are not doing any work.`,
        fixes: [],
        sentenceLevel: true,
        rewriteHint:
          'Make this sentence easier to read by splitting it into shorter sentences or tightening it, keeping the meaning.',
        priority: 20,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fragments                                                           */
/* ------------------------------------------------------------------ */

const FRAGMENT_OPENER = /^(Because(?! of\b)|Although|Though|Even though|Unless|Whereas|Which|While)\b/;

function fragments(ctx: RuleContext, out: RawIssue[]): void {
  if (!ctx.profile.fragments) return;
  if (ctx.kind !== 'paragraph' && ctx.kind !== 'quote') return;
  const t = ctx.norm;
  for (const s of ctx.sentences) {
    if (s.words < 3 || s.words > 6) continue;
    const sentence = t.slice(s.firstWord, s.to);
    if (!/[.!]$/.test(sentence) || sentence.includes(',')) continue;
    const m = FRAGMENT_OPENER.exec(sentence);
    if (!m) continue;
    push(ctx, out, {
      from: s.from,
      to: s.to,
      ruleId: 'ws/fragment',
      category: 'correctness',
      type: 'sentence',
      title: 'Complete this sentence',
      message: `This looks like a sentence fragment: it opens with “${m[1]}” but never reaches a main clause. Attach it to a neighboring sentence or finish the thought.`,
      fixes: [],
      sentenceLevel: true,
      rewriteHint:
        'This is a sentence fragment. Rewrite it as a complete sentence, keeping the meaning and tone.',
      priority: 86,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Repeated sentence openings                                          */
/* ------------------------------------------------------------------ */

function repeatedOpenings(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind !== 'paragraph' && ctx.kind !== 'quote') return;
  const t = ctx.norm;
  const firstWords = ctx.sentences.map((s) => {
    const m = /^[\p{L}'-]+/u.exec(t.slice(s.firstWord, s.to));
    return m ? m[0] : '';
  });
  for (let i = 2; i < firstWords.length; i++) {
    const w = firstWords[i];
    if (!w) continue;
    const lower = w.toLowerCase();
    if (lower !== firstWords[i - 1].toLowerCase() || lower !== firstWords[i - 2].toLowerCase()) continue;
    // Flag each run once, at its third sentence.
    if (i >= 3 && firstWords[i - 3].toLowerCase() === lower) continue;
    const s = ctx.sentences[i];
    push(ctx, out, {
      from: s.firstWord,
      to: s.firstWord + w.length,
      ruleId: 'ws/repeated-opening',
      category: 'engagement',
      type: 'sentence',
      title: 'Vary your sentence openings',
      message: `Three sentences in a row begin with “${w}.” Starting sentences in different ways keeps readers engaged.`,
      fixes: [],
      rewriteHint: `Rewrite this sentence so it does not begin with “${w},” keeping the meaning.`,
      priority: 38,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Passive voice                                                       */
/* ------------------------------------------------------------------ */

const IRREGULAR_PARTICIPLES = new Set([
  'written', 'made', 'done', 'given', 'taken', 'seen', 'shown', 'found', 'held', 'kept', 'sent', 'built',
  'bought', 'brought', 'caught', 'taught', 'told', 'sold', 'paid', 'said', 'broken', 'chosen', 'driven',
  'eaten', 'forgotten', 'frozen', 'hidden', 'ridden', 'spoken', 'stolen', 'sworn', 'thrown', 'begun', 'sung',
  'led', 'fed', 'met', 'shot', 'beaten', 'bitten', 'blown', 'drawn', 'grown', 'flown', 'withdrawn',
  'overcome', 'understood', 'heard', 'dealt', 'spent', 'lent', 'laid', 'hung', 'struck', 'swept', 'sought',
  'fought', 'thought', 'forbidden', 'forgiven', 'shaken', 'undertaken', 'rewritten', 'overseen', 'undone',
  'redone', 'won', 'run', 'put', 'cut', 'set', 'read', 'torn', 'worn', 'woven', 'proven', 'sewn',
]);

const NOT_PARTICIPLES = new Set([
  'need', 'feed', 'seed', 'speed', 'indeed', 'bleed', 'breed', 'creed', 'deed', 'exceed', 'proceed',
  'succeed', 'weed', 'greed', 'reed', 'heed', 'steed', 'tweed', 'hundred', 'sacred', 'naked', 'wicked',
  'rugged', 'beloved', 'kindred', 'hatred', 'shred', 'sled', 'crooked', 'wretched', 'ragged', 'jagged',
  'dogged', 'embed', 'biped', 'moped',
]);

/** Participles that usually describe a state after "be", so the phrase is not really passive. */
const STATIVE = new Set([
  'tired', 'excited', 'interested', 'bored', 'worried', 'concerned', 'pleased', 'delighted', 'thrilled',
  'surprised', 'shocked', 'scared', 'frightened', 'confused', 'embarrassed', 'annoyed', 'satisfied',
  'disappointed', 'married', 'engaged', 'involved', 'located', 'based', 'supposed', 'used', 'allowed',
  'required', 'needed', 'expected', 'gone', 'done', 'finished', 'retired', 'experienced', 'advanced',
  'complicated', 'sophisticated', 'dedicated', 'committed', 'devoted', 'opposed', 'related', 'associated',
  'convinced', 'determined', 'inclined', 'prepared', 'qualified', 'limited', 'detailed', 'talented',
  'gifted', 'skilled', 'crowded', 'closed', 'relaxed', 'stressed', 'depressed', 'exhausted', 'ashamed',
  'amazed', 'amused', 'astonished', 'impressed', 'frustrated', 'motivated', 'inspired', 'overwhelmed',
  'terrified', 'known', 'called', 'named', 'titled', 'entitled', 'considered', 'meant', 'intended',
  'designed', 'made', 'composed', 'comprised', 'equipped', 'filled', 'covered', 'packed', 'loaded',
  'connected', 'attached', 'linked', 'tied', 'destined', 'scheduled', 'obliged', 'obligated', 'blessed',
  'cursed', 'doomed', 'acquainted', 'accustomed', 'addicted', 'alarmed', 'broken', 'mixed', 'varied',
  'set', 'put', 'read', 'run', 'cut', 'won', 'said', 'thought', 'aged', 'pleased', 'honored', 'flattered',
  'touched', 'moved', 'saddened', 'relieved', 'devastated', 'heartbroken', 'drawn', 'worn', 'torn',
  'interested', 'dressed', 'seated', 'situated', 'populated', 'located', 'hidden', 'bound', 'born',
  'understood', 'proven', 'felt', 'left', 'lost', 'stuck', 'hurt', 'shown', 'seen', 'found', 'held',
]);

const PASSIVE_RE =
  /\b(am|is|are|was|were|be|been|being)\s+(?:(?:not|also|never|always|often|just|still|already|usually|generally|commonly|frequently|widely|recently|finally|eventually|currently|\p{L}+ly)\s+){0,2}(\p{L}+)\b/dgiu;

/** "by" followed by a time, manner, or reflexive is not an agent. */
const BY_AGENT_RE =
  /^\s+by\s+(?!the way\b|then\b|now\b|far\b|accident\b|chance\b|mistake\b|hand\b|default\b|design\b|definition\b|nature\b|itself\b|myself\b|yourself\b|himself\b|herself\b|themselves\b|ourselves\b|monday\b|tuesday\b|wednesday\b|thursday\b|friday\b|saturday\b|sunday\b|tomorrow\b|tonight\b|today\b|next\b|the end\b|noon\b|midnight\b|early\b|late\b|\d)/i;

const LEADING_AUX = /\b(?:(?:will|would|can|could|should|must|might|may|shall)(?:\s+not)?\s+(?:have\s+)?|(?:has|have|had)(?:\s+not)?\s+|(?:is|are|was|were|am)(?:\s+not)?\s+|to\s+)$/i;

function isParticiple(word: string): boolean {
  const w = word.toLowerCase();
  if (IRREGULAR_PARTICIPLES.has(w)) return true;
  return w.length >= 4 && w.endsWith('ed') && !NOT_PARTICIPLES.has(w);
}

function passiveVoice(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.profile.passive === 'none' || ctx.kind === 'heading') return;
  const t = ctx.norm;
  PASSIVE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASSIVE_RE.exec(t)) !== null) {
    const participle = m[2];
    if (!isParticiple(participle)) continue;
    const end = m.index + m[0].length;
    const lower = participle.toLowerCase();
    const after = t.slice(end, end + 24);
    const hasAgent = BY_AGENT_RE.test(after);
    if (lower === 'used' && /^\s+to\b/i.test(after)) continue; // "is used to"
    if (!hasAgent && (ctx.profile.passive !== 'all' || STATIVE.has(lower))) continue;

    // Include a helping verb in front: "has been written", "will be sent".
    let from = m.index;
    const lead = LEADING_AUX.exec(t.slice(Math.max(0, from - 22), from));
    if (lead && /^(?:be|been|being)$/i.test(m[1])) from -= lead[0].length;

    push(ctx, out, {
      from,
      to: end,
      ruleId: hasAgent ? 'ws/passive-voice-agent' : 'ws/passive-voice',
      category: 'clarity',
      type: 'sentence',
      title: 'Consider the active voice',
      message: hasAgent
        ? 'This is in the passive voice. Putting the doer first, the person or thing performing the action, usually makes a sentence clearer and more direct.'
        : 'This passive construction does not say who performs the action. If that matters to your reader, name the doer and use the active voice.',
      fixes: [],
      rewriteHint: 'Rewrite this sentence in the active voice, keeping the meaning.',
      priority: hasAgent ? 36 : 32,
    });
  }
}

export function sentenceRules(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'code') return;
  lengthAndRunOns(ctx, out);
  fragments(ctx, out);
  repeatedOpenings(ctx, out);
  passiveVoice(ctx, out);
}
