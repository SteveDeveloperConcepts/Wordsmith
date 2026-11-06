/**
 * Punctuation rules: comma splices, missing question marks and commas, date and
 * quotation punctuation, stray spaces, and hyphenated compound modifiers.
 */
import { countWords } from '../text';
import { nextWord, previousWord, push, scan, type RawIssue, type RuleContext } from './context';

const PRIORITY = 96;

const WORD_CHAR = /[\p{L}\p{N}'’-]/u;

function wordStart(text: string, index: number): number {
  let i = index;
  while (i > 0 && WORD_CHAR.test(text[i - 1])) i--;
  return i;
}

function wordEnd(text: string, index: number): number {
  let i = index;
  while (i < text.length && WORD_CHAR.test(text[i])) i++;
  return i;
}

/* ------------------------------------------------------------------ */
/* Comma splices                                                       */
/* ------------------------------------------------------------------ */

const FINITE_VERBS =
  "am|is|are|was|were|have|has|had|do|does|did|will|would|can|could|should|must|might|may|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|went|go|want|wanted|need|needed|think|thought|know|knew|like|liked|love|loved|hate|hated|said|say|got|get|made|make|saw|see|came|come|took|take|feel|felt|decided|believe|hope|wish|just|really|also|always|never|still|bought|left|ran|tried|called|asked|told|found|gave|started|stayed|looked|walked|worked|lived|ate|slept|forgot|missed|lost|won|read|wrote|heard|met|spent|kept|put|paid|sent|brought|began|finished|stopped|moved|turned|learned|played|watched|talked|waited|used|helped|opened|closed";

const SPLICE_RE = new RegExp(
  `,\\s+(?:(?:I|we|they|he|she|it|you)\\s+(?:${FINITE_VERBS})|I'm|I've|I'll|I'd|we're|we've|we'll|we'd|they're|they've|they'll|they'd|he's|he'll|he'd|she's|she'll|she'd|it's|it'll|you're|you've|you'll|you'd)\\b`,
  'g',
);

const CLAUSE_STARTERS = /^(?:I|we|they|he|she|it|you|this|that|there|I'm|I've|I'll|I'd|we're|we've|we'll|they're|they've|it's|he's|she's|you're|you've|there's|that's)\b/i;
const DETERMINER_STARTERS = /^(?:the|a|an|my|our|your|his|her|their|its|these|those|some|many|most|all|both)\b/i;
const SUBORDINATORS = /\b(?:if|when|while|although|though|because|since|as|after|before|until|unless|once|whenever|wherever|whereas|whether)\b/i;
const EMBEDDED_SUBJECT = /\b(?:I|we|they|he|she|you)\b/;
const AUX_OR_PAST = /\b(?:is|are|was|were|has|have|had|will|would|can|could|should|must|did|does|do|\p{L}{2,}ed)\b/iu;

function commaSplices(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  for (const s of ctx.sentences) {
    const sentence = t.slice(s.from, s.to);
    if (sentence.includes('"')) continue; // dialogue: "I'm tired," he said
    SPLICE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPLICE_RE.exec(sentence)) !== null) {
      const comma = s.from + m.index;
      const first = t.slice(s.firstWord, comma);
      if (/[,;:—–]/.test(first)) continue;
      if (countWords(first) < 3) continue; // "You know, I think…", "I came, I saw…"
      if (SUBORDINATORS.test(first)) continue; // "When I got home, I slept."
      if (CLAUSE_STARTERS.test(first)) {
        // a pronoun subject: fine
      } else if (DETERMINER_STARTERS.test(first)) {
        // "The moment I saw her, I knew" is an adverbial, not a clause.
        if (EMBEDDED_SUBJECT.test(first) || !AUX_OR_PAST.test(first)) continue;
      } else {
        continue;
      }

      // The second clause must be a real clause, not a tag like ", I think."
      const rest = t.slice(comma + 1, s.to);
      const untilBreak = rest.split(/[,;:.!?]/)[0];
      if (countWords(untilBreak) < 3) continue;
      // A series of clauses joined with a final conjunction is acceptable.
      if (/,\s+(?:and|or|but)\s/.test(rest)) continue;

      let pronoun = comma + 1;
      while (pronoun < t.length && /\s/.test(t[pronoun])) pronoun++;
      const from = wordStart(t, comma);
      const to = comma + 1;
      const capital = ctx.text[pronoun].toUpperCase();
      push(ctx, out, {
        from,
        to,
        ruleId: 'ws/comma-splice',
        category: 'correctness',
        type: 'punctuation',
        title: 'Fix the comma splice',
        message:
          'Two complete sentences are joined with only a comma. Use a semicolon, add a conjunction, or start a new sentence.',
        fixes: [
          { from: comma, to: comma + 1, text: ';', label: 'Use a semicolon' },
          { from: comma, to: pronoun + 1, text: `. ${capital}`, label: 'Start a new sentence' },
          { from: comma + 1, to: comma + 1, text: ' and', label: 'Add “and”' },
        ],
        priority: PRIORITY,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Missing question marks                                              */
/* ------------------------------------------------------------------ */

const SUBJECTS = 'you|we|they|he|she|it|I|there|anyone|anybody|someone|everyone';
const DETERMINERS = 'this|that|these|those|the|your|my|our|his|her|their';
const QUESTION_RE = new RegExp(
  '^(?:' +
    `(?:does|did|can|could|would|will|should|is|are|was|were|has|am|shall|doesn't|didn't|can't|couldn't|wouldn't|won't|shouldn't|isn't|aren't|wasn't|weren't|hasn't) (?:${SUBJECTS}|${DETERMINERS})\\b` +
    `|(?:do|have|don't|haven't) (?:${SUBJECTS})\\b` +
    `|(?:what|where|when|why|how|who) (?:is|are|was|were|do|does|did|can|could|would|will|should|has|have) (?:${SUBJECTS}|${DETERMINERS})\\b` +
    '|how (?:much|many|long|often|far|old) (?:is|are|was|were|do|does|did|can|could|would|will|should|has|have)\\b' +
    "|(?:what|who)(?:'s| is) (?:the|your|my|our|his|her|their|this|that|going|happening|wrong|next|up)\\b" +
    ')',
  'i',
);

function missingQuestionMarks(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'heading') return;
  const t = ctx.norm;
  for (const s of ctx.sentences) {
    if (s.words < 3) continue;
    const sentence = t.slice(s.firstWord, s.to);
    if (!sentence.endsWith('.') || sentence.endsWith('..')) continue;
    if (!QUESTION_RE.test(sentence)) continue;
    if (/^(?:should|were)\b/i.test(sentence) && sentence.includes(',')) continue;
    const dot = s.to - 1;
    push(ctx, out, {
      from: wordStart(t, dot),
      to: s.to,
      ruleId: 'ws/missing-question-mark',
      category: 'correctness',
      type: 'punctuation',
      title: 'Use a question mark',
      message: 'This sentence is phrased as a question, so it should end with a question mark.',
      fixes: [{ from: dot, to: dot + 1, text: '?', label: `${t.slice(wordStart(t, dot), dot)}?` }],
      priority: PRIORITY,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Introductory words and phrases                                      */
/* ------------------------------------------------------------------ */

/** Phrase, and optionally a pattern for a following word that makes the comma wrong. */
const INTRODUCTIONS: Array<[string, RegExp?]> = [
  ['however', /^(?:you|one|much|many|long|hard|difficult|big|small|often|far|little)$/],
  ['therefore'], ['moreover'], ['furthermore'], ['meanwhile'], ['nevertheless'], ['nonetheless'],
  ['consequently'], ['additionally'], ['unfortunately'], ['fortunately'], ['similarly'], ['otherwise'],
  ['accordingly'], ['likewise'], ['alternatively'], ['surprisingly'], ['interestingly'], ['importantly'],
  ['ultimately'], ['luckily'], ['sadly'], ['admittedly'], ['firstly'], ['secondly'], ['thirdly'], ['lastly'],
  ['finally'], ['thus'], ['indeed'], ['instead'], ['for example'], ['for instance'],
  ['in addition'], ['in fact'], ['in conclusion'], ['in contrast'], ['in summary'], ['in short'],
  ['in general'], ['in particular'], ['in other words'], ['as a result'], ['on the other hand'],
  ['on the contrary'], ['of course'], ['after all', /^(?:the|these|those|this|that|my|your|his|her|our|their|i|we|he|she|they|you|it)$/],
  ['by the way'], ['to be honest'], ['in my opinion'], ['as usual'], ['above all'], ['in the meantime'],
  ['in the end'], ['most importantly'], ['more importantly'], ['that said'], ['even so'], ['first of all'],
  ['to summarize', /^(?:the|this|that|these|those|my|our|your|his|her|their|an?|it|what|all)$/],
  ['to sum up', /^(?:the|this|that|these|those|my|our|your|his|her|their|an?|it|what|all)$/], ['in any case'], ['at any rate'], ['for this reason'], ['on the whole'],
  ['in reality'], ['in practice'],
];

/** Words that plausibly begin the main clause after an introductory phrase. */
const MAIN_CLAUSE_OPENERS = new Set([
  'i', 'we', 'they', 'he', 'she', 'it', 'you', 'the', 'a', 'an', 'this', 'that', 'these', 'those', 'there',
  'my', 'our', 'your', 'his', 'her', 'their', 'its', 'people', 'everyone', 'someone', 'nobody', 'what',
  'when', 'if',
]);

/** Quantifiers also open a clause, except after an adverb that may modify them ("Surprisingly few…"). */
const QUANTIFIER_OPENERS = new Set([
  'some', 'many', 'most', 'all', 'both', 'no', 'each', 'every', 'one', 'two', 'several', 'few',
]);

const INTRO_RE = new RegExp(
  `^(${INTRODUCTIONS.map(([p]) => p.replace(/ /g, '\\s+'))
    .sort((a, b) => b.length - a.length)
    .join('|')}) (?=\\p{L})`,
  'iu',
);
const INTRO_GUARD = new Map(INTRODUCTIONS.map(([p, g]) => [p, g] as const));

function introductoryCommas(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'heading') return;
  const t = ctx.norm;
  for (const s of ctx.sentences) {
    if (s.words < 4) continue;
    const sentence = t.slice(s.firstWord, s.to);
    const m = INTRO_RE.exec(sentence);
    if (!m) continue;
    const phrase = m[1];
    const end = s.firstWord + phrase.length;
    const following = nextWord(t, end);
    const isProper = /\p{Lu}/u.test(t[end + 1] ?? '');
    const adverb = /^\p{L}+ly$/iu.test(phrase);
    const opens = MAIN_CLAUSE_OPENERS.has(following) || (!adverb && QUANTIFIER_OPENERS.has(following));
    if (!opens && !isProper) continue;
    const guard = INTRO_GUARD.get(phrase.toLowerCase().replace(/\s+/g, ' '));
    if (guard && guard.test(following)) continue;
    push(ctx, out, {
      from: s.firstWord,
      to: end,
      ruleId: 'ws/introductory-comma',
      category: 'correctness',
      type: 'punctuation',
      title: 'Add a comma',
      message: `Use a comma after an introductory word or phrase such as “${ctx.text.slice(s.firstWord, end)}.”`,
      fixes: [{ from: end, to: end, text: ',', label: `${ctx.text.slice(s.firstWord, end)},` }],
      priority: PRIORITY,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Comma before "but"                                                  */
/* ------------------------------------------------------------------ */

const BUT_RE = /(?<![,;:—–-])\s(but)\s+(?:I|we|they|he|she|it|you|I'm|I've|we're|they're|it's|he's|she's|you're)\s+\p{L}+/gu;

function commaBeforeBut(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  for (const s of ctx.sentences) {
    const sentence = t.slice(s.from, s.to);
    BUT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BUT_RE.exec(sentence)) !== null) {
      const space = s.from + m.index;
      const before = t.slice(s.firstWord, space);
      if (countWords(before) < 4) continue;
      if (/\bnot only\b/i.test(before)) continue;
      // "everyone but I", "nothing but it"
      if (/^(?:everyone|everybody|anyone|anybody|nobody|none|all|anything|nothing|everything|one|last)$/.test(previousWord(t, space))) {
        continue;
      }
      const from = wordStart(t, space);
      push(ctx, out, {
        from,
        to: space + 4,
        ruleId: 'ws/comma-before-but',
        category: 'correctness',
        type: 'punctuation',
        title: 'Add a comma',
        message: 'Use a comma before “but” when it joins two complete thoughts.',
        fixes: [{ from: space, to: space, text: ',', label: `${ctx.text.slice(from, space)}, but` }],
        priority: PRIORITY - 4,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Dates, repeated marks, spacing, quotation marks                     */
/* ------------------------------------------------------------------ */

const DATE_RE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}(?:st|nd|rd|th)?)\s+(\d{4})\b/dg;

function simpleMarks(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;

  scan(t, DATE_RE, (m) => {
    const day = m.indices?.[2];
    if (!day) return;
    const from = m.index;
    const to = from + m[0].length;
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/date-comma',
      category: 'correctness',
      type: 'punctuation',
      title: 'Add a comma',
      message: 'In a month-day-year date, put a comma between the day and the year.',
      fixes: [{ from: day[1], to: day[1], text: ',', label: `${m[1]} ${m[2]}, ${m[3]}` }],
      priority: PRIORITY,
    });
  });

  // "!!", "??", ",,", ";;"
  scan(t, /([!?,;])\1+/g, (m) => {
    const mark = m[1];
    if ((mark === '!' || mark === '?') && !ctx.profile.slang) return; // casual writing: let it be
    const from = wordStart(t, m.index);
    const to = m.index + m[0].length;
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/repeated-punctuation',
      category: 'correctness',
      type: 'punctuation',
      title: 'Remove the extra punctuation',
      message:
        mark === '!' || mark === '?'
          ? `One “${mark}” is enough. Repeating it can make writing look less polished.`
          : `There is a repeated “${mark}” here.`,
      fixes: [{ from: m.index + 1, to, text: '', label: `${t.slice(from, m.index)}${mark}` }],
      priority: PRIORITY,
    });
  });

  // A space before , . ! ? ; :
  scan(t, /(?<=[\p{L}\p{N}"')\]])( +)(?:[,.!?](?=\s|$|["')\]])|[;:](?=\s|$))/dgu, (m) => {
    const mark = m[0][m[0].length - 1];
    if (mark === '.' && t[m.index + m[0].length] === '.') return; // spaced ellipsis
    const from = wordStart(t, m.index);
    const to = m.index + m[0].length;
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/space-before-punctuation',
      category: 'correctness',
      type: 'punctuation',
      title: 'Remove the space',
      message: `There should be no space before “${mark}”.`,
      fixes: [{ from: m.index, to: to - 1, text: '', label: `${ctx.text.slice(from, m.index)}${mark}` }],
      priority: PRIORITY - 2,
    });
  });

  // "word,word" and "end.Next"
  scan(t, /(?<=\p{L})([,;])(?=\p{L})|(?<=\p{Ll}{2})(\.)(?=\p{Lu}\p{Ll})/dgu, (m) => {
    const at = m.index;
    const from = wordStart(t, at);
    const to = wordEnd(t, at + 1);
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/space-after-punctuation',
      category: 'correctness',
      type: 'punctuation',
      title: 'Add a space',
      message: `Add a space after “${m[0]}”.`,
      fixes: [{ from: at + 1, to: at + 1, text: ' ', label: `${ctx.text.slice(from, at + 1)} ${ctx.text.slice(at + 1, to)}` }],
      priority: PRIORITY - 2,
    });
  });

  // American style: periods and commas go inside closing quotation marks.
  if (ctx.dialect === 'american' || ctx.dialect === 'canadian') {
    scan(t, /(?<=\S)"([,.])(?=\s|$)/dg, (m) => {
      const quote = m.index;
      const open = t.lastIndexOf('"', quote - 1);
      if (open < 0) return;
      const inner = t.slice(open + 1, quote);
      if (inner.length <= 1 || !/\p{L}/u.test(inner) || /[_/\\=<>{}()[\]]/.test(inner)) return;
      const from = wordStart(t, quote);
      const to = quote + 2;
      const original = ctx.text[quote];
      push(ctx, out, {
        from,
        to,
        ruleId: 'ws/quote-punctuation',
        category: 'correctness',
        type: 'punctuation',
        title: 'Move the punctuation',
        message: 'In American English, periods and commas go inside closing quotation marks.',
        fixes: [{ from: quote, to, text: `${m[1]}${original}`, label: `${ctx.text.slice(from, quote)}${m[1]}${original}` }],
        priority: PRIORITY - 6,
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Missing end punctuation, unmatched brackets                         */
/* ------------------------------------------------------------------ */

function endPunctuation(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.editing) return;
  if (ctx.kind !== 'paragraph' && ctx.kind !== 'quote') return;
  const t = ctx.text;
  const trimmed = t.trimEnd();
  if (!trimmed) return;
  const last = trimmed[trimmed.length - 1];
  if (!/[\p{L}\p{N}]/u.test(last)) return;
  const words = countWords(trimmed);
  // A short line with no punctuation at all is probably a title or label.
  if (words < 8 && !/[.!?]/.test(trimmed)) return;
  const end = trimmed.length;
  const from = wordStart(t, end);
  push(ctx, out, {
    from,
    to: end,
    ruleId: 'ws/missing-end-punctuation',
    category: 'correctness',
    type: 'punctuation',
    title: 'Add a period',
    message: 'This paragraph ends without a punctuation mark.',
    fixes: [{ from: end, to: end, text: '.', label: `${t.slice(from, end)}.` }],
    priority: PRIORITY - 10,
  });
}

/** The eyes (and optional nose) of an emoticon, right before a bracket: ":", ";-", "=". */
const EMOTICON_EYES = /(?:^|\s)[:;=8]-?$/;
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function unmatchedBrackets(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.text;
  if (!/[()[\]{}]/.test(t)) return;
  const stack: Array<{ ch: string; at: number }> = [];
  const bad: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (PAIRS[ch]) {
      // Emoticons such as ":(", ":-(" and "(:"
      if (ch === '(' && (EMOTICON_EYES.test(t.slice(Math.max(0, i - 3), i)) || /^[:;](?:\s|$)/.test(t.slice(i + 1, i + 3)))) continue;
      stack.push({ ch, at: i });
    } else if (CLOSERS[ch]) {
      if (ch === ')' && EMOTICON_EYES.test(t.slice(Math.max(0, i - 3), i))) continue;
      // List markers such as "1)" and "a)"
      if (ch === ')' && /(?:^|\s)[\p{L}\p{N}]{1,3}$/u.test(t.slice(Math.max(0, i - 4), i))) {
        const top = stack[stack.length - 1];
        if (!top || top.ch !== '(') continue;
      }
      const top = stack[stack.length - 1];
      if (top && top.ch === CLOSERS[ch]) stack.pop();
      else bad.push(i);
    }
  }
  for (const open of stack) bad.push(open.at);
  for (const at of bad) {
    const opening = Boolean(PAIRS[t[at]]);
    const from = opening ? at : wordStart(t, at);
    const to = opening ? wordEnd(t, at + 1) : at + 1;
    push(ctx, out, {
      from,
      to: Math.max(to, at + 1),
      ruleId: 'ws/unmatched-bracket',
      category: 'correctness',
      type: 'punctuation',
      title: opening ? 'Close the bracket' : 'Remove or pair the bracket',
      message: opening
        ? `This “${t[at]}” is never closed.`
        : `This “${t[at]}” has no matching opening bracket.`,
      fixes: [],
      priority: PRIORITY - 8,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Hyphenated compound modifiers                                       */
/* ------------------------------------------------------------------ */

const COMPOUNDS = [
  'well known', 'well written', 'well designed', 'well deserved', 'well established', 'well defined',
  'well documented', 'well educated', 'well informed', 'well received', 'well respected', 'well suited',
  'high quality', 'high level', 'high speed', 'high risk', 'high performance', 'high resolution', 'high end',
  'low cost', 'low risk', 'low level', 'low income', 'long term', 'short term', 'long lasting',
  'long standing', 'full time', 'part time', 'real time', 'real world', 'first class', 'world class',
  'second hand', 'user friendly', 'cost effective', 'time consuming', 'state of the art', 'up to date',
  'out of date', 'easy to use', 'one of a kind', 'day to day', 'face to face', 'step by step', 'open ended',
  'old fashioned', 'middle aged', 'fast paced', 'in depth', 'in house', 'on site', 'off site',
  'third party', 'top notch', 'cutting edge', 'record breaking', 'award winning', 'eye catching',
  'thought provoking', 'data driven', 'customer facing', 'forward looking', 'full length', 'large scale',
  'small scale', 'wide ranging', 'far reaching', 'hard working', 'good looking', 'well being',
];

const COMPOUND_RE = new RegExp(
  `(?<![\\p{L}\\p{N}-])(${[...COMPOUNDS]
    .sort((a, b) => b.length - a.length)
    .map((c) => c.replace(/ /g, '\\s'))
    .join('|')})(?![\\p{L}\\p{N}-])`,
  'dgiu',
);

const SELF_RE =
  /(?<![\p{L}\p{N}-])(self) (esteem|aware|awareness|employed|taught|service|confident|confidence|control|care|made|sufficient|explanatory|defense|discipline|respect|image|interest|doubt|conscious|contained|help|improvement|assessment|reliant|centered|evident)\b/dgiu;

const NUMBER_UNIT_RE =
  /\b(?:an?|the|my|our|your|his|her|their|this|that|another|every|each|any) ((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty) (?:year|month|week|day|hour|minute|mile|page|story|bedroom|point|step|part|person|word|digit|star|foot|inch|dollar|pound|time)(?: old)?) (\p{L}+)/dgiu;

/** Words after a compound that show it is not modifying a noun. */
const NOT_A_NOUN = new Set([
  'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were',
  'be', 'been', 'as', 'than', 'that', 'which', 'who', 'when', 'while', 'if', 'so', 'because', 'the', 'a', 'an',
  'this', 'these', 'those', 'it', 'he', 'she', 'we', 'they', 'you', 'i', 'not', 'too', 'very', 'also', 'now',
  'then', 'here', 'there', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'has', 'have',
  'had', 'do', 'does', 'did', 'since', 'until', 'after', 'before', 'about', 'into', 'over', 'under',
  'through', 'during', 'between', 'against', 'without', 'within', 'per', 'via', 'although', 'though',
  'unless', 'whereas', 'again', 'already', 'always', 'never', 'often', 'still', 'just', 'only', 'ago',
  'later', 'soon', 'today', 'tomorrow', 'yesterday', 'using', 'where', 'how', 'why', 'my', 'our', 'your',
  'his', 'her', 'their', 'its', 'enough', 'yet', 'anymore', 'instead', 'either', 'old', 'some', 'any', 'all',
  'each', 'every', 'both', 'many', 'much', 'more', 'most', 'few', 'several', 'no', 'other', 'another', 'one',
  'two', 'three', 'daily', 'weekly', 'monthly', 'together', 'alone', 'what', 'whenever', 'once',
]);

/** Words before a compound that put it in front of a noun (rather than after a verb, adverbially). */
const MODIFIER_POSITION = new Set([
  '', 'a', 'an', 'the', 'our', 'their', 'my', 'your', 'his', 'her', 'its', 'this', 'that', 'these', 'those',
  'some', 'any', 'no', 'more', 'most', 'very', 'truly', 'every', 'each', 'all', 'both', 'many', 'few',
  'several', 'other', 'another', 'new', 'for', 'with', 'of', 'to', 'from', 'by', 'as', 'and', 'or', 'provide',
  'provides', 'offer', 'offers', 'need', 'needs', 'have', 'has', 'had', 'want', 'wants', 'get', 'gets', 'use',
  'uses', 'build', 'builds', 'make', 'makes', 'deliver', 'delivers', 'require', 'requires',
]);

/** Compounds written with a hyphen wherever they appear. */
const ALWAYS_HYPHENATED = new Set(['well being']);

function compoundModifiers(ctx: RuleContext, out: RawIssue[]): void {
  const t = ctx.norm;
  const emit = (from: number, to: number, hyphenated: string) => {
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/compound-hyphen',
      category: 'correctness',
      type: 'punctuation',
      title: 'Add a hyphen',
      message: 'When two or more words work together as a single description before a noun, join them with hyphens.',
      fixes: [{ from, to, text: hyphenated, label: hyphenated }],
      priority: PRIORITY - 4,
    });
  };

  scan(t, COMPOUND_RE, (m) => {
    const from = m.index;
    const to = from + m[1].length;
    const key = m[1].toLowerCase().replace(/\s+/g, ' ');
    if (!ALWAYS_HYPHENATED.has(key)) {
      // Only a modifier when a noun-like word follows directly: "a full time job", not "works full time."
      const after = t[to] === ' ' && /\p{L}/u.test(t[to + 1] ?? '') ? nextWord(t, to) : '';
      if (!after || NOT_A_NOUN.has(after) || after.endsWith('ed')) return;
      const before = ctx.sentenceStarts.has(from) ? '' : previousWord(t, from);
      if (!MODIFIER_POSITION.has(before)) return;
      // "in the long term", "on the cutting edge": a noun phrase, not a modifier.
      if (/\b(?:in|on|over|at|during|for)\s+the\s+$/i.test(t.slice(Math.max(0, from - 14), from))) return;
    }
    emit(from, to, ctx.text.slice(from, to).replace(/\s+/g, '-'));
  });

  scan(t, SELF_RE, (m) => {
    const from = m.index;
    const to = from + m[0].length;
    emit(from, to, ctx.text.slice(from, to).replace(/\s+/g, '-'));
  });

  scan(t, NUMBER_UNIT_RE, (m) => {
    const r = m.indices?.[1];
    if (!r) return;
    if (NOT_A_NOUN.has(m[2].toLowerCase())) return;
    emit(r[0], r[1], ctx.text.slice(r[0], r[1]).replace(/\s+/g, '-'));
  });
}

export function punctuationRules(ctx: RuleContext, out: RawIssue[]): void {
  if (ctx.kind === 'code') return;
  commaSplices(ctx, out);
  missingQuestionMarks(ctx, out);
  introductoryCommas(ctx, out);
  commaBeforeBut(ctx, out);
  simpleMarks(ctx, out);
  endPunctuation(ctx, out);
  unmatchedBrackets(ctx, out);
  compoundModifiers(ctx, out);
}
