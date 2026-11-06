/**
 * Reading the selection out of another app and pasting a corrected version back,
 * using the same keystrokes a person would. The clipboard is the only channel
 * that works in every app, so it is borrowed briefly and put back afterwards.
 */
import type { Native, SourceWindow } from './native';

export interface ClipboardContent {
  text: string;
  html: string | null;
}

/** The parts of the clipboard this module needs. Everything on it is saved opaquely. */
export interface ClipboardPort<Snapshot = unknown> {
  save(): Promise<Snapshot>;
  restore(snapshot: Snapshot): Promise<void>;
  read(): Promise<ClipboardContent>;
  /** Write text that should stay out of clipboard history. */
  write(content: ClipboardContent): Promise<void>;
}

/** How long the writer may take to let go of the shortcut. */
const MODIFIER_TIMEOUT = 1000;
/** How long an app may take to answer Ctrl+C. Word can take a while on a long selection. */
const COPY_TIMEOUT = 700;
/** Some apps add formats a moment after the first one. */
const COPY_SETTLE = 40;
/** How long a window may take to come forward. */
const FOCUS_TIMEOUT = 800;
/** Time for keyboard focus to land inside the window, after the window itself is in front. */
const FOCUS_SETTLE = 80;
/**
 * For a moment after a write, the system and any clipboard managers are reading the
 * clipboard. An app that tries to paste then gets nothing and says nothing, so Ctrl+V
 * has to wait. Without this, about one paste in three failed in testing.
 */
const PASTE_DELAY = 100;
const PASTE_TRIES = 3;
/** Apps read the clipboard after they see Ctrl+V, so it must stay put for a moment. */
const PASTE_SETTLE = 450;
/** A failed paste leaves the selection in place, and copying it answers quickly. */
const VERIFY_TIMEOUT = 250;
const POLL_INTERVAL = 15;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL);
  }
  return true;
}

/** Press Ctrl+C and return what the app put on the clipboard, or null if it did not respond. */
async function pressAndRead<S>(
  native: Native,
  clipboard: ClipboardPort<S>,
  timeout = COPY_TIMEOUT,
): Promise<ClipboardContent | null> {
  const stamp = native.clipboardStamp();
  native.pressCopy();
  if (!(await waitFor(() => native.clipboardStamp() !== stamp, timeout))) return null;
  await sleep(COPY_SETTLE);
  return clipboard.read();
}

export type CaptureResult =
  | { kind: 'text'; content: ClipboardContent }
  /** The app did not answer: nothing is selected, or it does not allow copying. */
  | { kind: 'nothing' }
  /** The writer never let go of the keys, so a simulated Ctrl+C would have misfired. */
  | { kind: 'keys-held' };

/** Copy the selection in the app in front, leaving the clipboard as it was. */
export async function captureSelection<S>(native: Native, clipboard: ClipboardPort<S>): Promise<CaptureResult> {
  if (!(await waitFor(native.modifiersUp, MODIFIER_TIMEOUT))) return { kind: 'keys-held' };
  const saved = await clipboard.save();
  const stamp = native.clipboardStamp();
  try {
    const content = await pressAndRead(native, clipboard);
    if (!content) return { kind: 'nothing' };
    if (!content.text.trim()) return { kind: 'nothing' };
    return { kind: 'text', content };
  } finally {
    if (native.clipboardStamp() !== stamp) await clipboard.restore(saved);
  }
}

async function bringForward(native: Native, source: SourceWindow): Promise<boolean> {
  // A refusal does not matter if the app is in front anyway, as on a Mac, where the
  // floating panel never took the app's place.
  if (!native.focus(source) && !native.isFrontmost(source)) return false;
  if (!(await waitFor(() => native.isFrontmost(source), FOCUS_TIMEOUT))) return false;
  await sleep(FOCUS_SETTLE);
  return true;
}

/** Select everything in the field that has focus in the app, and copy it. */
export async function captureAll<S>(
  native: Native,
  clipboard: ClipboardPort<S>,
  source: SourceWindow,
): Promise<CaptureResult> {
  if (!(await bringForward(native, source))) return { kind: 'nothing' };
  native.pressSelectAll();
  await sleep(COPY_SETTLE);
  return captureSelection(native, clipboard);
}

export type ReplaceFailure =
  /** The app was closed, or would not come forward. */
  | 'window-gone'
  /** The selection is no longer what was checked, so pasting would overwrite the wrong text. */
  | 'selection-changed'
  /** The app did not take the paste, and the original text is still there. */
  | 'paste-failed';

export type ReplaceResult = { ok: true } | { ok: false; reason: ReplaceFailure };

/** Apps differ in the whitespace they copy, and that does not make it different text. */
const comparable = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Stricter, because a fix may change nothing but whitespace. */
const sameText = (a: string, b: string) => a.replace(/\r\n?/g, '\n').trimEnd() === b.replace(/\r\n?/g, '\n').trimEnd();

type PasteResult = 'pasted' | 'failed' | 'clipboard-taken';

/**
 * Paste, and make sure it happened. No app reports a failed paste, but a paste that
 * worked replaces the selection, so copying again either gets nothing or gets
 * something new. Getting the original back means it is still sitting there selected.
 */
async function pasteOver<S>(
  native: Native,
  clipboard: ClipboardPort<S>,
  original: string,
  replacement: ClipboardContent,
): Promise<PasteResult> {
  for (let attempt = 1; attempt <= PASTE_TRIES; attempt++) {
    await clipboard.write(replacement);
    await sleep(PASTE_DELAY * attempt);
    const stamp = native.clipboardStamp();
    native.pressPaste();
    await sleep(PASTE_SETTLE);
    // Only the writer could have changed the clipboard just now, and that wins.
    if (native.clipboardStamp() !== stamp) return 'clipboard-taken';
    const after = await pressAndRead(native, clipboard, VERIFY_TIMEOUT);
    if (!after || !sameText(after.text, original)) return 'pasted';
  }
  return 'failed';
}

/**
 * Paste corrected text over the original selection. Before pasting it copies the
 * selection again: if the writer clicked elsewhere meanwhile, a blind paste would
 * replace the wrong text, which is far worse than doing nothing.
 */
export async function replaceSelection<S>(
  native: Native,
  clipboard: ClipboardPort<S>,
  source: SourceWindow,
  original: string,
  replacement: ClipboardContent,
): Promise<ReplaceResult> {
  if (!(await bringForward(native, source))) return { ok: false, reason: 'window-gone' };
  if (!(await waitFor(native.modifiersUp, MODIFIER_TIMEOUT))) return { ok: false, reason: 'selection-changed' };

  const saved = await clipboard.save();
  const current = await pressAndRead(native, clipboard);
  if (!current || comparable(current.text) !== comparable(original)) {
    await clipboard.restore(saved);
    return { ok: false, reason: 'selection-changed' };
  }

  // Nothing changed, and a paste of the same text could not be told from a failed one.
  if (sameText(replacement.text, original)) {
    await clipboard.restore(saved);
    return { ok: true };
  }

  const outcome = await pasteOver(native, clipboard, original, replacement);
  if (outcome !== 'clipboard-taken') await clipboard.restore(saved);
  return outcome === 'failed' ? { ok: false, reason: 'paste-failed' } : { ok: true };
}
