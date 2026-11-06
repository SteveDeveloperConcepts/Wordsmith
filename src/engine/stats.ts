/**
 * Document statistics: counts, timing estimates, vocabulary, and readability.
 */
import { COMMON_WORDS } from './data/common-words';
import { countCodePoints, countSyllables, splitSentences, tokenize } from './text';
import {
  READING_WPM,
  SPEAKING_WPM,
  WORDS_PER_PAGE,
  type Block,
  type Readability,
  type TextStats,
} from './types';

export interface DocumentStats {
  stats: TextStats;
  readability: Readability;
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Is this word outside everyday vocabulary? Names, numbers, and contractions never count. */
function isRare(word: string, capitalizedMidSentence: boolean): boolean {
  if (capitalizedMidSentence) return false;
  if (/[\d'’.]/.test(word)) return false;
  const lower = word.toLowerCase();
  for (const part of lower.split('-')) {
    if (part.length <= 2) continue;
    if (COMMON_WORDS.has(part)) continue;
    // Regular inflections of a common word are still common.
    const stems = [
      part.replace(/(?:ies)$/, 'y'),
      part.replace(/(?:es|s)$/, ''),
      part.replace(/(?:ed|ing)$/, ''),
      part.replace(/(?:ed|ing)$/, 'e'),
      part.replace(/(.)\1(?:ed|ing)$/, '$1'),
      part.replace(/ly$/, ''),
      part.replace(/ily$/, 'y'),
      part.replace(/(?:er|est)$/, ''),
      part.replace(/(?:er|est)$/, 'e'),
      part.replace(/(?:ier|iest)$/, 'y'),
    ];
    if (stems.some((s) => s !== part && s.length > 2 && COMMON_WORDS.has(s))) continue;
    return true;
  }
  return false;
}

const READABILITY_BANDS: Array<[min: number, label: string, description: string]> = [
  [90, 'Very easy', 'Easily understood by an average 11-year-old.'],
  [80, 'Easy', 'Conversational English; easy for most readers.'],
  [70, 'Fairly easy', 'Easily understood by 13-year-olds and up.'],
  [60, 'Plain English', 'Easily understood by most readers aged 13 to 15.'],
  [50, 'Fairly difficult', 'Best understood by readers with some high school education.'],
  [30, 'Difficult', 'Best understood by readers with a college education.'],
  [0, 'Very difficult', 'Best understood by university graduates.'],
];

export function computeStats(blocks: Block[]): DocumentStats {
  let characters = 0;
  let charactersNoSpaces = 0;
  let words = 0;
  let sentences = 0;
  let paragraphs = 0;
  let syllables = 0;
  let letters = 0;
  let longestSentenceWords = 0;
  let rare = 0;
  const unique = new Set<string>();

  for (const block of blocks) {
    const text = block.text;
    if (!text.trim()) continue;
    paragraphs++;
    characters += countCodePoints(text);
    charactersNoSpaces += countCodePoints(text.replace(/\s+/g, ''));
    if (block.kind === 'code') {
      words += tokenize(text).length;
      continue;
    }

    const blockSentences = splitSentences(text);
    sentences += blockSentences.length;
    const starts = new Set(blockSentences.map((s) => s.firstWord));
    for (const s of blockSentences) if (s.words > longestSentenceWords) longestSentenceWords = s.words;

    for (const token of tokenize(text)) {
      words++;
      const lower = token.text.toLowerCase();
      unique.add(lower);
      syllables += countSyllables(token.text);
      letters += token.text.replace(/[^\p{L}\p{N}]/gu, '').length;
      const capitalized = /^\p{Lu}/u.test(token.text) && !starts.has(token.from);
      if (isRare(token.text, capitalized)) rare++;
    }
  }

  const stats: TextStats = {
    characters,
    charactersNoSpaces,
    words,
    sentences,
    paragraphs,
    readingTimeSec: Math.round((words / READING_WPM) * 60),
    speakingTimeSec: Math.round((words / SPEAKING_WPM) * 60),
    pages: round(words / WORDS_PER_PAGE, 1),
    avgWordLength: words ? round(letters / words) : 0,
    avgSentenceLength: sentences ? round(words / sentences) : 0,
    longestSentenceWords,
    syllables,
    uniqueWords: unique.size,
    uniqueWordsPct: words ? Math.round((unique.size / words) * 100) : 0,
    rareWordsPct: words ? Math.round((rare / words) * 100) : 0,
  };

  let readability: Readability = {
    fleschReadingEase: null,
    gradeLevel: null,
    label: 'Not enough text',
    description: 'Write a few sentences to see a readability score.',
  };
  if (words >= 15 && sentences >= 1) {
    const wordsPerSentence = words / sentences;
    const syllablesPerWord = syllables / words;
    const ease = 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
    const grade = 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59;
    const clamped = Math.max(0, Math.min(100, Math.round(ease)));
    const band = READABILITY_BANDS.find(([min]) => clamped >= min) ?? READABILITY_BANDS[READABILITY_BANDS.length - 1];
    readability = {
      fleschReadingEase: clamped,
      gradeLevel: Math.max(0, round(grade)),
      label: band[1],
      description: band[2],
    };
  }

  return { stats, readability };
}
