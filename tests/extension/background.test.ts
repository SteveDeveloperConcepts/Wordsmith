import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SITE_MATCHES } from '../../src/extension/shared/sites';

type Listener = (...args: never[]) => unknown;

/**
 * The parts of the extension APIs the service worker uses. The browser's permission
 * prompt cannot be driven from a test, so the grant flow is checked against this.
 */
function fakeChrome() {
  const listeners = {
    message: [] as Listener[],
    installed: [] as Listener[],
    added: [] as Listener[],
    removed: [] as Listener[],
  };
  const on = (list: Listener[]) => ({ addListener: (listener: Listener) => list.push(listener) });
  const api = {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      onMessage: on(listeners.message),
      onInstalled: on(listeners.installed),
      getContexts: vi.fn(async (): Promise<unknown[]> => []),
      sendMessage: vi.fn(async (_message: unknown): Promise<unknown> => ({ status: 'superseded' })),
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
    },
    permissions: {
      onAdded: on(listeners.added),
      onRemoved: on(listeners.removed),
      getAll: vi.fn(async (): Promise<{ origins: string[] }> => ({ origins: [] })),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async (): Promise<unknown[]> => []),
      registerContentScripts: vi.fn(async (_scripts: Array<{ matches: string[] }>) => undefined),
      unregisterContentScripts: vi.fn(async () => undefined),
      executeScript: vi.fn(async () => []),
    },
    tabs: { query: vi.fn(async (): Promise<Array<{ id?: number }>> => []) },
    storage: { sync: { get: vi.fn(async () => ({})) } },
  };
  vi.stubGlobal('chrome', api);
  return { api, listeners };
}

async function start() {
  const fake = fakeChrome();
  vi.resetModules();
  await import('../../src/extension/background/index');
  const send = (message: unknown, sender: unknown = { tab: { id: 7 }, frameId: 2 }) =>
    new Promise((resolve) => {
      for (const listener of fake.listeners.message) {
        (listener as (m: unknown, s: unknown, r: (reply: unknown) => void) => void)(message, sender, resolve);
      }
    });
  const analyze = { target: 'background', type: 'analyze', fieldId: 3, request: { blocks: [] } };
  return { ...fake, send, analyze };
}

describe('routing a check', () => {
  it('starts the offscreen document for workers, and passes the check on with the settings', async () => {
    const { api, send, analyze } = await start();
    await send(analyze);
    expect(api.offscreen.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'] }),
    );
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'offscreen',
        key: '7:2:3',
        request: analyze.request,
        settings: expect.objectContaining({ dialect: 'american', dictionary: [] }),
      }),
    );
  });

  it('uses the document that is already there', async () => {
    const { api, send, analyze } = await start();
    api.runtime.getContexts.mockResolvedValue([{}]);
    await send(analyze);
    expect(api.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('creates only one document when two tabs ask at once', async () => {
    const { api, send, analyze } = await start();
    await Promise.all([send(analyze), send(analyze)]);
    expect(api.offscreen.createDocument).toHaveBeenCalledOnce();
  });

  it('tries again when the document goes away during the send', async () => {
    const { api, send, analyze } = await start();
    const reply = { status: 'done', issues: [], grammarEngineReady: true };
    api.runtime.sendMessage.mockRejectedValueOnce(new Error('Receiving end does not exist')).mockResolvedValue(reply);
    expect(await send(analyze)).toEqual(reply);
    expect(api.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  it('reports failure rather than leaving the page waiting', async () => {
    const { api, send, analyze } = await start();
    api.runtime.sendMessage.mockRejectedValue(new Error('no engine'));
    expect(await send(analyze)).toEqual({ status: 'failed', message: 'Error: no engine' });
  });

  it('closes the document when it reports being idle', async () => {
    const { api, listeners } = await start();
    const handled = (listeners.message[0] as (m: unknown, s: unknown, r: () => void) => boolean)(
      { target: 'background', type: 'offscreen-idle' },
      {},
      () => undefined,
    );
    expect(handled).toBe(false);
    expect(api.offscreen.closeDocument).toHaveBeenCalledOnce();
  });

  it('leaves messages for other parts alone', async () => {
    const { api, listeners } = await start();
    const handled = (listeners.message[0] as (m: unknown, s: unknown, r: () => void) => boolean)(
      { target: 'offscreen', type: 'analyze' },
      {},
      () => undefined,
    );
    expect(handled).toBe(false);
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('sites the writer grants', () => {
  const FORUM = 'https://forum.example.com/*';

  const fire = async (list: Listener[], ...args: unknown[]) => {
    await Promise.all(list.map((listener) => (listener as (...a: unknown[]) => unknown)(...args)));
    await vi.waitFor(() => undefined);
  };

  it('gives a granted site the content script, in every frame', async () => {
    const { api, listeners } = await start();
    api.permissions.getAll.mockResolvedValue({ origins: [...DEFAULT_SITE_MATCHES, FORUM] });
    await fire(listeners.added, { origins: [FORUM] });
    expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([
      expect.objectContaining({ matches: [FORUM], js: ['content.js'], allFrames: true, matchOriginAsFallback: true }),
    ]);
  });

  it('never registers the default sites, which the manifest already covers', async () => {
    const { api, listeners } = await start();
    api.permissions.getAll.mockResolvedValue({ origins: DEFAULT_SITE_MATCHES });
    await fire(listeners.installed);
    await vi.waitFor(() => expect(api.permissions.getAll).toHaveBeenCalled());
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('reaches pages already open on the new site, without a reload', async () => {
    const { api, listeners } = await start();
    api.permissions.getAll.mockResolvedValue({ origins: [FORUM] });
    api.tabs.query.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    await fire(listeners.added, { origins: [FORUM] });
    expect(api.tabs.query).toHaveBeenCalledWith({ url: [FORUM] });
    expect(api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 11, allFrames: true },
      files: ['content.js'],
    });
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(2);
  });

  it('replaces the old list when sites change', async () => {
    const { api, listeners } = await start();
    api.scripting.getRegisteredContentScripts.mockResolvedValue([{ id: 'wordsmith-granted-sites' }]);
    api.permissions.getAll.mockResolvedValue({ origins: [FORUM, 'https://wiki.example.com/*'] });
    await fire(listeners.added, { origins: ['https://wiki.example.com/*'] });
    expect(api.scripting.unregisterContentScripts).toHaveBeenCalledOnce();
    const [[scripts]] = api.scripting.registerContentScripts.mock.calls;
    expect(scripts[0].matches).toHaveLength(2);
  });

  it('removes the registration when the last grant goes', async () => {
    const { api, listeners } = await start();
    api.scripting.getRegisteredContentScripts.mockResolvedValue([{ id: 'wordsmith-granted-sites' }]);
    await fire(listeners.removed, { origins: [FORUM] });
    await vi.waitFor(() => expect(api.scripting.unregisterContentScripts).toHaveBeenCalledOnce());
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
});
