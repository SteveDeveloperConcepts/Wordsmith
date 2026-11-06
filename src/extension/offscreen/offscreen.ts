/// <reference types="chrome" />
/**
 * Hosts the analysis worker. A service worker cannot start workers, and loading a
 * 20 MB engine per tab would be wasteful, so one hidden document holds it for all tabs.
 */
import type { WorkerRequest, WorkerResponse } from '@engine/protocol';
import type { AnalyzeReply, OffscreenAnalyzeMessage, OffscreenIdleMessage } from '../shared/messages';
import { EngineQueue } from './engineQueue';

/** The engine holds about 200 MB once loaded, which is not worth keeping for a writer who has stepped away. */
const IDLE_MS = 10 * 60 * 1000;

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function startWorker(): Worker {
  const started = new Worker(new URL('../../engine/worker.ts', import.meta.url), {
    type: 'module',
    name: 'wordsmith-analysis',
  });
  started.onmessage = (event: MessageEvent<WorkerResponse>) => {
    queue.receive(event.data);
    armIdleTimer();
  };
  started.onerror = (event) => {
    worker = null;
    queue.workerFailed(event.message || 'The analysis worker failed to start.');
  };
  return started;
}

const queue = new EngineQueue((message: WorkerRequest) => {
  worker ??= startWorker();
  worker.postMessage(message);
});

function armIdleTimer(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!queue.idle) return;
    const message: OffscreenIdleMessage = { target: 'background', type: 'offscreen-idle' };
    void chrome.runtime.sendMessage(message);
  }, IDLE_MS);
}

chrome.runtime.onMessage.addListener(
  (message: OffscreenAnalyzeMessage, _sender, sendResponse: (reply: AnalyzeReply) => void) => {
    if (message?.target !== 'offscreen') return false;
    clearTimeout(idleTimer);
    queue.submit({ key: message.key, settings: message.settings, request: message.request, reply: sendResponse });
    return true;
  },
);
