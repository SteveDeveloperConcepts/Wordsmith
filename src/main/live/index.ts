/**
 * The live overlay: underlines drawn over the message body in classic Outlook, or the page
 * in Word, as the writer types. Windows only. It is on unless the writer turns it off, and its helper runs only once
 * Outlook or Word has been in front.
 *
 * Wordsmith already looks at which window is in front for the Check Anywhere shortcut. While
 * that window belongs to Outlook or Word, this asks the accessibility helper
 * (helper/LiveHelper.cs) for the text of the message body or document, hands it to a
 * transparent window laid exactly over the text, and that window checks it with the usual
 * engine and draws the underlines. A fix selects the flagged words through the helper and
 * pastes over them, the way Check Anywhere replaces a selection. Nothing leaves the computer.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { BrowserWindow, screen, type Rectangle } from 'electron';
import {
  IPC,
  type LiveMeasurement,
  type LiveRange,
  type LiveRect,
  type LiveReplace,
  type LiveSettings,
  type LiveStatus,
  type LiveText,
  type QuickReplaceResult,
} from '@shared/api';
import { replaceSelection } from '../anywhere/capture';
import { electronClipboard } from '../anywhere/clipboard';
import { loadNative, type Native, type SourceWindow } from '../anywhere/native';
import * as store from '../store';

/** Apps whose text the helper can read: classic Outlook's message body and Word's page. */
const APPS = new Set(['Outlook', 'Word']);
/** How often the field under the overlay is read while the writer is typing or scrolling. */
const ACTIVE_INTERVAL = 150;
/** How often it is read once nothing has changed for a while. */
const CALM_INTERVAL = 300;
/** How long after the last change the faster rate continues. */
const BUSY_WINDOW = 3000;
/** How often the window in front is looked at while it is not Outlook or Word. */
const IDLE_INTERVAL = 400;
/** Run Wordsmith with WORDSMITH_LIVE_DEBUG=1 to log what the overlay reads, measures, and draws. */
export const LIVE_DEBUG = process.env.WORDSMITH_LIVE_DEBUG === '1';

function debug(message: string): void {
  if (LIVE_DEBUG) console.log(`[live] ${new Date().toISOString().slice(11, 23)} ${message}`);
}

/** The helper answers in a few milliseconds; a longer wait means it is stuck. */
const HELPER_TIMEOUT = 5000;

export interface LiveHost {
  /** Where the overlay's page lives. */
  url: string;
  preload: string;
  /** The compiled helper, resources/live-helper.exe. */
  helper: string;
  secure(window: BrowserWindow): void;
}

interface HelperReply {
  id: number;
  error?: string;
  ms?: number;
  [key: string]: unknown;
}

/** [x, y, width, height] in physical screen pixels, as the helper reports them. */
type Box = [number, number, number, number];

interface EditorReply extends HelperReply {
  found: boolean;
  text?: string;
  rect?: Box | null;
  focused?: boolean;
}

interface RectsReply extends HelperReply {
  rects: Array<{ rects: Array<Box | null>; text: string }>;
  changed?: boolean;
}

interface PollReply extends EditorReply {
  /** The first visible character's offset and position: it changes when the text scrolls. */
  probe?: unknown;
}

interface Session {
  /** Tells this field's text apart from the last one's. */
  field: number;
  hwnd: number;
  app: string;
  source: SourceWindow;
  text: string;
  /** The field's bounds in device-independent pixels, which is what the overlay window uses. */
  bounds: Rectangle;
  /** Where the first visible character was at the last reading, to notice scrolling. */
  probe: string;
  /** When the text, the field, or the scroll position last changed. */
  changedAt: number;
}

/** The helper process, spoken to one JSON line at a time. */
class Helper {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, (reply: HelperReply) => void>();

  constructor(private readonly path: string) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      for (const resolve of this.waiting.values()) resolve({ id: 0, error: `The helper stopped (${code}).` });
      this.waiting.clear();
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let reply: HelperReply;
      try {
        reply = JSON.parse(line) as HelperReply;
      } catch {
        return;
      }
      const resolve = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      resolve?.(reply);
    });
    this.child = child;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  ask<T extends HelperReply>(command: Record<string, unknown>): Promise<T> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.resolve({ id: 0, error: 'The helper is not running.' } as T);
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ id, error: 'The helper did not answer.' } as T);
      }, HELPER_TIMEOUT);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply as T);
      });
      child.stdin!.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }
}

export class LiveOverlay {
  private native: Native | null = null;
  private readonly helper: Helper;
  private window: BrowserWindow | null = null;
  private pageReady = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private session: Session | null = null;
  private generation = 0;
  private fields = 0;
  private quitting = false;

  constructor(private readonly host: LiveHost) {
    this.helper = new Helper(host.helper);
  }

  settings(): LiveSettings {
    // On unless the writer turned it off: anyone who switched it off keeps it off.
    return { enabled: true, ...store.get('live') };
  }

  get supported(): boolean {
    return process.platform === 'win32' && existsSync(this.host.helper);
  }

  status(): LiveStatus {
    return { ...this.settings(), supported: this.supported, active: this.session !== null };
  }

  async start(): Promise<void> {
    if (!this.supported || !this.settings().enabled || this.timer) return;
    this.native ??= await loadNative();
    if (!this.native) return;
    // The helper starts the first time Outlook or Word comes to the front, so people who use
    // neither never run it.
    this.schedule(IDLE_INTERVAL);
    debug('watching for Outlook and Word');
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deactivate();
    this.helper.stop();
  }

  update(patch: Partial<LiveSettings>): LiveStatus {
    const next = { ...this.settings(), ...patch };
    store.set('live', next);
    if (next.enabled) void this.start();
    else this.stop();
    return this.status();
  }

  prepareToQuit(): void {
    this.quitting = true;
    this.stop();
  }

  /* ---------- Following the window in front ---------- */

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.quitting) return;
    this.ticking = true;
    try {
      await this.look();
    } catch (err) {
      console.error('[live] tick failed:', err);
    } finally {
      this.ticking = false;
      if (this.timer !== null) this.schedule(this.interval());
    }
  }

  private interval(): number {
    if (!this.session) return IDLE_INTERVAL;
    return Date.now() - this.session.changedAt < BUSY_WINDOW ? ACTIVE_INTERVAL : CALM_INTERVAL;
  }

  private async look(): Promise<void> {
    const native = this.native;
    if (!native) return;
    // Asked in this process first, so that the helper is not asked anything, or even started,
    // while neither app is in front. The overlay never takes focus, so it is never in front itself.
    const front = native.frontmost();
    if (!front?.name || !APPS.has(front.name) || native.isOwn(front)) {
      this.deactivate();
      return;
    }
    if (!this.helper.running) this.helper.start();
    const where = await this.helper.ask<HelperReply & { hwnd?: number }>({ cmd: 'foreground' });
    if (where.error || typeof where.hwnd !== 'number') {
      this.deactivate();
      return;
    }
    if (this.session?.hwnd !== where.hwnd) {
      const editor = await this.helper.ask<EditorReply>({ cmd: 'editor', hwnd: where.hwnd });
      if (editor.error || !editor.found || typeof editor.text !== 'string' || !editor.rect) {
        this.deactivate();
        return;
      }
      debug(`${front.name} field found in ${editor.ms} ms, ${editor.text.length} characters`);
      this.activate({
        field: ++this.fields,
        hwnd: where.hwnd,
        app: front.name,
        source: front,
        text: editor.text,
        bounds: toDip(editor.rect),
        probe: '',
        changedAt: Date.now(),
      });
      return;
    }
    await this.follow(this.session);
  }

  /**
   * Read the field again. New text goes to the page; a field that moved, or text that scrolled,
   * has the page measure its underlines again. When nothing changed, nothing more is asked.
   */
  private async follow(session: Session): Promise<void> {
    const now = await this.helper.ask<PollReply>({ cmd: 'poll' });
    if (now.error || typeof now.text !== 'string' || !now.rect) {
      this.deactivate();
      return;
    }
    if ((now.ms ?? 0) > 40) debug(`reading the field took ${now.ms} ms`);
    const bounds = toDip(now.rect);
    const probe = JSON.stringify(now.probe ?? null);
    const moved = !sameRect(bounds, session.bounds) || probe !== session.probe;
    if (!sameRect(bounds, session.bounds)) {
      session.bounds = bounds;
      this.window?.setBounds(bounds);
    }
    session.probe = probe;
    if (now.text !== session.text) {
      session.text = now.text;
      session.changedAt = Date.now();
      this.sendText(session);
    } else if (moved) {
      session.changedAt = Date.now();
      this.window?.webContents.send(IPC.liveTick);
    }
  }

  private activate(session: Session): void {
    this.session = session;
    const window = this.ensureWindow();
    window.setBounds(session.bounds);
    this.sendText(session);
    if (!window.isVisible()) window.showInactive();
  }

  private deactivate(): void {
    if (!this.session) return;
    debug(`${this.session.app} field left`);
    this.session = null;
    this.window?.hide();
    this.window?.setIgnoreMouseEvents(true, { forward: true });
  }

  private sendText(session: Session): void {
    const update: LiveText = { generation: ++this.generation, field: session.field, app: session.app, text: session.text };
    if (this.pageReady) this.window?.webContents.send(IPC.liveText, update);
  }

  /* ---------- The overlay window ---------- */

  private ensureWindow(): BrowserWindow {
    if (this.window) return this.window;
    const window = new BrowserWindow({
      width: 400,
      height: 300,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Wordsmith',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.host.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.host.secure(window);
    // The pointer goes straight through to the app underneath, until it reaches an underline.
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
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

  /** The overlay's page says it is listening. */
  pageIsReady(sender: Electron.WebContents): void {
    if (sender !== this.window?.webContents) return;
    this.pageReady = true;
    if (this.session) this.sendText(this.session);
  }

  /** The pointer is over an underline or the card, so the overlay takes clicks; otherwise it lets them through. */
  setInteractive(on: boolean): void {
    this.window?.setIgnoreMouseEvents(!on, { forward: true });
  }

  /* ---------- Questions from the overlay's page ---------- */

  /** Where these character ranges are, in the overlay's own coordinates. Null when the field is gone. */
  async rects(ranges: LiveRange[], fingerprint: number): Promise<LiveMeasurement | null> {
    const session = this.session;
    if (!session) return null;
    if (ranges.length === 0) return { placements: [], stale: false };
    const reply = await this.helper.ask<RectsReply>({ cmd: 'rects', ranges, expect: fingerprint });
    if (reply.error || !Array.isArray(reply.rects)) return null;
    const drawn = reply.rects.filter((entry) => entry.rects.length > 0).length;
    debug(
      `measured ${drawn} of ${ranges.length} ranges in ${reply.ms} ms${reply.changed ? ', text changed meanwhile' : ''}`,
    );
    const origin = session.bounds;
    const placements = reply.rects.map((entry) => ({
      text: entry.text,
      rects: entry.rects
        .filter((box): box is Box => Array.isArray(box))
        .map((box) => toDip(box))
        .map((rect): LiveRect => ({ x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height })),
    }));
    return { placements, stale: reply.changed === true };
  }

  /** Select the flagged words in the app and paste the fix over them. */
  async replace(request: LiveReplace): Promise<QuickReplaceResult> {
    const session = this.session;
    const native = this.native;
    if (!session || !native) return { ok: false, reason: 'window-gone' };
    const selected = await this.helper.ask({ cmd: 'select', start: request.start, end: request.end });
    if (selected.error) {
      debug(`could not select ${request.start}-${request.end}: ${selected.error}`);
      return { ok: false, reason: 'selection-changed' };
    }
    const outcome = await replaceSelection(native, electronClipboard, session.source, request.original, { text: request.text, html: null });
    debug(`replace "${request.original}" with "${request.text}": ${outcome.ok ? 'done' : outcome.reason}`);
    return outcome;
  }
}

/** The helper reports physical pixels; Electron places windows in device-independent pixels. */
function toDip([x, y, width, height]: Box): Rectangle {
  const rect = screen.screenToDipRect(null, { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(Math.round(rect.width), 1), height: Math.max(Math.round(rect.height), 1) };
}

const sameRect = (a: Rectangle, b: Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
