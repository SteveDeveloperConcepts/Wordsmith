/**
 * What the pane needs from an Office application. Each application gets one
 * implementation, so the pane never touches an Office API itself.
 */
import type { Block, Fix, Goals, Issue } from '@engine/types';

export type HostKind = 'word' | 'outlook' | 'powerpoint' | 'excel';

export interface Notice {
  id: string;
  text: string;
  /** "warn" asks the writer to look at something; "info" explains how fixes behave here. */
  tone: 'info' | 'warn';
}

export interface Snapshot {
  blocks: Block[];
  notices: Notice[];
  /** Block the cursor is in, so a half-typed word is not flagged. */
  caretBlock?: number;
  /** Why there is nothing to check, in words the pane can show as they are. */
  empty?: string;
  /** Suggestions can be read but not applied. A notice says why. */
  readOnly?: boolean;
}

export type Outcome =
  | { ok: true }
  | {
      ok: false;
      /**
       * "stale": the text moved on, so the pane has to check again.
       * "refused": the text is where it was, but changing it from here would do harm.
       * "failed": Office turned the request down.
       */
      kind: 'stale' | 'refused' | 'failed';
      message: string;
    };

export interface Host {
  readonly kind: HostKind;
  readonly name: string;
  /** Keeps itself current. Otherwise the pane waits for the writer to ask. */
  readonly live: boolean;
  /** Can move the application's own selection to a suggestion. */
  readonly canSelect: boolean;
  /** Shortest wait between looks for changes, in milliseconds. */
  readonly pollMs: number;
  goals(base: Goals): Goals;
  read(): Promise<Snapshot>;
  /** A cheap value that changes when the text does. */
  fingerprint(): Promise<string>;
  apply(issue: Issue, fix: Fix): Promise<Outcome>;
  select(issue: Issue): Promise<Outcome>;
  /** For applications whose own undo cannot take a fix back. */
  undo?(): Promise<Outcome>;
  canUndo?(): boolean;
  loadDismissed(): Promise<string[]>;
  saveDismissed(ids: string[]): Promise<void>;
  /** Tells the pane the document was swapped out from under it. Returns a way to stop listening. */
  onItemChange?(listener: () => void): () => void;
}

/** Thrown inside a host to end an operation with a particular outcome. */
export class Stop extends Error {
  constructor(readonly outcome: Extract<Outcome, { ok: false }>) {
    super(outcome.message);
  }
}

export const stale = (message: string) => new Stop({ ok: false, kind: 'stale', message });
export const refused = (message: string) => new Stop({ ok: false, kind: 'refused', message });

/**
 * An issue from an earlier check can reach a host after a newer read. Its offsets
 * mean nothing against different text, so it has to match before anything is touched.
 */
export function stillFits(blocks: Block[], issue: Issue): boolean {
  return blocks[issue.block]?.text.slice(issue.from, issue.to) === issue.text;
}

/**
 * Finds a block again after the text around it may have moved. Copies of the same
 * text are told apart by their order, which only holds if none came or went, so the
 * position alone is never trusted: a paragraph added above would slide the wrong copy
 * into place.
 */
export function findAgain<T>(items: T[], textOf: (item: T) => string, was: string[], index: number): T | null {
  const text = was[index];
  const same = items.filter((item) => textOf(item) === text);
  if (same.length !== was.filter((other) => other === text).length) return null;
  return same[was.slice(0, index).filter((other) => other === text).length];
}

export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}
