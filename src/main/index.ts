/**
 * Wordsmith desktop shell (Electron main process).
 *
 * The UI is a sandboxed page with no Node access. In packaged builds it is served
 * from a private `app://` scheme with a strict Content-Security-Policy; everything
 * that needs the operating system goes through the small IPC surface below.
 */
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import type { AiRequest } from '@shared/ai-types';
import {
  IPC,
  type AnywhereSettings,
  type AppInfo,
  type MenuAction,
  type PickedFile,
  type QuickResult,
  type SaveFileRequest,
  type SaveResult,
  type ThemeChoice,
} from '@shared/api';
import * as ai from './ai';
import { CheckAnywhere } from './anywhere';
import { buildMenu } from './menu';
import * as store from './store';

const SCHEME = 'app';
const HOST = 'wordsmith';
const DEV_URL = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const RENDERER_ROOT = join(__dirname, '../renderer');
const PRELOAD = join(__dirname, '../preload/index.js');
const IMPORT_EXTENSIONS = ['docx', 'txt', 'md', 'markdown', 'html', 'htm'];
/** Only documents with no way to run code on opening may be handed to the system. */
const OPENABLE_EXTENSIONS = ['.docx', '.eml'];
/** Given to the app when it starts at login, when it should wait quietly in the tray. */
const HIDDEN_FLAG = '--hidden';
const QUICK_WINDOW_DELAY = 3000;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let rendererReady = false;
/** Deliveries that arrived before the UI was listening. */
const pending: Array<() => void> = [];

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

/* ------------------------------------------------------------------ */
/* Serving the UI                                                      */
/* ------------------------------------------------------------------ */

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const file = normalize(join(RENDERER_ROOT, pathname));
    // Never serve anything outside the bundled UI folder.
    if (!file.startsWith(RENDERER_ROOT + sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const headers: Record<string, string> = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' };
      if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
      return new Response(new Uint8Array(body), { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const appUrl = () => DEV_URL ?? `${SCHEME}://${HOST}/index.html`;
const quickUrl = () => `${appUrl()}?view=quick`;

/** Only our own page may call the IPC handlers. */
function trusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith(`${SCHEME}://${HOST}/`);
}

function isSafeExternal(url: string): boolean {
  try {
    const { protocol: p } = new URL(url);
    return p === 'https:' || p === 'http:' || p === 'mailto:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

const resourcePath = (name: string) =>
  app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(__dirname, '../../resources', name);

const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#14161a' : '#f6f5f1');

/** External links open in the user's browser; app windows never navigate away. */
function secureWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });
}

function createWindow(): BrowserWindow {
  const saved = store.get('window');
  const iconFile = resourcePath('icon.png');
  const window = new BrowserWindow({
    width: saved?.width ?? 1320,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'Wordsmith',
    backgroundColor: windowBackground(),
    icon: process.platform === 'linux' && existsSync(iconFile) ? iconFile : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Wordsmith does its own checking; the built-in squiggles would only compete.
      spellcheck: false,
    },
  });
  if (saved?.maximized) window.maximize();

  window.once('ready-to-show', () => window.show());

  const remember = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const maximized = window.isMaximized();
    const bounds = maximized ? (store.get('window') ?? window.getNormalBounds()) : window.getBounds();
    store.set('window', { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized });
  };
  window.on('close', remember);

  secureWindow(window);
  window.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
  window.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    afterMainWindowClosed();
  });

  void window.loadURL(appUrl());
  return window;
}

/** With the shortcut in use the app stays in the tray, so that the shortcut keeps working. */
function afterMainWindowClosed(): void {
  if (process.platform === 'darwin') return;
  if (!tray || !anywhere.keepsRunning) {
    app.quit();
    return;
  }
  if (store.get('trayExplained')) return;
  store.set('trayExplained', true);
  tray.displayBalloon({
    title: 'Wordsmith is still running',
    content: 'Your shortcut for checking text in other apps keeps working. To quit, right-click this icon.',
  });
}

function showWindow(): BrowserWindow {
  if (!mainWindow) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

/** Send to the UI now, or as soon as it reports that it is listening. */
function deliver(channel: string, payload: unknown): void {
  const run = () => mainWindow?.webContents.send(channel, payload);
  if (rendererReady && mainWindow) run();
  else pending.push(run);
}

/* ------------------------------------------------------------------ */
/* Files from the operating system                                     */
/* ------------------------------------------------------------------ */

async function readPicked(paths: string[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const path of paths) {
    try {
      out.push({ name: basename(path), data: new Uint8Array(await readFile(path)) });
    } catch (err) {
      console.error(`Could not read ${path}:`, err);
    }
  }
  return out;
}

const isImportable = (path: string) => IMPORT_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());

async function openPaths(paths: string[]): Promise<void> {
  const files = await readPicked(paths.filter((p) => isImportable(p) && existsSync(p)));
  if (!files.length) return;
  showWindow();
  deliver(IPC.openFiles, files);
}

/** Paths passed on the command line ("Open with" on Windows and Linux). */
const pathsFromArgv = (argv: string[]) => argv.slice(1).filter((a) => !a.startsWith('-') && isImportable(a));

const anywhere = new CheckAnywhere({
  get url() {
    return quickUrl();
  },
  preload: PRELOAD,
  backgroundColor: windowBackground,
  onChange: refreshMenus,
  openInApp(text) {
    showWindow();
    deliver(IPC.openText, text);
  },
  secure: secureWindow,
});

function refreshMenus(): void {
  const checkAnywhere = () => void anywhere.trigger();
  Menu.setApplicationMenu(
    buildMenu({
      send: (action: MenuAction) => {
        showWindow();
        deliver(IPC.menu, action);
      },
      checkAnywhere,
      anywhereShortcut: anywhere.shortcut,
    }),
  );
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Wordsmith', click: () => showWindow() },
      {
        label: 'Check Text in Another App',
        accelerator: anywhere.shortcut ?? undefined,
        registerAccelerator: false,
        click: checkAnywhere,
      },
      { type: 'separator' },
      { label: 'Quit Wordsmith', click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  const file = resourcePath(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
  if (!existsSync(file)) return;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return;
  tray = new Tray(image);
  tray.setToolTip('Wordsmith');
  tray.on('click', () => showWindow());
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function handle<Args extends unknown[], Result>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Blocked: untrusted sender');
    return fn(event, ...(args as Args));
  });
}

function defaultDirectory(): string {
  const last = store.get('lastDirectory');
  return last && existsSync(last) ? last : app.getPath('documents');
}

/** Strip characters that are not allowed in file names on Windows or macOS. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || 'Untitled';
}

/** Keep only the known fields, with the types they should have. */
function cleanAnywherePatch(patch: Partial<AnywhereSettings>): Partial<AnywhereSettings> {
  const clean: Partial<AnywhereSettings> = {};
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (typeof patch.launchAtLogin === 'boolean') clean.launchAtLogin = patch.launchAtLogin;
  if (typeof patch.shortcut === 'string' && patch.shortcut) clean.shortcut = patch.shortcut;
  return clean;
}

function registerIpc(): void {
  handle(IPC.info, (): AppInfo => ({
    platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
    version: app.getVersion(),
  }));

  ipcMain.on(IPC.rendererReady, (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    rendererReady = true;
    for (const run of pending.splice(0)) run();
  });

  ipcMain.on(IPC.quickReady, (event) => anywhere.pageIsReady(event.sender));

  handle(IPC.pickFiles, async (): Promise<PickedFile[]> => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import documents',
      defaultPath: defaultDirectory(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents', extensions: IMPORT_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return [];
    store.set('lastDirectory', dirname(result.filePaths[0]));
    return readPicked(result.filePaths);
  });

  handle(IPC.saveFile, async (_event, request: SaveFileRequest): Promise<SaveResult> => {
    if (!mainWindow) return { saved: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(defaultDirectory(), safeFileName(request.defaultName)),
      filters: [{ name: request.description, extensions: request.extensions }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, request.data);
    store.set('lastDirectory', dirname(result.filePath));
    return { saved: true, path: result.filePath };
  });

  handle(IPC.savePdf, async (_event, defaultName: string): Promise<SaveResult> => {
    if (!mainWindow) return { saved: false };
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: join(defaultDirectory(), safeFileName(defaultName)),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    const letter = ['US', 'CA', 'MX'].includes(app.getLocaleCountryCode());
    const pdf = await mainWindow.webContents.printToPDF({
      printBackground: false,
      pageSize: letter ? 'Letter' : 'A4',
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
    });
    await writeFile(result.filePath, pdf);
    store.set('lastDirectory', dirname(result.filePath));
    return { saved: true, path: result.filePath };
  });

  handle(IPC.print, () => {
    mainWindow?.webContents.print({ printBackground: false });
  });

  handle(IPC.openInDefaultApp, async (_event, name: string, data: Uint8Array): Promise<string> => {
    const fileName = safeFileName(String(name));
    if (!OPENABLE_EXTENSIONS.includes(extname(fileName).toLowerCase())) return 'That file type cannot be opened from Wordsmith.';
    // A folder of its own each time, because the last copy may still be open in Word.
    const folder = await mkdtemp(join(app.getPath('temp'), 'wordsmith-'));
    const file = join(folder, fileName);
    await writeFile(file, data);
    return shell.openPath(file);
  });

  handle(IPC.readClipboard, () => clipboard.readText());
  handle(IPC.writeClipboard, (_event, text: string) => clipboard.writeText(String(text)));
  handle(IPC.openExternal, async (_event, url: string) => {
    if (isSafeExternal(url)) await shell.openExternal(url);
  });
  handle(IPC.setTheme, (_event, theme: ThemeChoice) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme;
    anywhere.themeChanged();
  });

  handle(IPC.anywhereStatus, () => anywhere.status());
  handle(IPC.setAnywhere, (_event, patch: Partial<AnywhereSettings>) => anywhere.update(cleanAnywherePatch(patch)));
  handle(IPC.requestAppControl, () => anywhere.requestAppControl());
  handle(IPC.quickReplace, (_event, result: QuickResult) =>
    anywhere.replace({ text: String(result.text), html: typeof result.html === 'string' ? result.html : null }),
  );
  handle(IPC.quickCheckAll, () => anywhere.checkAll());
  handle(IPC.quickUseClipboard, () => anywhere.useClipboard());
  handle(IPC.quickClose, () => anywhere.hide());
  handle(IPC.quickOpenInApp, (_event, text: string) => anywhere.openInApp(String(text)));

  handle(IPC.aiHasKey, () => ai.hasKey());
  handle(IPC.aiSetKey, (_event, key: string) => ai.setKey(String(key)));
  handle(IPC.aiClearKey, () => ai.clearKey());
  handle(IPC.aiStart, (event, id: string, model: string, request: AiRequest) => {
    ai.start(event.sender, id, model, request);
  });
  handle(IPC.aiCancel, (_event, id: string) => ai.cancel(id));
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showWindow();
    void openPaths(pathsFromArgv(argv));
  });

  // macOS: files dropped on the dock icon or opened with "Open With".
  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (app.isReady()) void openPaths([path]);
    else app.whenReady().then(() => openPaths([path]));
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: 'Wordsmith',
      applicationVersion: app.getVersion(),
      copyright: 'A private, offline-first writing assistant.\nGrammar engine: Harper (writewithharper.com).',
    });
    if (!DEV_URL) registerAppProtocol();
    registerIpc();
    createTray();
    refreshMenus();
    void anywhere.start();
    if (!process.argv.includes(HIDDEN_FLAG)) mainWindow = createWindow();
    void openPaths(pathsFromArgv(process.argv));
    // Once the main window has had the first turn, get the quick window ready too.
    setTimeout(() => anywhere.prepare(), QUICK_WINDOW_DELAY);

    app.on('activate', () => void showWindow());
  });

  // Closing the main window is handled where it closes. The quick window, hidden
  // but alive, would otherwise keep this event from ever firing anyway.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', () => anywhere.prepareToQuit());

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
