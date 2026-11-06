/**
 * Hand-written grammar and confused-word rules. These cover common mistakes the
 * Harper engine does not catch. Each pattern is deliberately narrow: a missed
 * error is better than a wrong correction.
 */
import type { IssueType } from '../types';
import {
  clauseInitial,
  groupRange,
  previousWord,
  push,
  replacements,
  scan,
  type RawIssue,
  type RuleContext,
} from './context';

/** Priority for these rules: above Harper (100) because the fixes are exact. */
const PRIORITY = 110;

interface Hit {
  from: number;
  to: number;
  options: string[];
  message: string;
  title?: string;
}

interface GrammarRule {
  id: string;
  title: string;
  type?: IssueType;
  re: RegExp;
  match(m: RegExpExecArray, ctx: RuleContext): Hit | null;
}

const IRREGULAR_PLURALS = new Set(['people', 'children', 'men', 'women', 'mice', 'teeth', 'feet', 'geese']);

/** Words ending in "s" that are not countable plurals (mass nouns, verbs, adverbs). */
const NOT_PLURAL = new Set([
  'news', 'series', 'species', 'means', 'always', 'perhaps', 'besides', 'towards', 'sometimes', 'afterwards',
  'overseas', 'plus', 'gas', 'bias', 'thanks', 'yes', 'was', 'has', 'does', 'goes', 'its', 'hers', 'ours',
  'yours', 'theirs', 'this', 'unless', 'across', 'thus', 'bus', 'chaos', 'cosmos', 'ethos', 'pathos', 'kudos',
  'lens', 'measles', 'mumps', 'diabetes', 'rabies', 'headquarters', 'canvas', 'alias', 'christmas', 'seems',
  'happens', 'remains', 'exists', 'matters', 'depends', 'comes', 'gets', 'makes', 'takes', 'becomes', 'needs',
  'works', 'costs', 'looks', 'feels', 'sounds', 'appears', 'applies', 'says', 'knows', 'wants', 'tends',
  'helps', 'shows', 'gives', 'uses', 'keeps', 'lets', 'puts', 'runs', 'turns', 'tries', 'brings', 'begins',
  'starts', 'stops', 'stays', 'stands', 'lies', 'sits', 'leads', 'moves', 'pays', 'plays', 'reads', 'sees',
  'sends', 'sets', 'speaks', 'spends', 'tells', 'thinks', 'wins', 'writes', 'relies', 'hinges', 'rests',
  'varies', 'changes', 'goods', 'earnings', 'savings', 'clothes', 'riches', 'surroundings', 'belongings',
]);

function looksPluralCountable(word: string): boolean {
  const w = word.toLowerCase();
  if (IRREGULAR_PLURALS.has(w)) return true;
  if (w.length < 4 || !w.endsWith('s')) return false;
  if (/(?:ss|us|is|ous|ics|ness|less)$/.test(w)) return false;
  return !NOT_PLURAL.has(w);
}

function range(m: RegExpExecArray, n: number): [number, number] {
  return groupRange(m, n) ?? [m.index, m.index + m[0].length];
}

const whole = (m: RegExpExecArray): [number, number] => [m.index, m.index + m[0].length];

const GERUNDS: Record<string, string> = {
  hear: 'hearing', see: 'seeing', meet: 'meeting', work: 'working', talk: 'talking', speak: 'speaking',
  receive: 'receiving', learn: 'learning', read: 'reading', visit: 'visiting', discuss: 'discussing',
  get: 'getting', have: 'having', be: 'being', join: 'joining', welcome: 'welcoming',
  collaborate: 'collaborating', start: 'starting', continue: 'continuing', do: 'doing', make: 'making',
  attend: 'attending', chat: 'chatting', connect: 'connecting', catch: 'catching', share: 'sharing',
  go: 'going', come: 'coming',
};

const NEGATIVE_TO_POSITIVE: Record<string, string> = {
  no: 'any', nothing: 'anything', nobody: 'anybody', nowhere: 'anywhere', none: 'any', neither: 'either',
};

const SINGULAR_VERB: Record<string, string> = {
  have: 'has', are: 'is', were: 'was', do: 'does', "don't": "doesn't", "aren't": "isn't", "weren't": "wasn't",
  "haven't": "hasn't",
};

const BE_AUX = new Set([
  'are', 'were', 'is', 'was', "aren't", "weren't", "isn't", "wasn't", 'will', 'would', 'can', 'could',
  'should', 'might', 'may', 'must', 'be', 'been', 'being',
]);

const RULES: GrammarRule[] = [
  {
    id: 'ws/less-fewer',
    title: 'Use “fewer”',
    re: /\b(less)\s+(\p{L}+)\b/dgiu,
    match(m, ctx) {
      if (!looksPluralCountable(m[2])) return null;
      const prev = previousWord(ctx.text, m.index);
      if (['or', 'much', 'no', 'nothing', 'none', 'far', 'even'].includes(prev)) return null;
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['fewer'],
        message: `Use “fewer” with things you can count, such as “${m[2].toLowerCase()}.” “Less” is for amounts you measure rather than count.`,
      };
    },
  },
  {
    id: 'ws/amount-number',
    title: 'Use “number”',
    re: /\b(amount)s? of (\p{L}+)\b/dgiu,
    match(m) {
      if (!looksPluralCountable(m[2])) return null;
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['number'],
        message: `Use “number” with things you can count, such as “${m[2].toLowerCase()}.” “Amount” is for things you measure.`,
      };
    },
  },
  {
    id: 'ws/much-many',
    title: 'Use “many”',
    re: /\b(?:so|too|how|as|very|that|this|not|is|are|was|were|have|has|had|with|of|for) (much) (\p{L}+)\b/dgiu,
    match(m) {
      if (!looksPluralCountable(m[2])) return null;
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['many'],
        message: `Use “many” with things you can count, such as “${m[2].toLowerCase()}.” “Much” is for amounts you measure.`,
      };
    },
  },
  {
    id: 'ws/weather-whether',
    title: 'Use “whether”',
    re: /\b(weather) or not\b|\b(?:know|knows|knew|wonder|wonders|wondered|wondering|unsure|sure|decide|decided|ask|asked|determine|doubt|question|see|check|tell)(?: (?:me|you|us|them|him|her|yet|about))? (weather) (?=(?:I|we|you|they|he|she|it|its|it's|it’s|to|the|this|that|or|an?|my|your|our|their)\b)/dgi,
    match(m) {
      const [from, to] = range(m, m[1] ? 1 : 2);
      return {
        from,
        to,
        options: ['whether'],
        message: '“Weather” is the state of the atmosphere. To introduce alternatives, use “whether.”',
      };
    },
  },
  {
    id: 'ws/your-youre',
    title: 'Use “you’re”',
    re: /\b(your) (?:welcome(?! (?:mat|message|email|page|screen|kit|party|gift|package|bonus|back|sign))|not|so|too|kidding|joking|probably|gonna|going to|the (?:best|one|only)|an?|always|never|really|also|absolutely|definitely|supposed to|allowed to|about to|doing (?:great|well|fine))\b(?![-’'])/dgi,
    match(m) {
      if (/ A$/.test(m[0])) return null; // "your A game"
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ["you're"],
        message: '“Your” shows possession. Here you need “you’re,” the contraction of “you are.”',
      };
    },
  },
  {
    id: 'ws/youre-your',
    title: 'Use “your”',
    re: /\b(you're|you’re|youre) (?:own|name|house|car|job|life|email|message|help|support|order|account|password|phone|company|idea|opinion|question|answer|feedback|turn|fault|choice|problem|attention|consideration|patience|cooperation|interest|response|reply|request|kind words|hard work)\b(?![-’'])/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['your'],
        message: '“You’re” means “you are.” To show possession, use “your.”',
      };
    },
  },
  {
    id: 'ws/its-contraction',
    title: 'Use “it’s”',
    re: /\b(its) (?:an?|the|not|been|going to|gonna|time to(?! market)|too|really|just|always|never|also|still|like|about|because|okay|ok|raining|snowing|getting|coming|becoming|happening|going|so|quite|rather|almost|already|probably|definitely|certainly|obviously|actually|basically|currently|now|here|there|over|me|him|her|us|them|you|what|where|when|why|how|all|up to|only a|worth (?:it|a|the|noting|mentioning|considering)|(?:important|clear|possible|impossible|hard|easy|difficult|true|nice|good|great|bad|obvious|likely|unlikely|necessary|essential|best|better|sad|fun|funny|amazing|interesting|strange|weird|crazy) (?:to|that|for|if|when|because|how))\b(?![-’'])/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ["it's"],
        message: '“Its” shows possession. Here you need “it’s,” the contraction of “it is” or “it has.”',
      };
    },
  },
  {
    id: 'ws/its-possessive',
    title: 'Use “its”',
    re: /\b(it's|it’s) (?:own|purpose|size|shape|origin|contents|impact|ability|members|users|customers|owners?|value|price|predecessor|successor|creator|founder|entirety|inception|name)\b(?![-’'])/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['its'],
        message: '“It’s” means “it is” or “it has.” To show possession, use “its” with no apostrophe.',
      };
    },
  },
  {
    id: 'ws/their-there',
    title: 'Use “there”',
    re: /\b(their) (?:is|are|was|were|isn't|aren't|wasn't|weren't|will be|has been|have been|might be|may be|must be|should be|could be|would be|seems to be)\b/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['there'],
        message: '“Their” shows possession. To say that something exists, use “there.”',
      };
    },
  },
  {
    id: 'ws/there-their',
    title: 'Use “their”',
    re: /\b(there) (?:own|house|car|children|kids|parents|friends|lives|jobs|opinions?|names?|mother|father|families|phones?)\b/dgi,
    match(m, ctx) {
      if (BE_AUX.has(previousWord(ctx.text, m.index))) return null; // "Are there children here?"
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['their'],
        message: '“There” refers to a place or existence. To show possession, use “their.”',
      };
    },
  },
  {
    id: 'ws/theyre-their',
    title: 'Use “their”',
    re: /\b(they're|they’re|theyre) (?:own|house|car|lives|jobs|opinions|names|mother|father|phones|money)\b/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['their'],
        message: '“They’re” means “they are.” To show possession, use “their.”',
      };
    },
  },
  {
    id: 'ws/whos-whose',
    title: 'Use “whose”',
    re: /\b(who's|who’s) (?:book|car|house|idea|turn|fault|name|job|side|phone|dog|cat|responsibility|life|work|team|opinion|decision|problem|plan)\b/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['whose'],
        message: '“Who’s” means “who is” or “who has.” To ask about ownership, use “whose.”',
      };
    },
  },
  {
    id: 'ws/whose-whos',
    title: 'Use “who’s”',
    re: /\b(whose) (?:going|coming|there|here|been|got|responsible|in charge|your|the|an?|to blame|ready)\b(?![-’'])/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ["who's"],
        message: '“Whose” shows ownership. Here you need “who’s,” the contraction of “who is” or “who has.”',
      };
    },
  },
  {
    id: 'ws/seen-done',
    title: 'Change the verb form',
    re: /\b(I|we|they|you|he|she) (seen|done)\b/dgi,
    match(m, ctx) {
      if (!clauseInitial(ctx.text, m.index)) return null; // "Have you seen…"
      const [from, to] = range(m, 2);
      const third = /^(?:he|she)$/i.test(m[1]);
      const verb = m[2].toLowerCase();
      const helper = third ? 'has' : 'have';
      return {
        from,
        to,
        options: verb === 'seen' ? ['saw', `${helper} seen`] : ['did', `${helper} done`],
        message: `“${verb[0].toUpperCase() + verb.slice(1)}” is a past participle and needs a helping verb such as “${helper}.” For the simple past, use “${verb === 'seen' ? 'saw' : 'did'}.”`,
      };
    },
  },
  {
    id: 'ws/pronoun-was',
    title: 'Change the verb form',
    re: /\b(we|they|you) (was|wasn't|wasn’t)\b/dgi,
    match(m, ctx) {
      if (!clauseInitial(ctx.text, m.index)) return null;
      const [from, to] = range(m, 2);
      return {
        from,
        to,
        options: [m[2].toLowerCase() === 'was' ? 'were' : "weren't"],
        message: `The verb must agree with its subject. With “${m[1].toLowerCase()},” use “were.”`,
      };
    },
  },
  {
    id: 'ws/there-is-plural',
    title: 'Change the verb form',
    re: /\bthere (is|was) (?:many|several|a few|two|three|four|five|six|seven|eight|nine|ten|multiple|numerous|various|so many|too many|a number of|a couple of)\b/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      const plural = m[1].toLowerCase() === 'is' ? 'are' : 'were';
      return {
        from,
        to,
        options: [plural],
        message: `The verb should agree with the plural noun that follows. Use “there ${plural}.”`,
      };
    },
  },
  {
    id: 'ws/this-these',
    title: 'Fix the agreement',
    re: /\b(this are|these is|those is|these was|those was)\b/dgi,
    match(m, ctx) {
      if (!clauseInitial(ctx.text, m.index)) return null; // "One of these is…"
      const [from, to] = whole(m);
      const k = m[1].toLowerCase();
      const options =
        k === 'this are'
          ? ['these are', 'this is']
          : k === 'these is'
            ? ['these are', 'this is']
            : k === 'those is'
              ? ['those are', 'that is']
              : k === 'these was'
                ? ['these were', 'this was']
                : ['those were', 'that was'];
      return { from, to, options, message: 'The pronoun and the verb must agree in number.' };
    },
  },
  {
    id: 'ws/indefinite-pronoun-agreement',
    title: 'Change the verb form',
    re: /\b(everyone|everybody|someone|somebody|anyone|anybody|no one|nobody|nothing|everything|something|anything) (have|are|were|do|don't|aren't|weren't|haven't)\b/dgi,
    match(m, ctx) {
      // "Does everyone have…" and "I suggest that everyone have…" are fine.
      if (!clauseInitial(ctx.text, m.index, ['that'])) return null;
      const [from, to] = range(m, 2);
      const verb = m[2].toLowerCase().replace('’', "'");
      return {
        from,
        to,
        options: [SINGULAR_VERB[verb]],
        message: `“${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()}” is singular, so it takes a singular verb.`,
      };
    },
  },
  {
    id: 'ws/me-and-subject',
    title: 'Change the pronoun',
    re: /\b(Me and (?:him|her|them|you|my \p{L}+|\p{Lu}\p{L}+)|(?:Him|Her|Them) and (?:me|I))\b(?= \p{L})/dgu,
    match(m, ctx) {
      if (!ctx.sentenceStarts.has(m.index)) return null;
      const [from, to] = whole(m);
      const t = m[1];
      let option: string;
      if (/^Me and him$/.test(t) || /^Him and/.test(t)) option = 'He and I';
      else if (/^Me and her$/.test(t) || /^Her and/.test(t)) option = 'She and I';
      else if (/^Me and them$/.test(t) || /^Them and/.test(t)) option = 'They and I';
      else if (/^Me and you$/.test(t)) option = 'You and I';
      else if (/^Me and my /.test(t)) option = `My ${t.slice('Me and my '.length)} and I`;
      else option = `${t.slice('Me and '.length)} and I`;
      return {
        from,
        to,
        options: [option],
        message: 'As the subject of a sentence, use subject pronouns (“I,” “he,” “she,” “they”) and put yourself last.',
      };
    },
  },
  {
    id: 'ws/between-you-and-i',
    title: 'Use “me”',
    re: /\b[Bb]etween (?:you|him|her|them|\p{Lu}\p{L}+) and (I)\b(?!')|\b(?:[Ff]or|[Ww]ith|[Tt]o|[Ff]rom|[Aa]bout|[Ll]ike) (?:you|him|her|them|\p{Lu}\p{L}+) and (I)\b(?=\s*(?:[.,;:!?)]|$))/dgu,
    match(m) {
      const [from, to] = range(m, m[1] ? 1 : 2);
      return {
        from,
        to,
        options: ['me'],
        message: 'After a preposition, use the object pronoun “me,” not “I.”',
      };
    },
  },
  {
    id: 'ws/double-negative',
    title: 'Remove the double negative',
    re: /\b(?:don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|ain't|never|cannot)(?: (\p{L}+))? (no one|no|nothing|nobody|nowhere|none|neither)\b(?! matter)/dgiu,
    match(m) {
      const middle = (m[1] ?? '').toLowerCase();
      const neg = m[2].toLowerCase();
      // "couldn't say no", "won't take no for an answer"
      if (neg === 'no' && /^(?:say|said|take|accept|mean|means|answer|hear|vote|voted|tell|told|just|simply|is|was)$/.test(middle)) {
        return null;
      }
      if (/^(?:and|or|but|so|because|if|when|that)$/.test(middle)) return null;
      const [from, to] = range(m, 2);
      return {
        from,
        to,
        options: [neg === 'no one' ? 'anyone' : NEGATIVE_TO_POSITIVE[neg]],
        message: 'Two negatives in one clause cancel each other out. Use a single negative to keep the meaning clear.',
      };
    },
  },
  {
    id: 'ws/hardly-negative',
    title: 'Remove the double negative',
    re: /\b(can't|couldn't|don't|didn't|won't|wouldn't) (hardly|barely|scarcely)\b/dgi,
    match(m) {
      const [from, to] = whole(m);
      const map: Record<string, string> = {
        "can't": 'can', "couldn't": 'could', "don't": '', "didn't": '', "won't": 'will', "wouldn't": 'would',
      };
      const aux = map[m[1].toLowerCase().replace('’', "'")];
      return {
        from,
        to,
        options: [aux ? `${aux} ${m[2].toLowerCase()}` : m[2].toLowerCase()],
        message: `“${m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()}” is already negative, so pairing it with “not” makes a double negative.`,
      };
    },
  },
  {
    id: 'ws/reason-is-because',
    title: 'Use “that”',
    re: /\breason(?: why)?(?: \p{L}+){0,4}? (?:is|was) (because)\b/dgiu,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ['that'],
        message: '“The reason is because” says the same thing twice. Use “the reason is that.”',
      };
    },
  },
  {
    id: 'ws/could-care-less',
    title: 'Change the phrase',
    re: /\b(could care less)\b/dgi,
    match(m) {
      const [from, to] = whole(m);
      return {
        from,
        to,
        options: ["couldn't care less"],
        message: 'To say you do not care at all, the standard phrase is “couldn’t care less.”',
      };
    },
  },
  {
    id: 'ws/am-agree',
    title: 'Change the verb form',
    re: /\b(I am|I'm|I’m|we are|we're|we’re|you are|you're|you’re|they are|they're|they’re) (agree|disagree)\b|\b(he|she|it) is (agree|disagree)\b/dgi,
    match(m) {
      const [from, to] = whole(m);
      if (m[3]) {
        return {
          from,
          to,
          options: [`${m[3]} ${m[4].toLowerCase()}s`],
          message: '“Agree” is a verb, so it does not need “is.”',
        };
      }
      const subject = m[1].split(/[ '’]/)[0];
      return {
        from,
        to,
        options: [`${subject} ${m[2].toLowerCase()}`],
        message: '“Agree” is a verb, so it does not need a form of “be.”',
      };
    },
  },
  {
    id: 'ws/look-forward-to',
    title: 'Change the verb form',
    re: /\b(?:look|looks|looking|looked) forward to (hear|see|meet|work|talk|speak|receive|learn|read|visit|discuss|get|have|be|join|welcome|collaborate|start|continue|do|make|attend|chat|connect|catch|share|go|come)\b/dgi,
    match(m) {
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: [GERUNDS[m[1].toLowerCase()]],
        message: 'In “look forward to,” the word “to” is a preposition, so it is followed by an “-ing” form.',
      };
    },
  },
  {
    id: 'ws/lets-contraction',
    title: 'Use “let’s”',
    re: /\b(lets) (?:go|see|say|get|start|talk|take|make|do|try|begin|be|have|look|move|keep|not|just|all|meet|find|think|assume|consider|face it|hope|discuss|review|work|eat|play|call|continue|check|dive|break|focus)\b/dgi,
    match(m, ctx) {
      // "He lets go of the rope" is fine: require the start of a sentence or clause punctuation.
      if (!clauseInitial(ctx.text, m.index, ['and', 'or', 'but', 'then', 'that', 'yet', ','])) return null;
      const [from, to] = range(m, 1);
      return {
        from,
        to,
        options: ["let's"],
        message: '“Lets” means “allows.” For a suggestion, use “let’s,” the contraction of “let us.”',
      };
    },
  },
  {
    id: 'ws/double-comparative',
    title: 'Remove the extra word',
    re: /\b(more) (?:better|worse|easier|harder|faster|slower|bigger|smaller|larger|stronger|weaker|higher|lower|cheaper|older|younger|taller|shorter|longer|simpler|nicer|safer|closer|smarter|happier|busier|earlier)\b|\b(most) (?:best|worst|biggest|smallest|easiest|hardest|fastest|largest|strongest|highest|lowest|greatest)\b/dgi,
    match(m) {
      const [from, to] = range(m, m[1] ? 1 : 2);
      return {
        from,
        to,
        options: [''],
        message: 'This adjective is already in its comparative or superlative form, so “more” or “most” is redundant.',
      };
    },
  },
  {
    id: 'ws/in-regards-to',
    title: 'Change the phrase',
    re: /\b(in regards to|with regards to)\b/dgi,
    match(m) {
      const [from, to] = whole(m);
      const first = m[1].toLowerCase().startsWith('in') ? 'in regard to' : 'with regard to';
      return {
        from,
        to,
        options: ['regarding', first],
        message: 'The standard phrase uses the singular “regard.” “Regarding” is shorter still.',
      };
    },
  },
];

/** Contractions typed without their apostrophe. */
const MISSING_APOSTROPHE: Record<string, string> = {
  im: "I'm", ive: "I've", youre: "you're", theyre: "they're", thats: "that's", whats: "what's", isnt: "isn't",
  arent: "aren't", wasnt: "wasn't", werent: "weren't", didnt: "didn't", doesnt: "doesn't", dont: "don't",
  couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't", havent: "haven't", hasnt: "hasn't",
  hadnt: "hadn't", wouldve: "would've", couldve: "could've", shouldve: "should've", youll: "you'll",
  theyll: "they'll", youve: "you've", theyve: "they've", weve: "we've", theres: "there's", heres: "here's",
  wheres: "where's", hows: "how's", whos: "who's", cant: "can't", wont: "won't", oclock: "o'clock",
  mustnt: "mustn't", neednt: "needn't", itll: "it'll", thatll: "that'll",
};

const APOSTROPHE_RE = new RegExp(`(?<![\\p{L}\\p{N}'’-])(${Object.keys(MISSING_APOSTROPHE).join('|')})(?![\\p{L}\\p{N}'’-])`, 'dgiu');

/** Languages, nationalities, days, and months that are always capitalized. */
const PROPER_WORDS = [
  'french', 'german', 'spanish', 'italian', 'chinese', 'japanese', 'korean', 'russian', 'arabic', 'hindi',
  'portuguese', 'dutch', 'greek', 'swedish', 'norwegian', 'finnish', 'irish', 'scottish', 'british',
  'american', 'canadian', 'mexican', 'brazilian', 'african', 'european', 'asian', 'australian', 'indian',
  'vietnamese', 'thai', 'turkish', 'hebrew', 'english', 'christian', 'muslim', 'jewish', 'buddhist', 'hindu',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
  'april', 'june', 'july', 'september', 'october', 'november', 'december',
];

const PROPER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}'’-])(${PROPER_WORDS.join('|')})(?![\\p{L}\\p{N}'’-])(?! (?:fries|fry|toast|press|kiss|doors?|horn|dressing|braid|cuffs?|drain|bread|vanilla|numerals?|oven|courage|treat|auction|muffins?))`,
  'dgu',
);

export function grammarRules(ctx: RuleContext, out: RawIssue[]): void {
  // Match against the copy with straight quotes so curly apostrophes behave the same.
  const text = ctx.norm;

  for (const rule of RULES) {
    scan(text, rule.re, (m) => {
      const hit = rule.match(m, ctx);
      if (!hit) return;
      push(ctx, out, {
        from: hit.from,
        to: hit.to,
        ruleId: rule.id,
        category: 'correctness',
        type: rule.type ?? 'grammar',
        title: hit.title ?? rule.title,
        message: hit.message,
        fixes: replacements(ctx, hit.from, hit.to, hit.options),
        priority: PRIORITY,
      });
    });
  }

  scan(text, APOSTROPHE_RE, (m) => {
    const word = m[1];
    const lower = word.toLowerCase();
    // "wont" and "cant" are rare real words; "as is his wont" stays.
    if (lower === 'wont' && /^(?:his|her|their|my|our|your|its)$/.test(previousWord(text, m.index))) return;
    // All-caps tokens are more likely acronyms (IM, IVE).
    if (word.length <= 3 && word === word.toUpperCase()) return;
    const from = m.index;
    const to = from + word.length;
    const target = MISSING_APOSTROPHE[lower];
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/missing-apostrophe',
      category: 'correctness',
      type: 'punctuation',
      title: 'Add an apostrophe',
      message: `The contraction “${target}” needs an apostrophe.`,
      fixes: replacements(ctx, from, to, [target]),
      priority: PRIORITY,
    });
  });

  scan(text, PROPER_RE, (m) => {
    const from = m.index;
    const to = from + m[1].length;
    const proper = m[1][0].toUpperCase() + m[1].slice(1);
    push(ctx, out, {
      from,
      to,
      ruleId: 'ws/capitalize-proper',
      category: 'correctness',
      type: 'spelling',
      title: 'Capitalize the word',
      message: `“${proper}” is a proper noun or adjective, so it starts with a capital letter.`,
      fixes: [{ from, to, text: proper, label: proper }],
      priority: PRIORITY,
    });
  });
}
