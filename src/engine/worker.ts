/// <reference lib="webworker" />
/**
 * Web worker entry point. All analysis runs here so typing never stutters.
 */
import { slimBinary } from 'harper.js/slimBinary';
import { Analyzer } from './analyze';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const analyzer = new Analyzer(slimBinary);
const post = (message: WorkerResponse) => self.postMessage(message);

/** Requests run one at a time, in order, so configuration always lands before the next analysis. */
let queue: Promise<void> = Promise.resolve();
/** Newest analysis request seen; older ones still waiting are skipped. */
let latestAnalysis = 0;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'analyze') latestAnalysis = message.id;

  queue = queue.then(async () => {
    try {
      switch (message.type) {
        case 'configure':
          analyzer.configure(message.settings);
          break;
        case 'warm-up':
          await analyzer.warmUp();
          post({ type: 'ready', grammarEngineReady: analyzer.grammarEngineReady, engineError: analyzer.engineError });
          break;
        case 'analyze': {
          if (message.id !== latestAnalysis) {
            post({ type: 'skipped', id: message.id });
            break;
          }
          const result = await analyzer.analyze(message.request);
          post({ type: 'result', id: message.id, result });
          break;
        }
      }
    } catch (err) {
      post({
        type: 'error',
        id: message.type === 'analyze' ? message.id : null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
};
