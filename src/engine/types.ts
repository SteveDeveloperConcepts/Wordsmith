/**
 * Shared types for the Wordsmith analysis engine.
 *
 * The engine is plain TypeScript with no DOM or Node dependencies, so it runs
 * unchanged in a web worker (the app), in Node (unit tests), or on the main thread.
 */

export type Category = 'correctness' | 'clarity' | 'engagement' | 'delivery';

export type IssueType =
  | 'spelling'
  | 'grammar'
  | 'punctuation'
  | 'sentence'
  | 'conciseness'
  | 'word-choice'
  | 'tone'
  | 'formality'
  | 'inclusive';

export const CATEGORIES: Category[] = ['correctness', 'clarity', 'engagement', 'delivery'];

export const ISSUE_TYPES: IssueType[] = [
  'spelling',
  'grammar',
  'punctuation',
  'sentence',
  'conciseness',
  'word-choice',
  'tone',
  'formality',
  'inclusive',
];

export const CATEGORY_LABEL: Record<Category, string> = {
  correctness: 'Correctness',
  clarity: 'Clarity',
  engagement: 'Engagement',
  delivery: 'Delivery',
};

export const CATEGORY_HINT: Record<Category, string> = {
  correctness: 'Spelling, grammar, and punctuation',
  clarity: 'Concise, easy-to-follow sentences',
  engagement: 'Vivid, varied word choice',
  delivery: 'Tone, formality, and inclusive language',
};

export const TYPE_LABEL: Record<IssueType, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  sentence: 'Sentences',
  conciseness: 'Conciseness',
  'word-choice': 'Word choice',
  tone: 'Tone',
  formality: 'Formality',
  inclusive: 'Inclusive language',
};

export type BlockKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'code';

/** One block of the document (a paragraph, heading, list item…). Offsets are UTF-16 within `text`. */
export interface Block {
  text: string;
  kind: BlockKind;
}

/** A concrete edit that resolves an issue. Offsets are block-relative and may extend past the issue range. */
export interface Fix {
  /** Text shown on the button, e.g. the replacement word or "Remove". */
  label: string;
  from: number;
  to: number;
  text: string;
}

export interface Issue {
  /** Stable while the surrounding sentence is unchanged — used for dismissals and UI state. */
  id: string;
  block: number;
  from: number;
  to: number;
  category: Category;
  type: IssueType;
  ruleId: string;
  /** Short imperative headline, e.g. "Correct your spelling". */
  title: string;
  /** Plain-language explanation. */
  message: string;
  /** The flagged text. */
  text: string;
  fixes: Fix[];
  /** True when the issue covers a whole sentence rather than a word or phrase. */
  sentenceLevel: boolean;
  /** Block-relative range of the enclosing sentence (used for AI rewrites). */
  sentence: { from: number; to: number };
  /** Instruction for an AI rewrite when no mechanical fix exists. */
  rewriteHint?: string;
  /** For spelling issues: the word that could be added to the personal dictionary. */
  word?: string;
}

export type Dialect = 'american' | 'british' | 'canadian' | 'australian' | 'indian';

export const DIALECT_LABEL: Record<Dialect, string> = {
  american: 'American English',
  british: 'British English',
  canadian: 'Canadian English',
  australian: 'Australian English',
  indian: 'Indian English',
};

export interface Goals {
  audience: 'general' | 'knowledgeable' | 'expert';
  formality: 'informal' | 'neutral' | 'formal';
  domain: 'general' | 'academic' | 'business' | 'email' | 'casual' | 'creative';
  intent: 'inform' | 'describe' | 'convince' | 'tell-story';
}

export const DEFAULT_GOALS: Goals = {
  audience: 'knowledgeable',
  formality: 'neutral',
  domain: 'general',
  intent: 'inform',
};

export interface EngineSettings {
  dialect: Dialect;
  goals: Goals;
  /** Per-category switches. */
  checks: Record<Category, boolean>;
  options: {
    passiveVoice: boolean;
    longSentences: boolean;
    inclusiveLanguage: boolean;
    oxfordComma: boolean;
  };
  /** Rule ids the user turned off. */
  disabledRules: string[];
  /** Personal dictionary. */
  dictionary: string[];
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  dialect: 'american',
  goals: DEFAULT_GOALS,
  checks: { correctness: true, clarity: true, engagement: true, delivery: true },
  options: { passiveVoice: true, longSentences: true, inclusiveLanguage: true, oxfordComma: true },
  disabledRules: [],
  dictionary: [],
};

export interface TextStats {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  sentences: number;
  paragraphs: number;
  /** Seconds, at READING_WPM words per minute. */
  readingTimeSec: number;
  /** Seconds, at SPEAKING_WPM words per minute. */
  speakingTimeSec: number;
  /** Single-spaced pages at ~500 words per page. */
  pages: number;
  avgWordLength: number;
  avgSentenceLength: number;
  longestSentenceWords: number;
  syllables: number;
  uniqueWords: number;
  /** Share of distinct words, 0–100. */
  uniqueWordsPct: number;
  /** Share of words outside everyday vocabulary, 0–100. */
  rareWordsPct: number;
}

export interface Readability {
  /** Flesch reading ease, 0–100. Null when there is too little text. */
  fleschReadingEase: number | null;
  /** Flesch–Kincaid U.S. school grade. */
  gradeLevel: number | null;
  label: string;
  description: string;
}

export interface ToneScore {
  id: string;
  label: string;
  emoji: string;
  /** 1 = a hint of it, 3 = strongly present. */
  strength: 1 | 2 | 3;
  score: number;
}

export interface AnalysisResult {
  issues: Issue[];
  stats: TextStats;
  readability: Readability;
  tones: ToneScore[];
  /** 0–100, or null when there is too little text to score. */
  score: number | null;
  counts: {
    total: number;
    byCategory: Record<Category, number>;
    byType: Record<IssueType, number>;
  };
  /** False when the grammar engine could not load and only the built-in rules ran. */
  grammarEngineReady: boolean;
  engineError?: string;
  elapsedMs: number;
}

export interface AnalyzeRequest {
  blocks: Block[];
  /** Issue ids the user dismissed in this document. */
  dismissed?: string[];
  /** Block the caret is in, so half-typed text is not flagged prematurely. */
  caretBlock?: number;
}

export const READING_WPM = 238;
export const SPEAKING_WPM = 150;
export const WORDS_PER_PAGE = 500;
