/**
 * AI requests run here in the main process so the API key never reaches the page.
 * The key is stored encrypted with the operating system's credential protection
 * (Keychain on macOS, DPAPI on Windows).
 */
import { safeStorage, type WebContents } from 'electron';
import { createClient, runAi, toAiError } from '@shared/ai';
import { AI_MODELS, AiError, type AiRequest } from '@shared/ai-types';
import { IPC, type AiEvent } from '@shared/api';
import * as store from './store';

/** Used only when the OS offers no encryption: the key then lasts for this session. */
let sessionKey: string | null = null;

const jobs = new Map<string, AbortController>();

function readKey(): string | null {
  if (sessionKey) return sessionKey;
  const stored = store.get('aiKey');
  if (!stored || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return null;
  }
}

export function hasKey(): boolean {
  return readKey() !== null;
}

export function setKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  if (safeStorage.isEncryptionAvailable()) {
    store.set('aiKey', safeStorage.encryptString(trimmed).toString('base64'));
    sessionKey = null;
  } else {
    sessionKey = trimmed;
  }
}

export function clearKey(): void {
  sessionKey = null;
  store.set('aiKey', undefined);
}

const KINDS = new Set(['rewrite', 'compose', 'reader', 'proofread']);

export function start(target: WebContents, id: string, model: string, request: AiRequest): void {
  const send = (event: AiEvent) => {
    if (!target.isDestroyed()) target.send(IPC.aiEvent, event);
  };
  const fail = (error: AiError) => send({ id, type: 'error', error: error.toInfo() });

  if (typeof id !== 'string' || !request || !KINDS.has(request.kind)) {
    fail(new AiError('bad-request', 'Unrecognized AI request.'));
    return;
  }
  if (!AI_MODELS.some((m) => m.id === model)) {
    fail(new AiError('bad-request', 'Unknown AI model. Choose a model in Settings.'));
    return;
  }
  const key = readKey();
  if (!key) {
    fail(new AiError('no-key', 'Add your Anthropic API key in Settings to use AI features.'));
    return;
  }

  const controller = new AbortController();
  jobs.set(id, controller);
  runAi(createClient(key), model, request, (delta) => send({ id, type: 'text', delta }), controller.signal)
    .then((result) => send({ id, type: 'done', result }))
    .catch((err) => fail(toAiError(err)))
    .finally(() => jobs.delete(id));
}

export function cancel(id: string): void {
  jobs.get(id)?.abort();
  jobs.delete(id);
}
