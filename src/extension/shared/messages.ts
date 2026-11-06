/**
 * Messages between the extension's parts. A runtime message reaches every
 * extension context, so each one names its target and the others ignore it.
 */
import type { AnalyzeRequest, EngineSettings, Issue } from '@engine/types';

/** A content script asks for one field to be checked. */
export interface AnalyzeMessage {
  target: 'background';
  type: 'analyze';
  fieldId: number;
  request: AnalyzeRequest;
}

/** The offscreen document has been unused for a while and offers to be closed. */
export interface OffscreenIdleMessage {
  target: 'background';
  type: 'offscreen-idle';
}

export type BackgroundMessage = AnalyzeMessage | OffscreenIdleMessage;

/** The service worker passes a check on to the engine, with the settings to run it under. */
export interface OffscreenAnalyzeMessage {
  target: 'offscreen';
  type: 'analyze';
  /** One tab, frame, and field. A newer request with the same key replaces an older one. */
  key: string;
  settings: EngineSettings;
  request: AnalyzeRequest;
}

export type AnalyzeReply =
  | { status: 'done'; issues: Issue[]; grammarEngineReady: boolean; engineError?: string }
  | { status: 'superseded' }
  | { status: 'failed'; message: string };
