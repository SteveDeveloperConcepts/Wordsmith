/**
 * Shares one analysis worker between every field in every tab.
 *
 * The worker skips any request older than the newest it has seen, which suits one
 * document but would starve a tab whenever another tab asked after it. So only one
 * request goes to the worker at a time, and "newer replaces older" is applied here,
 * per field, where it is safe.
 */
import type { WorkerRequest, WorkerResponse } from '@engine/protocol';
import type { AnalyzeRequest, EngineSettings } from '@engine/types';
import type { AnalyzeReply } from '../shared/messages';

export interface Job {
  key: string;
  settings: EngineSettings;
  request: AnalyzeRequest;
  reply(reply: AnalyzeReply): void;
}

export class EngineQueue {
  private readonly waiting = new Map<string, Job>();
  private running: { id: number; job: Job } | null = null;
  private applied = '';
  private nextId = 1;

  constructor(private readonly post: (message: WorkerRequest) => void) {}

  get idle(): boolean {
    return this.running === null && this.waiting.size === 0;
  }

  submit(job: Job): void {
    this.waiting.get(job.key)?.reply({ status: 'superseded' });
    this.waiting.delete(job.key);
    this.waiting.set(job.key, job);
    this.next();
  }

  receive(message: WorkerResponse): void {
    if (message.type === 'ready' || message.id === null || message.id !== this.running?.id) return;
    const { job } = this.running;
    this.running = null;
    switch (message.type) {
      case 'result': {
        const { issues, grammarEngineReady, engineError } = message.result;
        job.reply({ status: 'done', issues, grammarEngineReady, engineError });
        break;
      }
      case 'skipped':
        job.reply({ status: 'superseded' });
        break;
      case 'error':
        job.reply({ status: 'failed', message: message.message });
        break;
    }
    this.next();
  }

  /** The worker died. Everything it held is lost, and the next job starts a new one. */
  workerFailed(message: string): void {
    this.running?.job.reply({ status: 'failed', message });
    this.running = null;
    this.applied = '';
    this.next();
  }

  private next(): void {
    if (this.running) return;
    const job = this.waiting.values().next().value;
    if (!job) return;
    this.waiting.delete(job.key);

    const id = this.nextId++;
    this.running = { id, job };
    // Settings travel with every job, so a restarted service worker or a new
    // offscreen document cannot leave the engine on old settings.
    const settings = JSON.stringify(job.settings);
    if (settings !== this.applied) {
      this.applied = settings;
      this.post({ type: 'configure', settings: job.settings });
    }
    this.post({ type: 'analyze', id, request: job.request });
  }
}
