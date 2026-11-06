// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiErrorInfo, AiRequest, AiResult } from '@shared/ai-types';
import type { AiEvent, DesktopBridge } from '@shared/api';
import { DEFAULT_GOALS } from '@engine/types';
import { runAi, useAiReady } from '@renderer/ai/client';
import { useSession } from '@renderer/state/session';
import { useSettings } from '@renderer/state/settings';

/* `platform.ts` reads the bridge once, on import, so the fake has to be in place before anything loads. */
const shell = vi.hoisted(() => {
  const listeners = new Set<(event: AiEvent) => void>();
  const bridge = {
    aiStart: vi.fn<(id: string, model: string, request: AiRequest) => Promise<void>>(),
    aiCancel: vi.fn<(id: string) => Promise<void>>(),
    aiHasKey: vi.fn<() => Promise<boolean>>(),
    onAiEvent(listener: (event: AiEvent) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  window.wordsmith = bridge as unknown as DesktopBridge;
  return { bridge, listeners, emit: (event: AiEvent) => [...listeners].forEach((listener) => listener(event)) };
});

const { bridge, listeners, emit } = shell;

const request: AiRequest = {
  kind: 'rewrite',
  text: 'The cat sat.',
  instruction: 'Shorten it.',
  goals: DEFAULT_GOALS,
  dialect: 'american',
};

const finished: AiResult = { kind: 'text', text: 'The cat sat.' };

/** The id the UI gave the most recent request. */
const lastId = () => bridge.aiStart.mock.calls.at(-1)?.[0] ?? '';

/** Lets a promise that has already settled run its handlers. */
const settled = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  bridge.aiStart.mockReset().mockResolvedValue(undefined);
  bridge.aiCancel.mockReset().mockResolvedValue(undefined);
  bridge.aiHasKey.mockReset().mockResolvedValue(false);
  listeners.clear();
  useSettings.setState({ aiModel: 'claude-sonnet-5-5', webApiKey: '' });
  useSession.setState({ dialog: null });
});

describe('runAi on the desktop', () => {
  it('hands the request to the shell with the model from settings', () => {
    void runAi(request);
    expect(bridge.aiStart).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'claude-sonnet-5-5', request);
  });

  it('never needs the page to hold a key', async () => {
    const running = runAi(request);
    emit({ id: lastId(), type: 'done', result: finished });
    await expect(running).resolves.toEqual(finished);
  });

  it('gives each request its own id', () => {
    void runAi(request);
    const first = lastId();
    void runAi(request);
    expect(lastId()).not.toBe(first);
  });

  it('passes text on as it streams, then resolves with the result', async () => {
    const pieces: string[] = [];
    const running = runAi(request, { onText: (delta) => pieces.push(delta) });
    emit({ id: lastId(), type: 'text', delta: 'The ' });
    emit({ id: lastId(), type: 'text', delta: 'cat.' });
    expect(pieces).toEqual(['The ', 'cat.']);
    emit({ id: lastId(), type: 'done', result: { kind: 'text', text: 'The cat.' } });
    await expect(running).resolves.toEqual({ kind: 'text', text: 'The cat.' });
  });

  it('works without a text listener', async () => {
    const running = runAi(request);
    emit({ id: lastId(), type: 'text', delta: 'Unheard.' });
    emit({ id: lastId(), type: 'done', result: finished });
    await expect(running).resolves.toEqual(finished);
  });

  it('resolves with a proofread result as it came', async () => {
    const result: AiResult = { kind: 'proofread', suggestions: [] };
    const running = runAi({ kind: 'proofread', paragraphs: ['One.'], goals: DEFAULT_GOALS, dialect: 'american' });
    emit({ id: lastId(), type: 'done', result });
    await expect(running).resolves.toEqual(result);
  });

  it('ignores events for other requests', async () => {
    const pieces: string[] = [];
    const first = runAi(request, { onText: (delta) => pieces.push(delta) });
    const firstId = lastId();
    const second = runAi(request);
    const secondId = lastId();

    emit({ id: secondId, type: 'text', delta: 'For the other one.' });
    emit({ id: secondId, type: 'done', result: { kind: 'text', text: 'Second.' } });
    emit({ id: 'someone-else', type: 'error', error: { code: 'auth', message: 'Not yours.' } });
    await expect(second).resolves.toEqual({ kind: 'text', text: 'Second.' });
    expect(pieces).toEqual([]);

    emit({ id: firstId, type: 'done', result: finished });
    await expect(first).resolves.toEqual(finished);
  });

  it.each<AiErrorInfo>([
    { code: 'no-key', message: 'Add your Anthropic API key in Settings to use AI features.' },
    { code: 'auth', message: 'The API key was rejected. Check the key in Settings.' },
    { code: 'rate-limit', message: 'Wait a moment and try again.' },
    { code: 'declined', message: 'The AI model declined this request.' },
  ])('rejects with the "$code" error the shell reported', async (error) => {
    const running = runAi(request);
    emit({ id: lastId(), type: 'error', error });
    await expect(running).rejects.toMatchObject({ name: 'AiError', ...error });
  });

  it('turns a request the shell could not take into an error', async () => {
    bridge.aiStart.mockRejectedValue(new Error('No handler for ai:start'));
    await expect(runAi(request)).rejects.toMatchObject({ code: 'unknown', message: 'No handler for ai:start' });
    expect(listeners.size).toBe(0);
  });

  it('stops listening once a request is over', async () => {
    const done = runAi(request);
    expect(listeners.size).toBe(1);
    emit({ id: lastId(), type: 'done', result: finished });
    await done;
    expect(listeners.size).toBe(0);

    const failed = runAi(request);
    emit({ id: lastId(), type: 'error', error: { code: 'network', message: 'Offline.' } });
    await expect(failed).rejects.toThrow('Offline.');
    expect(listeners.size).toBe(0);
  });

  it('settles once, whatever arrives after the end', async () => {
    const pieces: string[] = [];
    const running = runAi(request, { onText: (delta) => pieces.push(delta) });
    const id = lastId();
    emit({ id, type: 'done', result: finished });
    emit({ id, type: 'text', delta: 'Late.' });
    emit({ id, type: 'error', error: { code: 'unknown', message: 'Late.' } });
    await expect(running).resolves.toEqual(finished);
    expect(pieces).toEqual([]);
  });
});

describe('cancelling on the desktop', () => {
  it('tells the shell which request to stop, and rejects as cancelled', async () => {
    const controller = new AbortController();
    const running = runAi(request, { signal: controller.signal });
    const id = lastId();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(bridge.aiCancel).toHaveBeenCalledExactlyOnceWith(id);
    expect(listeners.size).toBe(0);
  });

  it('drops text that was already on its way', async () => {
    const pieces: string[] = [];
    const controller = new AbortController();
    const running = runAi(request, { signal: controller.signal, onText: (delta) => pieces.push(delta) });
    const id = lastId();
    controller.abort();
    emit({ id, type: 'text', delta: 'Too late.' });
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(pieces).toEqual([]);
  });

  it('never starts a request that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runAi(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(bridge.aiStart).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('does not mind if the shell cannot cancel', async () => {
    bridge.aiCancel.mockRejectedValue(new Error('Gone.'));
    const controller = new AbortController();
    const running = runAi(request, { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await settled();
  });

  it('has nothing to cancel once a request is over', async () => {
    const controller = new AbortController();
    const running = runAi(request, { signal: controller.signal });
    emit({ id: lastId(), type: 'done', result: finished });
    await running;
    controller.abort();
    expect(bridge.aiCancel).not.toHaveBeenCalled();
  });
});

describe('useAiReady on the desktop', () => {
  // React warns about state updates outside `act` unless told this is a test.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root;
  let ready: boolean;

  function Probe() {
    ready = useAiReady();
    return null;
  }

  const mount = () =>
    act(async () => {
      root = createRoot(document.createElement('div'));
      root.render(createElement(Probe));
    });

  const setDialog = (dialog: 'settings' | null) =>
    act(async () => {
      useSession.getState().openDialog(dialog);
    });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it('asks the shell whether it holds a key', async () => {
    bridge.aiHasKey.mockResolvedValue(true);
    await mount();
    expect(ready).toBe(true);
  });

  it('is not ready without a key, whatever the browser build has stored', async () => {
    useSettings.setState({ webApiKey: 'sk-left-over' });
    bridge.aiHasKey.mockResolvedValue(false);
    await mount();
    expect(ready).toBe(false);
  });

  it('asks again when the settings dialog closes', async () => {
    bridge.aiHasKey.mockResolvedValue(false);
    await mount();
    expect(ready).toBe(false);

    await setDialog('settings');
    bridge.aiHasKey.mockResolvedValue(true);
    bridge.aiHasKey.mockClear();
    await setDialog(null);
    expect(bridge.aiHasKey).toHaveBeenCalledOnce();
    expect(ready).toBe(true);

    await setDialog('settings');
    bridge.aiHasKey.mockResolvedValue(false);
    await setDialog(null);
    expect(ready).toBe(false);
  });

  it('does not ask while the settings dialog is open', async () => {
    await setDialog('settings');
    bridge.aiHasKey.mockClear();
    await mount();
    expect(bridge.aiHasKey).not.toHaveBeenCalled();
  });

  it('treats a shell that cannot answer as having no key', async () => {
    bridge.aiHasKey.mockResolvedValue(true);
    await mount();
    expect(ready).toBe(true);

    await setDialog('settings');
    bridge.aiHasKey.mockRejectedValue(new Error('Gone.'));
    await setDialog(null);
    expect(ready).toBe(false);
  });

  it('remembers the answer, so a panel that remounts does not flash its setup state', async () => {
    bridge.aiHasKey.mockResolvedValue(true);
    await mount();
    await act(async () => root.unmount());

    let answer: (present: boolean) => void = () => undefined;
    bridge.aiHasKey.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mount();
    expect(ready).toBe(true);
    await act(async () => answer(true));
  });
});
