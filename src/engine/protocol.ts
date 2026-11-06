/** Messages exchanged between the app and the analysis worker. */
import type { AnalysisResult, AnalyzeRequest, EngineSettings } from './types';

export type WorkerRequest =
  | { type: 'configure'; settings: EngineSettings }
  | { type: 'warm-up' }
  | { type: 'analyze'; id: number; request: AnalyzeRequest };

export type WorkerResponse =
  | { type: 'ready'; grammarEngineReady: boolean; engineError?: string }
  | { type: 'result'; id: number; result: AnalysisResult }
  | { type: 'skipped'; id: number }
  | { type: 'error'; id: number | null; message: string };
