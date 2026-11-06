/**
 * Check Anywhere: a global shortcut that takes the selected text from whichever
 * app is in front, checks it in a small floating window, and puts the corrected
 * text back. This is how Wordsmith works in desktop apps it has no add-in for.
 */
import { BrowserWindow, app, clipboard, globalShortcut, screen, shell, systemPreferences } from 'electron';
import {
  DEFAULT_ANYWHERE_SHORTCUT,
  IPC,
  type AnywhereSettings,
  type AnywhereStatus,
  type QuickCapture,
  type QuickReplaceResult,
  type QuickResult,
} from '@shared/api';
import * as store from '../store';
import { captureAll, captureSelection, replaceSelection, type CaptureResult } from './capture';
import { electronClipboard } from './clipboard';
import { loadNative, type Native, type SourceWindow } from './native';

const ACCESSIBILITY_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

const WINDOW_WIDTH = 580;
const WINDOW_HEIGHT = 460;
/** Keep the window a little clear of the pointer and the screen's edges. */
const WINDOW_MARGIN = 12;

export interface AnywhereHost {
  /** Where the quick window's page lives. */
  url: string;
  preload: string;
  backgroundColor(): string;
  /** Called when a menu needs to show a different shortcut. */
  onChange(): void;
  /** Open the text as a document in the main window. */
  openInApp(text: string): void;
  /** Keep this window from navigating or opening anything. */
  secure(window: BrowserWindow): void;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

export class CheckAnywhere {
  private native: Native | null = null;
  private window: BrowserWindow | null = null;
  private pageReady = false;
  private queued: QuickCapture | null = null;
  private source: SourceWindow | null = null;
  /** The selection as it was copied, for checking that it has not changed before pasting. */
  private original = '';
  private busy = false;
  private nextId = 1;
  private registered: string | null = null;
  private quitting = false;

  constructor(private readonly host: AnywhereHost) {}

  settings(): AnywhereSettings {
    return { enabled: true, shortcut: DEFAULT_ANYWHERE_SHORTCUT, launchAtLogin: false, ...store.get('anywhere') };
  }

  /** The app stays running after its window closes only if there is a shortcut to serve. */
  get keepsRunning(): boolean {
    return this.settings().enabled;
  }

  get shortcut(): string | null {
    return this.registered;
  }

  async start(): Promise<void> {
    this.native = await loadNative();
    this.applyShortcut();
  }

  /** Build the window ahead of the first use, so the engine is warm when it is needed. */
  prepare(): void {
    if (this.settings().enabled) this.ensureWindow();
  }

  prepareToQuit(): void {
    this.quitting = true;
  }

  status(): AnywhereStatus {
    return {
      ...this.settings(),
      activeShortcut: this.registered,
      supported: this.native !== null,
      canControlApps: this.canControlApps(),
    };
  }

  update(patch: Partial<AnywhereSettings>): AnywhereStatus {
    const next = { ...this.settings(), ...patch };
    store.set('anywhere', next);
    if (patch.launchAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
    }
    this.applyShortcut();
    if (next.enabled) this.ensureWindow();
    return this.status();
  }

  /** On macOS, pressing keys in another app needs a permission only the writer can grant. */
  private canControlApps(): boolean {
    return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
  }

  requestAppControl(): boolean {
    if (process.platform !== 'darwin') return true;
    const trusted = systemPreferences.isTrustedAccessibilityClient(true);
    if (!trusted) void shell.openExternal(ACCESSIBILITY_SETTINGS);
    return trusted;
  }

  private applyShortcut(): void {
    if (this.registered) globalShortcut.unregister(this.registered);
    this.registered = null;
    const { enabled, shortcut } = this.settings();
    if (enabled) {
      try {
        if (globalShortcut.register(shortcut, () => void this.trigger())) this.registered = shortcut;
      } catch (err) {
        console.error(`Could not register the shortcut ${shortcut}:`, err);
      }
    }
    this.host.onChange();
  }

  /* ---------- The window ---------- */

  private ensureWindow(): BrowserWindow {
    if (this.window) return this.window;
    const mac = process.platform === 'darwin';
    const window = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: 420,
      minHeight: 300,
      show: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Wordsmith',
      // A panel takes the keyboard without pulling the writer out of the app they are in.
      type: mac ? 'panel' : undefined,
      backgroundColor: this.host.backgroundColor(),
      webPreferences: {
        preload: this.host.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    if (mac) window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.host.secure(window);

    // The shortcut needs this window ready at any moment, so closing only hides it.
    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    window.on('closed', () => {
      this.window = null;
      this.pageReady = false;
    });
    window.webContents.on('did-start-loading', () => {
      this.pageReady = false;
    });
    void window.loadURL(this.host.url);
    this.window = window;
    return window;
  }

  /** The quick window's page says it is listening. */
  pageIsReady(sender: Electron.WebContents): void {
    if (sender !== this.window?.webContents) return;
    this.pageReady = true;
    if (this.queued) {
      sender.send(IPC.quickCapture, this.queued);
      this.queued = null;
    }
  }

  private place(window: BrowserWindow): void {
    const pointer = screen.getCursorScreenPoint();
    const { x, y, width, height } = screen.getDisplayNearestPoint(pointer).workArea;
    const size = window.getBounds();
    const left = clamp(pointer.x - size.width / 2, x + WINDOW_MARGIN, x + width - size.width - WINDOW_MARGIN);
    // Below the pointer if it fits, so the window does not cover the text being checked.
    const below = pointer.y + WINDOW_MARGIN * 2;
    const top = below + size.height <= y + height ? below : pointer.y - size.height - WINDOW_MARGIN * 2;
    window.setPosition(Math.round(left), Math.round(clamp(top, y + WINDOW_MARGIN, y + height - size.height - WINDOW_MARGIN)));
  }

  private present(capture: Omit<QuickCapture, 'id'>): void {
    const window = this.ensureWindow();
    const payload: QuickCapture = { ...capture, id: this.nextId++ };
    if (this.pageReady) window.webContents.send(IPC.quickCapture, payload);
    else this.queued = payload;
    if (!window.isVisible()) this.place(window);
    window.show();
    window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  /* ---------- Capturing ---------- */

  private async exclusive(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await work();
    } catch (err) {
      console.error('Check Anywhere failed:', err);
    } finally {
      this.busy = false;
    }
  }

  /** The shortcut was pressed, or the menu item chosen. */
  trigger(): Promise<void> {
    return this.exclusive(async () => {
      if (this.window?.isVisible() && this.window.isFocused()) {
        this.hide();
        return;
      }
      if (!this.native || !this.canControlApps()) {
        await this.presentClipboard(this.native ? 'needs-permission' : 'clipboard');
        return;
      }
      const source = this.native.frontmost();
      if (!source || this.native.isOwn(source)) {
        await this.presentClipboard('clipboard');
        return;
      }
      this.source = source;
      this.presentCapture(source, await captureSelection(this.native, electronClipboard));
    });
  }

  private presentCapture(source: SourceWindow, result: CaptureResult): void {
    if (result.kind === 'text') {
      this.original = result.content.text;
      this.present({ ...result.content, source: source.name, state: 'selection' });
    } else {
      this.original = '';
      this.present({ text: '', html: null, source: source.name, state: 'nothing-selected' });
    }
  }

  private async presentClipboard(state: 'clipboard' | 'needs-permission'): Promise<void> {
    this.source = null;
    this.original = '';
    this.present({ text: await clipboard.readText(), html: null, source: null, state });
  }

  /** Nothing was selected and the writer asked to check the whole field. */
  checkAll(): Promise<void> {
    return this.exclusive(async () => {
      const { native, source } = this;
      if (!native || !source) return;
      native.focus(source);
      this.hide();
      this.presentCapture(source, await captureAll(native, electronClipboard, source));
    });
  }

  /** Check whatever is on the clipboard, with nowhere to paste it back. */
  useClipboard(): Promise<void> {
    return this.exclusive(() => this.presentClipboard('clipboard'));
  }

  /* ---------- Writing back ---------- */

  async replace(result: QuickResult): Promise<QuickReplaceResult> {
    const { native, source, original } = this;
    if (!native || !source || this.busy) return { ok: false, reason: 'window-gone' };
    this.busy = true;
    try {
      // While this app still has focus it may hand focus over. Once hidden it may not.
      native.focus(source);
      this.hide();
      const outcome = await replaceSelection(native, electronClipboard, source, original, result);
      if (outcome.ok) {
        this.source = null;
      } else {
        this.window?.show();
        this.window?.focus();
      }
      return outcome;
    } finally {
      this.busy = false;
    }
  }

  openInApp(text: string): void {
    this.hide();
    this.host.openInApp(text);
  }

  themeChanged(): void {
    this.window?.setBackgroundColor(this.host.backgroundColor());
  }
}
