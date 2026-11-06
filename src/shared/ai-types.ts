/**
 * Types and catalog data for the optional AI features. Nothing here imports the
 * Claude SDK, so the UI can use these without pulling the SDK into its bundle.
 */
import type { Category, Dialect, Goals } from '@engine/types';

export interface AiModel {
  id: string;
  label: string;
  note: string;
  /** Whether the API can retry a declined request on another model server-side. */
  serverSideFallback: boolean;
}

/** Models offered in Settings. The first entry is the default. */
export const AI_MODELS: AiModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable; recommended', serverSideFallback: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster and lower cost', serverSideFallback: true },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fastest and cheapest', serverSideFallback: false },
];

export const DEFAULT_AI_MODEL = AI_MODELS[0].id;

interface WritingContext {
  goals: Goals;
  dialect: Dialect;
}

export type AiRequest =
  | ({
      kind: 'rewrite';
      /** The passage to rewrite. */
      text: string;
      instruction: string;
      /** The surrounding paragraph(s), for reference only. */
      context?: string;
    } & WritingContext)
  | ({
      kind: 'compose';
      prompt: string;
      /** The document so far, so new text fits what is already there. */
      document?: string;
    } & WritingContext)
  | {
      kind: 'reader';
      /** Who is reading, e.g. "a busy executive". */
      reader: string;
      document: string;
    }
  | ({
      kind: 'proofread';
      /** The document's paragraphs, in order. */
      paragraphs: string[];
    } & WritingContext);

export interface AiSuggestion {
  /** Index into the request's `paragraphs`. */
  paragraph: number;
  /** Exact text to replace, copied from the paragraph. */
  quote: string;
  replacement: string;
  category: Category;
  title: string;
  explanation: string;
}

export type AiResult = { kind: 'text'; text: string } | { kind: 'proofread'; suggestions: AiSuggestion[] };

export type AiErrorCode =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'overloaded'
  | 'network'
  | 'declined'
  | 'truncated'
  | 'too-long'
  | 'bad-request'
  | 'cancelled'
  | 'unknown';

export interface AiErrorInfo {
  code: AiErrorCode;
  message: string;
}

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }

  toInfo(): AiErrorInfo {
    return { code: this.code, message: this.message };
  }
}

export interface RewritePreset {
  id: string;
  label: string;
  instruction: string;
}

export const REWRITE_PRESETS: RewritePreset[] = [
  {
    id: 'improve',
    label: 'Improve it',
    instruction:
      'Improve the clarity, flow, and word choice of this passage, and fix any grammar, spelling, or punctuation errors. Keep the meaning, the level of detail, and the author’s voice.',
  },
  {
    id: 'fix',
    label: 'Fix mistakes only',
    instruction:
      'Correct grammar, spelling, and punctuation errors only. Leave everything that is already correct exactly as it is.',
  },
  {
    id: 'shorten',
    label: 'Shorten it',
    instruction: 'Make this passage noticeably shorter and tighter. Cut redundancy and filler, and keep every essential point.',
  },
  {
    id: 'simplify',
    label: 'Simplify it',
    instruction:
      'Rewrite this passage in plain language that a general reader can follow easily, with shorter sentences and everyday words.',
  },
  {
    id: 'expand',
    label: 'Add detail',
    instruction:
      'Expand this passage with fuller explanation and smoother transitions. Work only with what is already there: do not invent facts, names, numbers, or quotations.',
  },
  {
    id: 'formal',
    label: 'More formal',
    instruction: 'Rewrite this passage in a polished, professional register suitable for formal business or academic writing.',
  },
  {
    id: 'friendly',
    label: 'Friendlier',
    instruction: 'Rewrite this passage so it sounds warm, friendly, and approachable while staying clear and respectful.',
  },
  {
    id: 'confident',
    label: 'More confident',
    instruction:
      'Rewrite this passage so it sounds confident and direct. Remove hedging and apologies, and state points plainly without becoming harsh.',
  },
  {
    id: 'persuasive',
    label: 'More persuasive',
    instruction:
      'Rewrite this passage to be more persuasive: lead with the strongest point, make the benefit to the reader concrete, and end with a clear ask.',
  },
];

export const READER_PERSONAS = [
  'a busy executive',
  'a new customer',
  'a hiring manager',
  'a professor grading this',
  'a teammate',
  'a skeptical reader',
];

/** Rough upper bound on the text sent in one request; beyond it the user is asked to narrow the selection. */
export const MAX_AI_CHARACTERS = 400_000;
