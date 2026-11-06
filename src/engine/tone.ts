/**
 * Tone detection. A lexicon-and-signals heuristic: each tone has a vocabulary,
 * and surface features (contractions, punctuation, capitals, numbers) nudge the
 * scores. It runs offline and instantly; it is a guide, not a verdict.
 */
import { escapeRegExp } from './text';
import type { ToneScore } from './types';

interface ToneDefinition {
  id: string;
  label: string;
  emoji: string;
  terms: string[];
  weight?: number;
}

const TONES: ToneDefinition[] = [
  {
    id: 'formal',
    label: 'Formal',
    emoji: '👔',
    terms: [
      'therefore', 'furthermore', 'moreover', 'consequently', 'regarding', 'pursuant', 'hereby', 'accordingly',
      'sincerely', 'respectfully', 'kindly', 'shall', 'thus', 'hence', 'whereas', 'notwithstanding',
      'in accordance with', 'with regard to', 'please be advised', 'at your earliest convenience', 'dear sir',
      'dear madam', 'to whom it may concern', 'yours faithfully', 'yours sincerely', 'best regards',
      'kind regards', 'in addition', 'however', 'nevertheless',
    ],
  },
  {
    id: 'casual',
    label: 'Casual',
    emoji: '😎',
    terms: [
      'gonna', 'wanna', 'gotta', 'kinda', 'yeah', 'yep', 'nope', 'hey', 'hi there', 'cool', 'awesome', 'stuff',
      'guys', 'lol', 'haha', 'btw', 'omg', 'super', 'totally', 'ok', 'okay', 'yay', 'wow', 'oops', 'dude',
      'folks', 'cheers', 'a bunch of', 'no worries', 'by the way',
    ],
  },
  {
    id: 'confident',
    label: 'Confident',
    emoji: '💪',
    terms: [
      'definitely', 'certainly', 'clearly', 'undoubtedly', 'absolutely', 'guarantee', 'guaranteed', 'proven',
      'without a doubt', 'no doubt', "i am sure", "i'm sure", 'i am certain', "i'm certain", 'i am confident',
      "i'm confident", 'we are confident', 'i know', 'we know', 'we will', 'i will', 'the best', 'ready to',
    ],
  },
  {
    id: 'tentative',
    label: 'Tentative',
    emoji: '🤔',
    terms: [
      'maybe', 'perhaps', 'might', 'possibly', 'probably', 'i think', 'i guess', 'i suppose', 'i feel like',
      'sort of', 'kind of', 'not sure', 'could be', 'seems', 'seem', 'apparently', 'somewhat', 'i wonder',
      'unsure', 'potentially', 'if possible', 'i was wondering',
    ],
  },
  {
    id: 'friendly',
    label: 'Friendly',
    emoji: '😊',
    terms: [
      'thanks', 'thank you', 'hi', 'hello', 'hope you', 'glad', 'happy to', 'feel free', 'welcome', 'great to',
      'looking forward', 'warm regards', 'take care', 'have a great', 'have a nice', 'lovely', 'pleasure',
      'friend', 'friends', 'let me know', 'happy to help',
    ],
  },
  {
    id: 'appreciative',
    label: 'Appreciative',
    emoji: '🙏',
    terms: [
      'thank you', 'thanks', 'appreciate', 'appreciated', 'grateful', 'gratitude', 'thankful', 'means a lot',
      'kudos', 'well done', 'great job', 'great work',
    ],
    weight: 1.2,
  },
  {
    id: 'joyful',
    label: 'Joyful',
    emoji: '🎉',
    terms: [
      'excited', 'thrilled', 'amazing', 'wonderful', 'fantastic', 'love', 'loved', 'delighted', "can't wait",
      'happy', 'joy', 'congratulations', 'congrats', 'celebrate', 'great news', 'incredible', 'brilliant',
      'overjoyed', 'ecstatic', 'awesome',
    ],
  },
  {
    id: 'optimistic',
    label: 'Optimistic',
    emoji: '🌤️',
    terms: [
      'hope', 'hopeful', 'hopefully', 'looking forward', 'optimistic', 'promising', 'opportunity',
      'opportunities', 'bright', 'confident that', 'progress', 'improving',
    ],
  },
  {
    id: 'worried',
    label: 'Worried',
    emoji: '😟',
    terms: [
      'worried', 'worry', 'concerned', 'concern', 'concerns', 'afraid', 'anxious', 'nervous', 'unfortunately',
      'risk', 'risks', 'fear', 'trouble', 'uncertain', 'uneasy', 'alarming', 'doubt', 'doubts',
    ],
  },
  {
    id: 'angry',
    label: 'Frustrated',
    emoji: '😠',
    terms: [
      'unacceptable', 'ridiculous', 'furious', 'outraged', 'outrageous', 'terrible', 'awful', 'disgusted',
      'disgusting', 'fed up', 'sick of', 'hate', 'never again', 'appalled', 'appalling', 'angry', 'annoyed',
      'frustrating', 'frustrated', 'worst', 'useless', 'incompetent', 'how dare', 'i demand',
    ],
    weight: 1.3,
  },
  {
    id: 'sad',
    label: 'Sad',
    emoji: '😢',
    terms: [
      'sad', 'sorry to hear', 'miss you', 'disappointed', 'disappointing', 'heartbroken', 'loss', 'grief',
      'tragic', 'lonely', 'unhappy', 'depressed', 'condolences', 'sadly',
    ],
  },
  {
    id: 'apologetic',
    label: 'Apologetic',
    emoji: '🙇',
    terms: [
      'sorry', 'apologize', 'apologies', 'apologise', 'my fault', 'my mistake', 'forgive', 'regret', 'pardon',
      'excuse me', 'i was wrong',
    ],
    weight: 1.2,
  },
  {
    id: 'urgent',
    label: 'Urgent',
    emoji: '⏰',
    terms: [
      'urgent', 'urgently', 'immediately', 'asap', 'as soon as possible', 'right away', 'deadline', 'critical',
      'time-sensitive', 'at once', 'hurry', 'emergency', 'without delay', 'by end of day', 'overdue',
    ],
    weight: 1.3,
  },
  {
    id: 'direct',
    label: 'Direct',
    emoji: '🎯',
    terms: [
      'do not', "don't", 'make sure', 'ensure', 'must', 'need to', 'required', 'have to', 'please send',
      'please provide', 'please confirm', 'please complete',
    ],
    weight: 0.8,
  },
  {
    id: 'curious',
    label: 'Curious',
    emoji: '❓',
    terms: ['wonder', 'wondering', 'curious', 'how come', 'what if', 'interested in', 'tell me more'],
  },
  {
    id: 'informative',
    label: 'Informative',
    emoji: '📊',
    terms: [
      'because', 'data', 'results', 'analysis', 'according to', 'shows', 'indicates', 'percent', 'research',
      'study', 'studies', 'evidence', 'findings', 'report', 'statistics', 'average', 'compared', 'increase',
      'decrease', 'for example', 'such as',
    ],
    weight: 0.7,
  },
];

const COMPILED = TONES.map((tone) => ({
  ...tone,
  re: new RegExp(
    `(?<![\\p{L}\\p{N}'’])(?:${tone.terms
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((t) => escapeRegExp(t).replace(/'/g, "['’]").replace(/ /g, '\\s+'))
      .join('|')})(?![\\p{L}\\p{N}])`,
    'giu',
  ),
}));

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/** Minimum text before a tone reading means anything. */
export const MIN_TONE_WORDS = 20;

export function detectTones(text: string, words: number, sentences: number): ToneScore[] {
  if (words < MIN_TONE_WORDS) return [];
  const per100 = (n: number) => (n / words) * 100;
  const scores = new Map<string, number>();
  const add = (id: string, value: number) => scores.set(id, (scores.get(id) ?? 0) + value);

  for (const tone of COMPILED) {
    add(tone.id, per100(count(text, tone.re)) * (tone.weight ?? 1));
  }

  const perSentence = (n: number) => n / Math.max(1, sentences);
  const contractions = count(text, /\p{L}+['’](?:t|s|re|ve|ll|d|m)(?![\p{L}])/giu);
  const exclamations = count(text, /!/g);
  const questions = count(text, /\?/g);
  const shouted = count(text, /(?<![\p{L}])\p{Lu}{4,}(?![\p{L}])/gu);
  const numbers = count(text, /\d+(?:[.,]\d+)*%?/g);
  const letters = count(text, /\p{L}/gu);
  const averageWordLength = letters / words;

  add('casual', per100(contractions) * 0.35);
  add('joyful', perSentence(exclamations) * 2.2);
  add('curious', perSentence(questions) * 3.5);
  add('angry', per100(shouted) * 1.5 + (/!{2,}/.test(text) ? 1 : 0));
  add('informative', per100(numbers) * 0.6);
  if (contractions === 0 && averageWordLength > 4.9 && words >= 40) add('formal', 1.3);

  // Opposites: keep the stronger of each pair.
  const formal = scores.get('formal') ?? 0;
  const casual = scores.get('casual') ?? 0;
  if (formal > casual) scores.set('casual', 0);
  else scores.set('formal', 0);

  const ranked = COMPILED.map((tone) => ({ tone, score: scores.get(tone.id) ?? 0 }))
    .filter((r) => r.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (ranked.length === 0) {
    return [{ id: 'neutral', label: 'Neutral', emoji: '😐', strength: 1, score: 0 }];
  }
  return ranked.map(({ tone, score }) => ({
    id: tone.id,
    label: tone.label,
    emoji: tone.emoji,
    strength: score >= 3.5 ? 3 : score >= 2 ? 2 : 1,
    score: Math.round(score * 10) / 10,
  }));
}
