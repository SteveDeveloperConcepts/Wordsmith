// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalysisClient } from '@renderer/editor/analysisClient';

/** Stands in for the engine's worker, doing nothing until a test says so. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: Array<{ type: string; id?: number }> = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(message: { type: string; id?: number }) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }
}

const request = { blocks: [{ text: 'Hello.', kind: 'paragraph' as const }], dismissed: [] };

describe('AnalysisClient', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers a request that was waiting when the worker failed', async () => {
    const client = new AnalysisClient();
    const pending = client.analyze(request);
    FakeWorker.all[0].onerror?.({ message: 'Failed to fetch the module' });
    await expect(pending).resolves.toBeNull();
    expect(client.status).toMatchObject({ started: true, grammarEngineReady: false, error: 'Failed to fetch the module' });
  });

  it('does not leave later requests waiting either', async () => {
    const client = new AnalysisClient();
    void client.analyze(request);
    FakeWorker.all[0].onerror?.({ message: 'broken' });
    await expect(client.analyze(request)).resolves.toBeNull();
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('discards the failed worker, and tries a new one after a while', () => {
    const client = new AnalysisClient();
    void client.analyze(request);
    const first = FakeWorker.all[0];
    first.onerror?.({ message: 'broken' });
    expect(first.terminated).toBe(true);

    vi.advanceTimersByTime(11_000);
    void client.analyze(request);
    expect(FakeWorker.all).toHaveLength(2);
    expect(FakeWorker.all[1].posted.some((message) => message.type === 'analyze')).toBe(true);
  });

  it('gives the new worker the settings the old one had', () => {
    const client = new AnalysisClient();
    client.configure({ dialect: 'british' } as never);
    void client.analyze(request);
    FakeWorker.all[0].onerror?.({ message: 'broken' });
    vi.advanceTimersByTime(11_000);
    void client.analyze(request);
    expect(FakeWorker.all[1].posted[0]).toMatchObject({ type: 'configure' });
  });
});
