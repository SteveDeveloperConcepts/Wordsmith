import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GOALS } from '@engine/types';
import { runAi } from '@shared/ai';
import { AiError, MAX_AI_CHARACTERS, type AiErrorCode, type AiRequest, type AiSuggestion } from '@shared/ai-types';

/* A stand-in for the Claude API. The SDK talks to it exactly as it would to the real thing. */

interface Received {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  /** Whatever the code under test sent, which these tests look into freely. */
  body: any;
}

type Reply = (response: ServerResponse) => void;

let reply: Reply;
let received: Received[];
let client: Anthropic;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    reply(response);
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // No retries: a test of a 429 should see the 429, not wait out the SDK's backoff.
  client = new Anthropic({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
});

/* The Anthropic streaming format. */

const sseEvent = (data: { type: string; [key: string]: unknown }) =>
  `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

const start = (model = 'claude-opus-5-5') =>
  sseEvent({
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  }) + sseEvent({ type: 'ping' });

const textBlock = (index: number, pieces: string[]) =>
  [
    sseEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
    ...pieces.map((text) => sseEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
    sseEvent({ type: 'content_block_stop', index }),
  ].join('');

/** The start of a reply that is still arriving. */
const firstPiece = (text: string) =>
  start() +
  sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

const end = (stopReason: string) =>
  sseEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 8 } }) +
  sseEvent({ type: 'message_stop' });

const streamed = (...frames: string[]): Reply => (response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(frames.join(''));
};

const textReply = (pieces: string[], stopReason = 'end_turn') => streamed(start(), textBlock(0, pieces), end(stopReason));

const apiError = (status: number, type: string, message: string): Reply => (response) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'error', error: { type, message } }));
};

/* Requests. */

const writing = { goals: DEFAULT_GOALS, dialect: 'british' as const };

const rewrite: AiRequest = {
  kind: 'rewrite',
  text: 'The cat sat on teh mat.',
  instruction: 'Make it shorter.',
  context: 'Before it.\n\n[the passage]\n\nAfter it.',
  ...writing,
};
const compose: AiRequest = { kind: 'compose', prompt: 'A note to the team.', document: 'Dear all,', ...writing };
const reader: AiRequest = { kind: 'reader', reader: 'a busy executive', document: 'Our results improved.' };
const proofread: AiRequest = { kind: 'proofread', paragraphs: ['First paragraph.', 'Second paragraph.'], ...writing };

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

interface RunOptions {
  model?: string;
  onText?(delta: string): void;
  signal?: AbortSignal;
}

const run = (request: AiRequest, { model = OPUS, onText = () => undefined, signal }: RunOptions = {}) =>
  runAi(client, model, request, onText, signal);

async function failure(request: AiRequest, options?: RunOptions): Promise<AiError> {
  const error = await run(request, options).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(AiError);
  return error as AiError;
}

const sent = () => received[received.length - 1];

describe('what is sent', () => {
  beforeEach(() => {
    reply = textReply(['Done.']);
  });

  it('asks the chosen model for a stream', async () => {
    await run(rewrite, { model: SONNET });
    expect(sent().url).toBe('/v1/messages');
    expect(sent().body).toMatchObject({ model: SONNET, stream: true, max_tokens: 64_000 });
  });

  it.each([
    ['rewrite', rewrite, 'You are the rewriting engine inside Wordsmith', 'low'],
    ['compose', compose, 'You are the drafting engine inside Wordsmith', 'low'],
    ['reader', reader, 'You are a perceptive first reader inside Wordsmith', 'low'],
  ] as const)('gives a %s request its system text and effort', async (_kind, request, system, effort) => {
    await run(request);
    expect(sent().body.system).toContain(system);
    expect(sent().body.output_config).toEqual({ effort });
  });

  it('gives a proofread more effort, and a schema for the reply', async () => {
    reply = textReply([JSON.stringify({ suggestions: [] })]);
    await run(proofread);
    const { system, output_config: config } = sent().body;
    expect(system).toContain('You are the deep-proofreading engine inside Wordsmith');
    expect(config.effort).toBe('medium');
    expect(config.format.type).toBe('json_schema');
    expect(config.format.schema.properties.suggestions.type).toBe('array');
  });

  it('describes the writing to the model where its goals matter', async () => {
    await run(rewrite);
    expect(sent().body.system).toContain('British English');
    await run(reader);
    expect(sent().body.system).not.toContain('British English');
  });

  it('puts the passage, instruction, and surroundings in the user message', async () => {
    await run(rewrite);
    const [message] = sent().body.messages;
    expect(message.role).toBe('user');
    expect(message.content).toContain('<instruction>\nMake it shorter.\n</instruction>');
    expect(message.content).toContain('<passage>\nThe cat sat on teh mat.\n</passage>');
    expect(message.content).toContain('Before it.\n\n[the passage]\n\nAfter it.');
  });

  it('leaves out surroundings that do not exist', async () => {
    await run({ ...rewrite, context: undefined });
    expect(sent().body.messages[0].content).not.toContain('<surrounding_text>');
  });

  it('numbers the paragraphs to proofread', async () => {
    reply = textReply([JSON.stringify({ suggestions: [] })]);
    await run(proofread);
    const { content } = sent().body.messages[0];
    expect(content).toContain('<paragraph index="0">\nFirst paragraph.\n</paragraph>');
    expect(content).toContain('<paragraph index="1">\nSecond paragraph.\n</paragraph>');
  });

  it.each([OPUS, SONNET])('lets %s fall back to another model if it declines', async (model) => {
    await run(rewrite, { model });
    expect(sent().headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(sent().body.fallbacks).toBe('default');
    expect(sent().body).not.toHaveProperty('betas');
  });

  it.each([HAIKU, 'claude-from-an-older-version'])('asks for no fallback from %s', async (model) => {
    await run(rewrite, { model });
    expect(sent().headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
    expect(sent().body).not.toHaveProperty('fallbacks');
    expect(sent().body).not.toHaveProperty('betas');
  });

  it('asks for a fallback on a proofread too', async () => {
    reply = textReply([JSON.stringify({ suggestions: [] })]);
    await run(proofread);
    expect(sent().headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(sent().body.fallbacks).toBe('default');
  });

  it('refuses a request that is too large, without sending it', async () => {
    const error = await failure({ ...reader, document: 'x'.repeat(MAX_AI_CHARACTERS + 1) });
    expect(error.code).toBe('too-long');
    expect(received).toHaveLength(0);
  });

  it('counts the surroundings towards that limit', async () => {
    const error = await failure({ ...rewrite, text: 'x'.repeat(MAX_AI_CHARACTERS), context: 'more' });
    expect(error.code).toBe('too-long');
  });
});

describe('streamed text', () => {
  it('passes each piece on as it arrives, then the whole reply', async () => {
    reply = textReply(['Shorter ', 'and ', 'clearer.']);
    const pieces: string[] = [];
    const result = await run(rewrite, { onText: (delta) => pieces.push(delta) });
    expect(pieces).toEqual(['Shorter ', 'and ', 'clearer.']);
    expect(result).toEqual({ kind: 'text', text: 'Shorter and clearer.' });
  });

  it('delivers text before the reply has finished', async () => {
    let finish: () => void = () => undefined;
    reply = (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(firstPiece('Early'));
      finish = () => {
        response.end(
          sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' and late.' } }) +
            sseEvent({ type: 'content_block_stop', index: 0 }) +
            end('end_turn'),
        );
      };
    };
    const pieces: string[] = [];
    const result = await run(rewrite, {
      onText: (delta) => {
        pieces.push(delta);
        if (pieces.length === 1) finish();
      },
    });
    expect(pieces).toEqual(['Early', ' and late.']);
    expect(result).toEqual({ kind: 'text', text: 'Early and late.' });
  });

  it('trims the white space around a reply', async () => {
    reply = textReply(['\n\n  Tidy.  \n']);
    expect(await run(compose)).toEqual({ kind: 'text', text: 'Tidy.' });
  });

  it('keeps the model’s thinking out of the text', async () => {
    reply = streamed(
      start(),
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm.' } }),
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
      sseEvent({ type: 'content_block_stop', index: 0 }),
      textBlock(1, ['The answer.']),
      end('end_turn'),
    );
    const pieces: string[] = [];
    const result = await run(compose, { onText: (delta) => pieces.push(delta) });
    expect(pieces).toEqual(['The answer.']);
    expect(result).toEqual({ kind: 'text', text: 'The answer.' });
  });

  it('carries a reply across a fallback to another model', async () => {
    const handover = { type: 'fallback', from: { model: OPUS }, to: { model: 'claude-opus-4-8' } };
    reply = streamed(
      start(),
      textBlock(0, ['Begun by one model, ']),
      sseEvent({ type: 'content_block_start', index: 1, content_block: handover }),
      sseEvent({ type: 'content_block_stop', index: 1 }),
      textBlock(2, ['finished by another.']),
      end('end_turn'),
    );
    expect(await run(rewrite)).toEqual({ kind: 'text', text: 'Begun by one model, finished by another.' });
  });
});

describe('a reply that stops early', () => {
  it('says the model declined', async () => {
    reply = textReply([], 'refusal');
    const error = await failure(rewrite);
    expect(error.code).toBe('declined');
    expect(error.message).toBe('The AI model declined this request. Try rephrasing it or selecting different text.');
  });

  it('says the model declined even after some text', async () => {
    reply = textReply(['Well, '], 'refusal');
    expect((await failure(compose)).code).toBe('declined');
  });

  it('says the reply was cut off', async () => {
    reply = textReply(['This goes on and'], 'max_tokens');
    const error = await failure(compose);
    expect(error.code).toBe('truncated');
    expect(error.message).toBe('The reply was cut off because it was too long. Try a smaller section.');
  });

  it('says a proofread was declined', async () => {
    reply = streamed(start(), end('refusal'));
    expect((await failure(proofread)).code).toBe('declined');
  });
});

describe('errors from the service', () => {
  it.each<[number, string, AiErrorCode]>([
    [401, 'authentication_error', 'auth'],
    [403, 'permission_error', 'auth'],
    [429, 'rate_limit_error', 'rate-limit'],
    [400, 'invalid_request_error', 'bad-request'],
    [500, 'api_error', 'overloaded'],
    [529, 'overloaded_error', 'overloaded'],
    [404, 'not_found_error', 'unknown'],
  ])('turns a %i %s into "%s"', async (status, type, code) => {
    reply = apiError(status, type, 'The service said no.');
    expect((await failure(rewrite)).code).toBe(code);
  });

  it('points at the key when it is rejected', async () => {
    reply = apiError(401, 'authentication_error', 'invalid x-api-key');
    expect((await failure(rewrite)).message).toBe('The API key was rejected. Check the key in Settings.');
  });

  it('reports the same errors on a proofread', async () => {
    reply = apiError(429, 'rate_limit_error', 'Too many requests.');
    expect((await failure(proofread)).code).toBe('rate-limit');
  });

  it('says so when the connection fails', async () => {
    reply = (response) => response.socket?.destroy();
    expect((await failure(rewrite)).code).toBe('network');
  });

  it('keeps the service’s words when a stream fails part way', async () => {
    reply = streamed(
      start(),
      textBlock(0, ['Some text']),
      sseEvent({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    );
    const error = await failure(rewrite);
    expect(error.code).toBe('unknown');
    expect(error.message).toContain('Overloaded');
  });
});

describe('cancelling', () => {
  it('stops a stream part way and says it was cancelled', async () => {
    let hungUp: Promise<void> = Promise.resolve();
    reply = (response) => {
      hungUp = new Promise((resolve) => response.on('close', resolve));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(firstPiece('Started'));
    };
    const controller = new AbortController();
    const error = await failure(rewrite, { signal: controller.signal, onText: () => controller.abort() });
    expect(error.code).toBe('cancelled');
    await hungUp;
  });

  it('stops a proofread that is waiting for a reply', async () => {
    reply = () => undefined;
    const controller = new AbortController();
    const pending = failure(proofread, { signal: controller.signal });
    await expect.poll(() => received.length).toBe(1);
    controller.abort();
    expect((await pending).code).toBe('cancelled');
  });

  it('does not start a request that was already cancelled', async () => {
    reply = textReply(['Too late.']);
    const controller = new AbortController();
    controller.abort();
    expect((await failure(rewrite, { signal: controller.signal })).code).toBe('cancelled');
  });
});

describe('proofreading', () => {
  const suggestion: AiSuggestion = {
    paragraph: 1,
    quote: 'Second',
    replacement: 'Next',
    category: 'clarity',
    title: 'Use a plainer word',
    explanation: 'It reads more easily.',
  };

  const replyWith = (suggestions: unknown[]) => {
    const json = JSON.stringify({ suggestions });
    const middle = Math.floor(json.length / 2);
    reply = textReply([json.slice(0, middle), json.slice(middle)]);
  };

  it('reads the suggestions from the reply, however it was split', async () => {
    replyWith([suggestion, { ...suggestion, paragraph: 0, quote: 'First', replacement: 'Opening', category: 'engagement' }]);
    const result = await run(proofread);
    expect(result).toEqual({
      kind: 'proofread',
      suggestions: [suggestion, { ...suggestion, paragraph: 0, quote: 'First', replacement: 'Opening', category: 'engagement' }],
    });
  });

  it('sends no JSON to the text listener', async () => {
    replyWith([suggestion]);
    const pieces: string[] = [];
    await run(proofread, { onText: (delta) => pieces.push(delta) });
    expect(pieces).toEqual([]);
  });

  it('drops suggestions for paragraphs that do not exist', async () => {
    replyWith([{ ...suggestion, paragraph: 2 }, suggestion, { ...suggestion, paragraph: -1 }, { ...suggestion, paragraph: 99 }]);
    expect(await run(proofread)).toEqual({ kind: 'proofread', suggestions: [suggestion] });
  });

  it('drops suggestions that change nothing or point at nothing', async () => {
    replyWith([{ ...suggestion, quote: '' }, { ...suggestion, replacement: suggestion.quote }, suggestion]);
    expect(await run(proofread)).toEqual({ kind: 'proofread', suggestions: [suggestion] });
  });

  it('accepts an empty list: clean writing has nothing to fix', async () => {
    replyWith([]);
    expect(await run(proofread)).toEqual({ kind: 'proofread', suggestions: [] });
  });

  it('keeps a suggestion that deletes text', async () => {
    const removal = { ...suggestion, replacement: '' };
    replyWith([removal]);
    expect(await run(proofread)).toEqual({ kind: 'proofread', suggestions: [removal] });
  });

  it('reports a reply that is not what was asked for', async () => {
    reply = textReply(['Here are my suggestions: none.']);
    expect((await failure(proofread)).code).toBe('unknown');
    replyWith([{ ...suggestion, category: 'vibes' }]);
    expect((await failure(proofread)).code).toBe('unknown');
  });

  it('reports a reply with no text at all', async () => {
    reply = streamed(start(), end('end_turn'));
    const error = await failure(proofread);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('The AI reply could not be read. Try again.');
  });

  it('says a long reply was cut off, rather than showing a JSON error', async () => {
    reply = textReply(['{"suggestions":[{"paragraph":1,"quo'], 'max_tokens');
    const error = await failure(proofread);
    expect(error.code).toBe('truncated');
    expect(error.message).not.toContain('JSON');
  });

  it('says the model declined partway through, rather than showing a JSON error', async () => {
    reply = textReply(['{"suggestions":['], 'refusal');
    expect((await failure(proofread)).code).toBe('declined');
  });

  it('reads a reply that a fallback to another model split in two', async () => {
    const json = JSON.stringify({ suggestions: [suggestion] });
    const handover = { type: 'fallback', from: { model: OPUS }, to: { model: 'claude-opus-4-8' } };
    reply = streamed(
      start(),
      textBlock(0, [json.slice(0, 20)]),
      sseEvent({ type: 'content_block_start', index: 1, content_block: handover }),
      sseEvent({ type: 'content_block_stop', index: 1 }),
      textBlock(2, [json.slice(20)]),
      end('end_turn'),
    );
    expect(await run(proofread)).toEqual({ kind: 'proofread', suggestions: [suggestion] });
  });

  it('never shows a parser error to the writer', async () => {
    reply = textReply(['not json at all']);
    expect((await failure(proofread)).message).toBe('The AI reply could not be read. Try again.');
  });
});
