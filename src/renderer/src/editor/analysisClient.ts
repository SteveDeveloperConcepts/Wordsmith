/**
 * Client for the analysis worker. One worker serves the whole app; requests are
 * numbered so that a reply to an out-of-date request is ignored.
 */
import type { WorkerRequest, WorkerResponse } from '@engine/protocol';
import type { AnalysisResult, AnalyzeRequest, EngineSettings } from '@engine/types';

export interface EngineStatus {
  /** Has the worker reported back at all? */
  started: boolean;
  grammarEngineReady: boolean;
  error?: string;
}

type StatusListener = (status: EngineStatus) => void;

class AnalysisClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, (result: AnalysisResult | null) => void>();
  private listeners = new Set<StatusListener>();
  private settings: EngineSettings | null = null;
  status: EngineStatus = { started: false, grammarEngineReady: false };

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../../../engine/worker.ts', import.meta.url), {
      type: 'module',
      name: 'wordsmith-analysis',
    });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data);
    worker.onerror = (event) => {
      this.setStatus({ started: true, grammarEngineReady: false, error: event.message || 'The analysis worker failed to start.' });
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
    };
    this.worker = worker;
    if (this.settings) this.post({ type: 'configure', settings: this.settings });
    this.post({ type: 'warm-up' });
    return worker;
  }

  private post(message: WorkerRequest): void {
    this.worker?.postMessage(message);
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  private receive(message: WorkerResponse): void {
    switch (message.type) {
      case 'ready':
        this.setStatus({ started: true, grammarEngineReady: message.grammarEngineReady, error: message.engineError });
        break;
      case 'result': {
        const { result } = message;
        if (result.grammarEngineReady !== this.status.grammarEngineReady || result.engineError !== this.status.error) {
          this.setStatus({ started: true, grammarEngineReady: result.grammarEngineReady, error: result.engineError });
        }
        this.waiting.get(message.id)?.(result);
        this.waiting.delete(message.id);
        break;
      }
      case 'skipped':
        this.waiting.get(message.id)?.(null);
        this.waiting.delete(message.id);
        break;
      case 'error':
        if (message.id !== null) {
          this.waiting.get(message.id)?.(null);
          this.waiting.delete(message.id);
        }
        console.error('Analysis failed:', message.message);
        break;
    }
  }

  /** Start loading the engine without waiting for the first document. */
  start(): void {
    this.ensureWorker();
  }

  configure(settings: EngineSettings): void {
    this.settings = settings;
    if (this.worker) this.post({ type: 'configure', settings });
  }

  /** Analyze a document. Resolves with null if a newer request superseded this one. */
  analyze(request: AnalyzeRequest): Promise<AnalysisResult | null> {
    this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ type: 'analyze', id, request });
    });
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const analysisClient = new AnalysisClient();
