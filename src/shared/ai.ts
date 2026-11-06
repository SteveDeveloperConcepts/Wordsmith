/**
 * The optional AI features (rewrite, compose, reader reactions, deep proofread),
 * implemented with the Claude API. Platform-neutral: the desktop app runs this in
 * the main process, the browser build runs it in the page.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { DIALECT_LABEL, type Dialect, type Goals } from '@engine/types';
import { AI_MODELS, AiError, MAX_AI_CHARACTERS, type AiRequest, type AiResult } from './ai-types';

/**
 * Lets the API retry a request on another model if a safety classifier declines
 * it, so a false positive does not become a dead end for the writer.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Generous ceiling for streamed output; only what is generated is billed. */
const MAX_OUTPUT_TOKENS = 64_000;

const ProofreadSchema = z.object({
  suggestions: z.array(
    z.object({
      paragraph: z.number().int().describe('Index of the paragraph containing the issue'),
      quote: z
        .string()
        .describe('The exact text to replace, copied character for character from that paragraph, as short as possible'),
      replacement: z.string().describe('The text that should replace the quote'),
      category: z.enum(['correctness', 'clarity', 'engagement', 'delivery']),
      title: z.string().describe('Short imperative headline, e.g. "Fix the verb tense"'),
      explanation: z.string().describe('One or two plain sentences explaining why'),
    }),
  ),
});

const AUDIENCE: Record<Goals['audience'], string> = {
  general: 'a general audience with no special background',
  knowledgeable: 'readers who know the subject reasonably well',
  expert: 'expert readers who expect precise, technical language',
};
const DOMAIN: Record<Goals['domain'], string> = {
  general: 'general-purpose writing',
  academic: 'academic writing',
  business: 'business writing',
  email: 'an email',
  casual: 'casual, personal writing',
  creative: 'creative writing',
};
const INTENT: Record<Goals['intent'], string> = {
  inform: 'inform',
  describe: 'describe',
  convince: 'convince',
  'tell-story': 'tell a story',
};

function describeWriting(goals: Goals, dialect: Dialect): string {
  return [
    `The document is ${DOMAIN[goals.domain]} for ${AUDIENCE[goals.audience]}.`,
    `Its formality is ${goals.formality}, and its purpose is to ${INTENT[goals.intent]}.`,
    `Follow ${DIALECT_LABEL[dialect]} spelling and punctuation conventions unless the text is in another language.`,
  ].join(' ');
}

interface Prompt {
  system: string;
  user: string;
  effort: 'low' | 'medium';
}

function buildPrompt(request: AiRequest): Prompt {
  switch (request.kind) {
    case 'rewrite':
      return {
        effort: 'low',
        system: [
          'You are the rewriting engine inside Wordsmith, a desktop writing assistant. The writer selected a passage in their document and asked for a specific change.',
          'Your reply replaces the selection directly in their document, so reply with the rewritten passage only: no introduction, no surrounding quotation marks, and no notes about what you changed.',
          'Keep the writer’s meaning, facts, names, and numbers; change only what the instruction calls for. Keep the passage in its original language unless the instruction asks for a translation, and keep its paragraph breaks unless the instruction calls for a different shape. If the passage already satisfies the instruction, return it unchanged.',
          describeWriting(request.goals, request.dialect),
        ].join('\n\n'),
        user: [
          `<instruction>\n${request.instruction}\n</instruction>`,
          request.context
            ? `<surrounding_text>\nFor reference only, so the rewrite fits its surroundings. Do not rewrite or repeat it.\n${request.context}\n</surrounding_text>`
            : '',
          `<passage>\n${request.text}\n</passage>`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };

    case 'compose':
      return {
        effort: 'low',
        system: [
          'You are the drafting engine inside Wordsmith, a desktop writing assistant. The writer describes what they want written, and your reply is inserted directly into their document at the cursor.',
          'Reply with the text itself only: no preamble, no closing remarks, and no offers of further help. Write plain paragraphs separated by blank lines. Use Markdown headings or bullet lists only when the request calls for that structure.',
          'Where the request needs specifics you do not have (names, dates, figures), leave a short bracketed placeholder such as [date] instead of inventing them.',
          describeWriting(request.goals, request.dialect),
        ].join('\n\n'),
        user: [
          request.document
            ? `<document_so_far>\nFor reference, so the new text matches the voice and does not repeat what is already there.\n${request.document}\n</document_so_far>`
            : '',
          `<request>\n${request.prompt}\n</request>`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };

    case 'reader':
      return {
        effort: 'low',
        system: [
          'You are a perceptive first reader inside Wordsmith, a desktop writing assistant. The writer wants to know how a particular reader is likely to receive their document before they send it.',
          'Respond in the voice of an honest, constructive editor, in four to six short bullet points that each start with "- ": what lands well, what may confuse or put off this reader, the overall impression the document leaves, and the one or two changes most worth making. Quote short phrases from the document when you point at something, so the writer can find it. Plain text only; no headings.',
        ].join('\n\n'),
        user: `<reader>\n${request.reader}\n</reader>\n\n<document>\n${request.document}\n</document>`,
      };

    case 'proofread':
      return {
        effort: 'medium',
        system: [
          'You are the deep-proofreading engine inside Wordsmith, a desktop writing assistant. A fast rule-based checker has already handled basic spelling and punctuation. Your job is the careful read a human editor would give: mistakes that need context to spot (a wrong word, agreement across clauses, tense shifts, missing words, misplaced modifiers, unclear pronouns), and clear wins for clarity, word choice, or tone.',
          'Each suggestion is applied by finding `quote` in the numbered paragraph and replacing it with `replacement`, so `quote` must be copied exactly from that paragraph, including capitalization and punctuation, and should be as short as it can be while appearing only once there. Do not combine separate problems into one suggestion.',
          'Categories: "correctness" for grammar, spelling, and punctuation errors; "clarity" for wordy or hard-to-follow phrasing; "engagement" for flat or repetitive word choice; "delivery" for tone, formality, and how the text will land.',
          'Suggest only changes you are confident improve the text while respecting the writer’s voice. Clean writing deserves an empty list.',
          describeWriting(request.goals, request.dialect),
        ].join('\n\n'),
        user: request.paragraphs.map((p, i) => `<paragraph index="${i}">\n${p}\n</paragraph>`).join('\n'),
      };
  }
}

function requestSize(request: AiRequest): number {
  switch (request.kind) {
    case 'rewrite':
      return request.text.length + (request.context?.length ?? 0);
    case 'compose':
      return request.prompt.length + (request.document?.length ?? 0);
    case 'reader':
      return request.document.length;
    case 'proofread':
      return request.paragraphs.reduce((n, p) => n + p.length, 0);
  }
}

/** Translate SDK errors into the small set of cases the UI explains to the writer. */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new AiError('cancelled', 'Cancelled.');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiError('auth', 'The API key was rejected. Check the key in Settings.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AiError('rate-limit', 'The AI service is rate-limiting requests right now. Wait a moment and try again.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AiError('bad-request', `The AI service rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new AiError('overloaded', 'The AI service is having trouble right now. Try again in a moment.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiError('network', 'Could not reach the AI service. Check your internet connection.');
  }
  if (err instanceof Anthropic.APIError) {
    return new AiError('unknown', `The AI service returned an error (${err.status ?? 'unknown'}): ${err.message}`);
  }
  return new AiError('unknown', err instanceof Error ? err.message : String(err));
}

/**
 * Run one AI request. Text results stream through `onText` as they are generated;
 * the returned promise resolves with the complete result.
 */
export async function runAi(
  client: Anthropic,
  model: string,
  request: AiRequest,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<AiResult> {
  if (requestSize(request) > MAX_AI_CHARACTERS) {
    throw new AiError('too-long', 'This is too much text for one request. Select a smaller section and try again.');
  }

  const prompt = buildPrompt(request);
  const fallback = AI_MODELS.find((m) => m.id === model)?.serverSideFallback ?? false;
  const base = {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user' as const, content: prompt.user }],
    ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };

  try {
    if (request.kind === 'proofread') {
      // Only the schema goes to the API. Given the parser too, the SDK reads each text block
      // as it ends, and throws a raw JSON error for a reply that was cut off or refused, or
      // that a fallback to another model split in two.
      const { parse, ...format } = betaZodOutputFormat(ProofreadSchema);
      const stream = client.beta.messages.stream({ ...base, output_config: { effort: prompt.effort, format } }, { signal });
      const message = await stream.finalMessage();
      checkStop(message.stop_reason);
      const parsed = readReply(() => parse(replyText(message.content)));
      const count = request.paragraphs.length;
      return {
        kind: 'proofread',
        suggestions: parsed.suggestions.filter(
          (s) => s.paragraph >= 0 && s.paragraph < count && s.quote.length > 0 && s.quote !== s.replacement,
        ),
      };
    }

    const stream = client.beta.messages.stream({ ...base, output_config: { effort: prompt.effort } }, { signal });
    stream.on('text', (delta) => onText(delta));
    const message = await stream.finalMessage();
    checkStop(message.stop_reason);
    return { kind: 'text', text: replyText(message.content).trim() };
  } catch (err) {
    throw toAiError(err);
  }
}

/** Everything the model wrote. A fallback to another model leaves a reply in several text blocks. */
function replyText(content: Array<{ type: string; text?: string }>): string {
  return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function readReply<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new AiError('unknown', 'The AI reply could not be read. Try again.');
  }
}

function checkStop(reason: string | null): void {
  if (reason === 'refusal') {
    throw new AiError('declined', 'The AI model declined this request. Try rephrasing it or selecting different text.');
  }
  if (reason === 'max_tokens') {
    throw new AiError('truncated', 'The reply was cut off because it was too long. Try a smaller section.');
  }
}

export function createClient(apiKey: string, inBrowser = false): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: inBrowser });
}
