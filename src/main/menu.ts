import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '@shared/api';

const REPOSITORY = 'https://github.com/SteveDeveloperConcepts/Wordsmith';

interface MenuHandlers {
  /** Forward an action to the app UI. */
  send(action: MenuAction): void;
  checkAnywhere(): void;
  /** The Check Anywhere accelerator, when the global shortcut is active. */
  anywhereShortcut: string | null;
}

export function buildMenu(handlers: MenuHandlers): Menu {
  const mac = process.platform === 'darwin';
  const dev = !app.isPackaged;
  const action = (a: MenuAction) => () => handlers.send(a);

  /**
   * Undo and redo go to the UI rather than using Electron's built-in roles: the
   * editor keeps its own history, and the browser-level undo would bypass it.
   * Off macOS the keystroke is left to the page (`registerAccelerator: false`).
   */
  const history: MenuItemConstructorOptions[] = [
    { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: mac, click: action('undo') },
    {
      label: 'Redo',
      accelerator: mac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
      registerAccelerator: mac,
      click: action('redo'),
    },
  ];

  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: action('settings'),
  };

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'New Document', accelerator: 'CmdOrCtrl+N', click: action('new-document') },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', click: action('import') },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            { label: 'Word Document (.docx)…', click: action('export-docx') },
            { label: 'PDF…', click: action('export-pdf') },
            { label: 'Web Page (.html)…', click: action('export-html') },
            { label: 'Markdown (.md)…', click: action('export-md') },
            { label: 'Plain Text (.txt)…', click: action('export-txt') },
          ],
        },
        { label: 'Open in Word', click: action('open-in-word') },
        { label: 'Start an Email', click: action('email-document') },
        { label: 'Copy with Formatting', accelerator: 'CmdOrCtrl+Shift+C', click: action('copy-document') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: action('print') },
        ...(mac
          ? []
          : ([{ type: 'separator' }, settings, { type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        ...history,
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Documents Sidebar', accelerator: 'CmdOrCtrl+\\', click: action('toggle-library') },
        { label: 'Assistant Panel', accelerator: 'CmdOrCtrl+Shift+\\', click: action('toggle-assistant') },
        { type: 'separator' },
        { label: 'Suggestions', accelerator: 'CmdOrCtrl+1', click: action('show-review') },
        { label: 'Insights', accelerator: 'CmdOrCtrl+2', click: action('show-insights') },
        { label: 'AI Assistant', accelerator: 'CmdOrCtrl+3', click: action('show-ai') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(dev
          ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: '&Tools',
      submenu: [
        { label: 'Set Goals…', accelerator: 'CmdOrCtrl+G', click: action('goals') },
        {
          label: 'Check Text in Another App',
          // Shown for reference; the global shortcut itself is registered separately.
          accelerator: handlers.anywhereShortcut ?? undefined,
          registerAccelerator: false,
          click: () => handlers.checkAnywhere(),
        },
      ],
    },
    {
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(mac
          ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Wordsmith on GitHub', click: () => void shell.openExternal(REPOSITORY) },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPOSITORY}/issues`) },
        ...(mac ? [] : ([{ type: 'separator' }, { role: 'about' }] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
