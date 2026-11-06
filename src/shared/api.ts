/**
 * The contract between the desktop shell (Electron main process) and the app UI.
 * The preload script exposes an implementation as `window.wordsmith`; in a plain
 * browser it is absent and the UI falls back to web equivalents.
 */
import type { AiErrorInfo, AiRequest, AiResult } from './ai-types';

export type Platform = 'darwin' | 'win32' | 'linux' | 'web';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface AppInfo {
  platform: Platform;
  version: string;
}

/** Ctrl+Alt+W, or Control+Option+W on a Mac. Alt+Shift would collide with switching keyboard layouts. */
export const DEFAULT_ANYWHERE_SHORTCUT = 'Control+Alt+W';

export interface AnywhereSettings {
  enabled: boolean;
  /** An Electron accelerator. */
  shortcut: string;
  launchAtLogin: boolean;
}

export interface AnywhereStatus extends AnywhereSettings {
  /** The shortcut in force. Null if it is off, or another app already has it. */
  activeShortcut: string | null;
  /** This platform can read selections from other apps. */
  supported: boolean;
  /** macOS only: the Accessibility permission has been granted. */
  canControlApps: boolean;
}

export type QuickState =
  /** Text was copied from the app in front. */
  | 'selection'
  /** The app in front did not hand over any text. */
  | 'nothing-selected'
  /** Text came from the clipboard, so there is nowhere to paste it back. */
  | 'clipboard'
  /** macOS has not granted the permission needed to read a selection. */
  | 'needs-permission';

export interface QuickCapture {
  id: number;
  state: QuickState;
  /** The app the text came from, such as "Outlook". */
  source: string | null;
  text: string;
  /** The rich version, when the app put one on the clipboard. */
  html: string | null;
}

export interface QuickResult {
  text: string;
  html: string | null;
}

export type QuickReplaceResult = { ok: true } | { ok: false; reason: 'window-gone' | 'selection-changed' | 'paste-failed' };

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

export interface SaveFileRequest {
  defaultName: string;
  /** Shown in the save dialog's file-type list, e.g. "Word document". */
  description: string;
  extensions: string[];
  data: Uint8Array;
}

export interface SaveResult {
  saved: boolean;
  path?: string;
}

export type MenuAction =
  | 'new-document'
  | 'import'
  | 'export-docx'
  | 'export-pdf'
  | 'export-html'
  | 'export-md'
  | 'export-txt'
  | 'open-in-word'
  | 'email-document'
  | 'print'
  | 'settings'
  | 'goals'
  | 'toggle-library'
  | 'toggle-assistant'
  | 'show-review'
  | 'show-insights'
  | 'show-ai'
  | 'copy-document'
  | 'undo'
  | 'redo';

export type AiEvent =
  | { id: string; type: 'text'; delta: string }
  | { id: string; type: 'done'; result: AiResult }
  | { id: string; type: 'error'; error: AiErrorInfo };

export interface DesktopBridge {
  info(): Promise<AppInfo>;
  /** Tell the shell the UI is listening, so it can deliver anything it queued during startup. */
  notifyReady(): void;

  pickFiles(): Promise<PickedFile[]>;
  saveFile(request: SaveFileRequest): Promise<SaveResult>;
  /** Render the current window with the print stylesheet and save it as a PDF. */
  savePdf(defaultName: string): Promise<SaveResult>;
  print(): Promise<void>;
  /**
   * Save a .docx or .eml to a temporary folder and open it in the app the system
   * uses for that type, such as Word or Outlook. Resolves with an error message, or
   * an empty string if it opened.
   */
  openInDefaultApp(name: string, data: Uint8Array): Promise<string>;

  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setTheme(theme: ThemeChoice): Promise<void>;

  anywhereStatus(): Promise<AnywhereStatus>;
  setAnywhere(patch: Partial<AnywhereSettings>): Promise<AnywhereStatus>;
  /** macOS: ask for the Accessibility permission. Resolves true if it is already granted. */
  requestAppControl(): Promise<boolean>;

  /** The quick window is listening for captures. */
  quickReady(): void;
  quickReplace(result: QuickResult): Promise<QuickReplaceResult>;
  /** Select everything in the field that had focus, and check that. */
  quickCheckAll(): Promise<void>;
  quickUseClipboard(): Promise<void>;
  quickClose(): Promise<void>;
  /** Open the text as a new document in the main window. */
  quickOpenInApp(text: string): Promise<void>;

  aiHasKey(): Promise<boolean>;
  /** Store the API key encrypted with the operating system's credential protection. */
  aiSetKey(key: string): Promise<void>;
  aiClearKey(): Promise<void>;
  aiStart(id: string, model: string, request: AiRequest): Promise<void>;
  aiCancel(id: string): Promise<void>;

  onAiEvent(listener: (event: AiEvent) => void): () => void;
  onMenu(listener: (action: MenuAction) => void): () => void;
  /** Text from the quick window, to open as a new document. */
  onOpenText(listener: (text: string) => void): () => void;
  /** New text for the quick window to check. */
  onQuickCapture(listener: (capture: QuickCapture) => void): () => void;
  /** Files opened from the operating system (dropped on the app icon, "Open with"). */
  onOpenFiles(listener: (files: PickedFile[]) => void): () => void;
}

declare global {
  interface Window {
    wordsmith?: DesktopBridge;
  }
}

/** IPC channel names, shared so the two sides cannot drift apart. */
export const IPC = {
  info: 'app:info',
  pickFiles: 'files:pick',
  saveFile: 'files:save',
  savePdf: 'files:save-pdf',
  openInDefaultApp: 'files:open-in-default-app',
  print: 'app:print',
  readClipboard: 'clipboard:read',
  writeClipboard: 'clipboard:write',
  openExternal: 'app:open-external',
  setTheme: 'app:set-theme',
  anywhereStatus: 'anywhere:status',
  setAnywhere: 'anywhere:set',
  requestAppControl: 'anywhere:request-app-control',
  quickReady: 'quick:ready',
  quickCapture: 'quick:capture',
  quickReplace: 'quick:replace',
  quickCheckAll: 'quick:check-all',
  quickUseClipboard: 'quick:use-clipboard',
  quickClose: 'quick:close',
  quickOpenInApp: 'quick:open-in-app',
  aiHasKey: 'ai:has-key',
  aiSetKey: 'ai:set-key',
  aiClearKey: 'ai:clear-key',
  aiStart: 'ai:start',
  aiCancel: 'ai:cancel',
  aiEvent: 'ai:event',
  menu: 'menu:action',
  openText: 'app:open-text',
  openFiles: 'app:open-files',
  rendererReady: 'app:renderer-ready',
} as const;
