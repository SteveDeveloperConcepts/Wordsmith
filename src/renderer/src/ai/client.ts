/**
 * How the UI runs an AI request. On the desktop the main process does the work,
 * because it holds the key; in a browser it runs in the page, with the SDK loaded
 * on first use so it stays out of the main bundle.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { AiError, type AiRequest, type AiResult } from '@shared/ai-types';
import type { AiEvent, DesktopBridge } from '@shared/api';
import { desktop } from '../platform';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';

export interface RunAiOptions {
  /** Receives each piece of text as it is generated. */
  onText?(delta: string): void;
  /** Aborting stops the request, and the promise rejects with a "cancelled" AiError. */
  signal?: AbortSignal;
}

const cancelled = () => new AiError('cancelled', 'Cancelled.');

const newId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function runOnDesktop(
  bridge: DesktopBridge,
  model: string,
  request: AiRequest,
  { onText, signal }: RunAiOptions,
): Promise<AiResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }

    const id = newId();
    const stopListening = bridge.onAiEvent(onEvent);
    signal?.addEventListener('abort', onAbort, { once: true });

    function finish(settle: () => void): void {
      stopListening();
      signal?.removeEventListener('abort', onAbort);
      settle();
    }

    function onEvent(event: AiEvent): void {
      if (event.id !== id) return;
      if (event.type === 'text') onText?.(event.delta);
      else if (event.type === 'done') finish(() => resolve(event.result));
      else finish(() => reject(new AiError(event.error.code, event.error.message)));
    }

    function onAbort(): void {
      void bridge.aiCancel(id).catch(() => undefined);
      finish(() => reject(cancelled()));
    }

    bridge.aiStart(id, model, request).catch((err: unknown) => {
      finish(() => reject(new AiError('unknown', err instanceof Error ? err.message : String(err))));
    });
  });
}

async function runInBrowser(model: string, key: string, request: AiRequest, { onText, signal }: RunAiOptions): Promise<AiResult> {
  if (!key) throw new AiError('no-key', 'Add your Anthropic API key in Settings to use AI features.');
  const ai = await import('@shared/ai').catch(() => {
    throw new AiError('network', 'Could not load the AI features. Check your internet connection and reload the page.');
  });
  if (signal?.aborted) throw cancelled();
  return ai.runAi(ai.createClient(key, true), model, request, (delta) => onText?.(delta), signal);
}

/** Run one AI request. Every failure, on either platform, is an AiError. */
export function runAi(request: AiRequest, options: RunAiOptions = {}): Promise<AiResult> {
  const { aiModel, webApiKey } = useSettings.getState();
  if (desktop) return runOnDesktop(desktop, aiModel, request, options);
  return runInBrowser(aiModel, webApiKey.trim(), request, options);
}

/**
 * Whether the shell holds a key. One shared value, so all the controls agree and a
 * panel that remounts does not flash its "no key" state while the shell answers.
 */
const useDesktopKey = create<{ present: boolean }>(() => ({ present: false }));

/** Whether AI features can run: a key is available on this platform. */
export function useAiReady(): boolean {
  const desktopReady = useDesktopKey((s) => s.present);
  const browserReady = useSettings((s) => s.webApiKey.trim() !== '');
  const settingsOpen = useSession((s) => s.dialog === 'settings');

  // The shell keeps the key out of the page, so the only way to learn it changed
  // is to ask again once the settings dialog has closed.
  useEffect(() => {
    if (!desktop || settingsOpen) return;
    let stale = false;
    desktop
      .aiHasKey()
      .catch(() => false)
      .then((present) => {
        if (!stale) useDesktopKey.setState({ present });
      });
    return () => {
      stale = true;
    };
  }, [settingsOpen]);

  return desktop ? desktopReady : browserReady;
}
