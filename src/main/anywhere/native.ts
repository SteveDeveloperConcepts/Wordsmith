/**
 * What Check Anywhere needs from the operating system. Each platform implements
 * this with direct system calls; capture.ts holds the logic and stays testable.
 */

export interface SourceWindow {
  /** What to call the app in the UI, such as "Outlook". */
  name: string | null;
  /** Identifies the window to the platform layer: a window handle or a process id. */
  handle: unknown;
  /** In a terminal Ctrl+C stops the running program, so no keys may be pressed there. */
  terminal?: boolean;
}

export interface Native {
  /** The window with keyboard focus right now. */
  frontmost(): SourceWindow | null;
  /** Is it this very window, and still in front? */
  isFrontmost(source: SourceWindow): boolean;
  /** Does this window belong to Wordsmith itself? */
  isOwn(source: SourceWindow): boolean;
  /** Ask the system to give this window keyboard focus again. */
  focus(source: SourceWindow): boolean;
  /** False while the writer still holds Ctrl, Alt, Shift, or a similar key. */
  modifiersUp(): boolean;
  /** A number that changes whenever anything writes to the clipboard. */
  clipboardStamp(): number;
  pressCopy(): void;
  pressPaste(): void;
  pressSelectAll(): void;
}

const APP_NAMES: Record<string, string> = {
  acrobat: 'Acrobat',
  chrome: 'Chrome',
  code: 'VS Code',
  discord: 'Discord',
  excel: 'Excel',
  firefox: 'Firefox',
  mailspring: 'Mailspring',
  'ms-teams': 'Teams',
  msedge: 'Edge',
  notepad: 'Notepad',
  obsidian: 'Obsidian',
  olk: 'Outlook',
  onenote: 'OneNote',
  outlook: 'Outlook',
  powerpnt: 'PowerPoint',
  slack: 'Slack',
  teams: 'Teams',
  thunderbird: 'Thunderbird',
  winword: 'Word',
  wordpad: 'WordPad',
};

/** Turn a program's file path into the name people know it by. */
export function friendlyAppName(path: string | null): string | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? '';
  if (!base) return null;
  return APP_NAMES[base.toLowerCase()] ?? base.charAt(0).toUpperCase() + base.slice(1);
}

/** Null where the platform is unsupported, or the system libraries could not be loaded. */
export async function loadNative(): Promise<Native | null> {
  try {
    if (process.platform === 'win32') return (await import('./windows')).createWindowsNative();
    if (process.platform === 'darwin') return (await import('./mac')).createMacNative();
  } catch (err) {
    console.error('Check Anywhere could not load its system library:', err);
  }
  return null;
}
