import { describe, expect, it, vi } from 'vitest';
import type { WorkerRequest } from '@engine/protocol';
import { DEFAULT_ENGINE_SETTINGS, type AnalysisResult, type EngineSettings } from '@engine/types';
import { EngineQueue } from '../../src/extension/offscreen/engineQueue';

const result = { issues: [], grammarEngineReady: true } as unknown as AnalysisResult;

function setup() {
  const posted: WorkerRequest[] = [];
  const queue = new EngineQueue((message) => posted.push(message));
  const job = (key: string, settings: EngineSettings = DEFAULT_ENGINE_SETTINGS) => {
    const reply = vi.fn();
    queue.submit({ key, settings, request: { blocks: [{ text: key, kind: 'paragraph' }] }, reply });
    return reply;
  };
  const analyses = () => posted.filter((message) => message.type === 'analyze');
  const finishLast = () => {
    const last = analyses().at(-1);
    if (last?.type === 'analyze') queue.receive({ type: 'result', id: last.id, result });
  };
  return { posted, queue, job, analyses, finishLast };
}

describe('sharing the worker', () => {
  it('runs one request at a time, so the worker never skips another tab\'s', () => {
    const { job, analyses, finishLast } = setup();
    const first = job('tab 1');
    const second = job('tab 2');
    expect(analyses()).toHaveLength(1);

    finishLast();
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    expect(analyses()).toHaveLength(2);

    finishLast();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
  });

  it('replaces a waiting request from the same field with the newer one', () => {
    const { job, analyses, finishLast } = setup();
    const running = job('busy');
    const older = job('field');
    const newer = job('field');
    expect(older).toHaveBeenCalledWith({ status: 'superseded' });

    finishLast();
    expect(running).toHaveBeenCalled();
    finishLast();
    expect(newer).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    expect(analyses()).toHaveLength(2);
  });

  it('lets a request that is already running finish', () => {
    const { job, finishLast } = setup();
    const running = job('field');
    const newer = job('field');
    expect(running).not.toHaveBeenCalled();
    finishLast();
    expect(running).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    finishLast();
    expect(newer).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
  });

  it('configures the worker before the first analysis, and again only when settings change', () => {
    const { posted, job, finishLast } = setup();
    job('one');
    finishLast();
    job('two');
    finishLast();
    expect(posted.map((message) => message.type)).toEqual(['configure', 'analyze', 'analyze']);

    job('three', { ...DEFAULT_ENGINE_SETTINGS, dictionary: ['wrold'] });
    finishLast();
    expect(posted.map((message) => message.type)).toEqual(['configure', 'analyze', 'analyze', 'configure', 'analyze']);
  });

  it('passes on an analysis error and carries on', () => {
    const { queue, job, analyses, finishLast } = setup();
    const failing = job('one');
    const next = job('two');
    const [running] = analyses();
    if (running.type === 'analyze') queue.receive({ type: 'error', id: running.id, message: 'broke' });
    expect(failing).toHaveBeenCalledWith({ status: 'failed', message: 'broke' });
    finishLast();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
  });

  it('answers the running request when the worker dies, and sets up the next worker from scratch', () => {
    const { posted, queue, job } = setup();
    const running = job('one');
    const next = job('two');
    queue.workerFailed('crashed');
    expect(running).toHaveBeenCalledWith({ status: 'failed', message: 'crashed' });
    expect(next).not.toHaveBeenCalled();
    expect(posted.map((message) => message.type)).toEqual(['configure', 'analyze', 'configure', 'analyze']);
  });

  it('ignores a late reply it is not waiting for', () => {
    const { queue, job } = setup();
    const reply = job('one');
    queue.receive({ type: 'result', id: 999, result });
    queue.receive({ type: 'ready', grammarEngineReady: true });
    queue.receive({ type: 'error', id: null, message: 'configure failed' });
    expect(reply).not.toHaveBeenCalled();
  });

  it('reports when it has nothing to do', () => {
    const { queue, job, finishLast } = setup();
    expect(queue.idle).toBe(true);
    job('one');
    expect(queue.idle).toBe(false);
    finishLast();
    expect(queue.idle).toBe(true);
  });
});
