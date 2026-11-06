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
  /** Human-readable global shortcut for "check clipboard", or null if it could not be registered. */
  quickCheckShortcut: string | null;
}

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

  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  setTheme(theme: ThemeChoice): Promise<void>;
  /** Turn the global "check clipboard" shortcut on or off. Resolves with the shortcut if it is active. */
  setQuickCheck(enabled: boolean): Promise<string | null>;

  aiHasKey(): Promise<boolean>;
  /** Store the API key encrypted with the operating system's credential protection. */
  aiSetKey(key: string): Promise<void>;
  aiClearKey(): Promise<void>;
  aiStart(id: string, model: string, request: AiRequest): Promise<void>;
  aiCancel(id: string): Promise<void>;

  onAiEvent(listener: (event: AiEvent) => void): () => void;
  onMenu(listener: (action: MenuAction) => void): () => void;
  /** Text handed over by the tray menu or the global shortcut for a quick check. */
  onQuickCheck(listener: (text: string) => void): () => void;
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
  print: 'app:print',
  readClipboard: 'clipboard:read',
  writeClipboard: 'clipboard:write',
  openExternal: 'app:open-external',
  setTheme: 'app:set-theme',
  setQuickCheck: 'app:set-quick-check',
  aiHasKey: 'ai:has-key',
  aiSetKey: 'ai:set-key',
  aiClearKey: 'ai:clear-key',
  aiStart: 'ai:start',
  aiCancel: 'ai:cancel',
  aiEvent: 'ai:event',
  menu: 'menu:action',
  quickCheck: 'app:quick-check',
  openFiles: 'app:open-files',
  rendererReady: 'app:renderer-ready',
} as const;
