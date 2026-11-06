// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiErrorCode, AiErrorInfo, AiRequest, AiResult } from '@shared/ai-types';
import type { AiEvent, DesktopBridge } from '@shared/api';
import { DEFAULT_GOALS } from '@engine/types';
import { runAi, useAiReady } from '@renderer/ai/client';
import { explainAiError, markdownToHtml, reactionItems, selectedPassage, useAi } from '@renderer/state/ai';
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

describe('explaining a failure', () => {
  it.each<[AiErrorCode, 'settings' | 'retry' | null]>([
    ['no-key', 'settings'],
    ['auth', 'settings'],
    ['bad-request', 'settings'],
    ['rate-limit', 'retry'],
    ['overloaded', 'retry'],
    ['network', 'retry'],
    ['declined', 'retry'],
    ['unknown', 'retry'],
    ['truncated', null],
    ['too-long', null],
  ])('suggests the next step after "%s"', (code, next) => {
    expect(explainAiError({ code, message: 'Something happened.' })).toMatchObject({ message: 'Something happened.', next });
  });

  it('keeps a raw service error away from the writer, but not what the service said', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model: "x" not found' } });
    expect(explainAiError({ code: 'bad-request', message: `The AI service rejected the request: 400 ${body}` })).toEqual({
      message: 'The AI service could not complete this request.',
      detail: 'model: "x" not found',
      next: 'settings',
    });
  });
});

describe('reading a reply', () => {
  it('splits a reaction into its points, whatever the bullets', () => {
    expect(reactionItems('- One\n* Two\n• Three\n1. Four\n2) Five')).toEqual(['One', 'Two', 'Three', 'Four', 'Five']);
  });

  it('joins a point that wraps onto a second line', () => {
    expect(reactionItems('- One\n  and more\n\n- Two')).toEqual(['One and more', 'Two']);
  });

  it('copes with a reaction that is still arriving', () => {
    expect(reactionItems('')).toEqual([]);
    expect(reactionItems('Before any bullet')).toEqual(['Before any bullet']);
    expect(reactionItems('- One\n- Tw')).toEqual(['One', 'Tw']);
  });

  it('shows raw HTML as text, so it cannot run', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\nHi <img src=x onerror=alert(1)> there');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never fetches an image named in a reply', () => {
    const html = markdownToHtml('![a chart](https://example.com/spy.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.com');
    expect(html).toContain('a chart');
  });
});

describe('rewriting in the document', () => {
  let editor: Editor;

  /** "The second paragraph." */
  const SECOND = { from: 23, to: 44 };

  const text = () => editor.getText({ blockSeparator: '|' });

  function rewriteSecondParagraph() {
    editor.commands.setTextSelection(SECOND);
    useAi.getState().runRewrite('Shorten it.', 'Shorten it');
  }

  async function finishWith(reply: string) {
    emit({ id: lastId(), type: 'done', result: { kind: 'text', text: reply } });
    await settled();
  }

  beforeEach(() => {
    editor = new Editor({
      extensions: [StarterKit.configure({ trailingNode: false })],
      content: '<p>The first paragraph.</p><p>The second paragraph.</p><h2>A heading</h2>',
    });
    useSession.setState({ editor });
  });

  afterEach(() => {
    useSession.setState({ editor: null });
    editor.destroy();
  });

  it('sends the passage, and shows the reply as it arrives', async () => {
    rewriteSecondParagraph();
    expect(useAi.getState().rewrite).toMatchObject({ status: 'running', source: 'The second paragraph.', label: 'Shorten it' });
    expect(bridge.aiStart.mock.calls.at(-1)?.[2]).toMatchObject({ kind: 'rewrite', text: 'The second paragraph.' });

    emit({ id: lastId(), type: 'text', delta: 'The sec' });
    expect(useAi.getState().rewrite.output).toBe('The sec');
    await finishWith('The second.');
    expect(useAi.getState().rewrite).toMatchObject({ status: 'done', output: 'The second.' });
  });

  it('replaces the passage and leaves the result selected', async () => {
    rewriteSecondParagraph();
    await finishWith('Second.');
    useAi.getState().replaceRewrite();
    expect(text()).toBe('The first paragraph.|Second.|A heading');
    expect(selectedPassage(editor.state)).toBe('Second.');
    expect(useAi.getState().rewrite.status).toBe('idle');
  });

  it('refuses to replace a passage that has changed', async () => {
    rewriteSecondParagraph();
    await finishWith('Second.');
    editor.commands.insertContentAt(SECOND.from + 4, 'very ');
    useAi.getState().replaceRewrite();
    expect(useAi.getState().rewrite.note).toContain('has changed');
    expect(text()).toContain('The very second paragraph.');
  });

  it('follows a passage that moves', async () => {
    rewriteSecondParagraph();
    await finishWith('Second.');
    editor.commands.insertContentAt(1, 'Well, ');
    useAi.getState().replaceRewrite();
    expect(text()).toBe('Well, The first paragraph.|Second.|A heading');
  });

  it('keeps a waiting rewrite when a draft goes in elsewhere', async () => {
    rewriteSecondParagraph();
    await finishWith('Second.');

    editor.commands.setTextSelection(1);
    useAi.getState().setDraft({ composePrompt: 'An opening.' });
    useAi.getState().runCompose();
    await finishWith('An opening.');
    useAi.getState().insertComposed();

    useAi.getState().replaceRewrite();
    expect(useAi.getState().rewrite.note).toBeNull();
    expect(text()).toBe('An opening.The first paragraph.|Second.|A heading');
  });

  it('keeps a waiting rewrite when a suggestion goes in elsewhere', async () => {
    rewriteSecondParagraph();
    await finishWith('Second.');

    useAi.getState().runProofread();
    const suggestion = { paragraph: 0, quote: 'first', replacement: 'opening', category: 'clarity', title: 'T', explanation: 'E' } as const;
    emit({ id: lastId(), type: 'done', result: { kind: 'proofread', suggestions: [suggestion] } });
    await settled();
    useAi.getState().applySuggestion('0');

    useAi.getState().replaceRewrite();
    expect(useAi.getState().rewrite.note).toBeNull();
    expect(text()).toBe('The opening paragraph.|Second.|A heading');
  });

  it('keeps a heading a heading', async () => {
    editor.commands.setTextSelection({ from: 46, to: 55 });
    useAi.getState().runRewrite('Shorten it.', 'Shorten it');
    await finishWith('Heading');
    useAi.getState().replaceRewrite();
    expect(editor.getHTML()).toContain('<h2>Heading</h2>');
  });
});
