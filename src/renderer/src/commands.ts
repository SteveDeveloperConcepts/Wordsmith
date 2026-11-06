/**
 * Everything the menus, the toolbar, and the operating system can ask the app to
 * do, in one place, so that each route behaves the same.
 */
import type { MenuAction, PickedFile } from '@shared/api';
import { copyFormatted, exportDocument, printDocument, type ExportKind } from './lib/exporters';
import { plural } from './lib/format';
import { openInWord, startEmail } from './lib/handoff';
import { importFile } from './lib/importers';
import { textToDoc } from './lib/sample';
import { desktop, isDesktop, pickFiles } from './platform';
import { currentContent, useLibrary } from './state/library';
import { useSession, type AssistantTab } from './state/session';
import { useSettings } from './state/settings';

const EXPORT_LABEL: Record<ExportKind, string> = {
  docx: 'Word document',
  html: 'web page',
  md: 'Markdown file',
  txt: 'text file',
  pdf: 'PDF',
};

const notify = (message: string, kind?: 'info' | 'error') => useSession.getState().notify(message, kind);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Open each file as a new document. A bad file does not stop the others. */
export async function importFiles(files: PickedFile[]): Promise<void> {
  const library = useLibrary.getState();
  const problems: string[] = [];
  const notes: string[] = [];
  let opened = 0;
  for (const file of files) {
    try {
      const { title, content, warnings } = await importFile(file);
      await library.create({ title, content });
      opened++;
      if (warnings?.length) notes.push(...warnings);
    } catch (err) {
      problems.push(messageOf(err));
    }
  }
  if (problems.length > 0) notify(problems.join(' '), 'error');
  else if (notes.length > 0) notify(notes.join(' '));
  else if (opened > 1) notify(`Imported ${plural(opened, 'document')}.`);
}

async function runExport(kind: ExportKind): Promise<void> {
  const { current } = useLibrary.getState();
  const content = currentContent();
  if (!current || !content) return;
  // Saving reads the page itself for a PDF, so the last keystrokes must be in place first.
  await useLibrary.getState().flush();
  try {
    const result = await exportDocument(kind, current.title, content);
    if (result.saved) notify(`Saved the ${EXPORT_LABEL[kind]}.`);
  } catch (err) {
    notify(`The ${EXPORT_LABEL[kind]} could not be saved. ${messageOf(err)}`, 'error');
  }
}

async function handOff(open: typeof openInWord, app: string): Promise<void> {
  const { current } = useLibrary.getState();
  const content = currentContent();
  if (!current || !content) return;
  try {
    await open(current.title, content);
  } catch (err) {
    notify(`Could not open ${app}. ${messageOf(err)}`, 'error');
  }
}

async function copyDocument(): Promise<void> {
  const content = currentContent();
  if (!content) return;
  try {
    await copyFormatted(content);
    notify('Copied. Paste into Word or an email to keep the formatting.');
  } catch (err) {
    notify(`Could not copy the document. ${messageOf(err)}`, 'error');
  }
}

function showTab(tab: AssistantTab): void {
  useSettings.getState().update({ assistantOpen: true });
  useSession.getState().setTab(tab);
}

async function newDocument(): Promise<void> {
  await useLibrary.getState().create();
  useSession.getState().editor?.commands.focus();
}

async function runImport(): Promise<void> {
  const files = await pickFiles();
  if (files.length > 0) await importFiles(files);
}

export function runCommand(action: MenuAction): void {
  const session = useSession.getState();
  const settings = useSettings.getState();
  switch (action) {
    case 'new-document':
      void newDocument();
      break;
    case 'import':
      void runImport();
      break;
    case 'export-docx':
      void runExport('docx');
      break;
    case 'export-pdf':
      void runExport('pdf');
      break;
    case 'export-html':
      void runExport('html');
      break;
    case 'export-md':
      void runExport('md');
      break;
    case 'export-txt':
      void runExport('txt');
      break;
    case 'open-in-word':
      void handOff(openInWord, 'Word');
      break;
    case 'email-document':
      void handOff(startEmail, 'your email app');
      break;
    case 'print':
      void printDocument();
      break;
    case 'settings':
      session.openDialog('settings');
      break;
    case 'goals':
      session.openDialog('goals');
      break;
    case 'toggle-library':
      settings.update({ libraryOpen: !settings.libraryOpen });
      break;
    case 'toggle-assistant':
      settings.update({ assistantOpen: !settings.assistantOpen });
      break;
    case 'show-review':
      showTab('review');
      break;
    case 'show-insights':
      showTab('insights');
      break;
    case 'show-ai':
      showTab('ai');
      break;
    case 'copy-document':
      void copyDocument();
      break;
    case 'undo':
      session.editor?.chain().focus().undo().run();
      break;
    case 'redo':
      session.editor?.chain().focus().redo().run();
      break;
  }
}

/** The desktop app's menus carry these. A browser has only the page, and keeps many keys for itself. */
function browserShortcut(event: KeyboardEvent): MenuAction | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  if (event.key === '\\') return 'toggle-library';
  if (event.key === '|') return 'toggle-assistant';
  if (event.key === ',') return 'settings';
  return null;
}

/** Start taking commands from the shell or the keyboard. Returns a function that stops. */
export function listenForCommands(): () => void {
  if (!desktop || !isDesktop) {
    const onKey = (event: KeyboardEvent) => {
      const action = browserShortcut(event);
      if (!action) return;
      event.preventDefault();
      runCommand(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }

  const stops = [
    desktop.onMenu(runCommand),
    desktop.onOpenFiles((files) => void importFiles(files)),
    desktop.onOpenText((text) => {
      void useLibrary.getState().create({ title: 'Checked text', content: textToDoc(text) });
    }),
  ];
  // Anything the shell queued during startup arrives after this.
  desktop.notifyReady();
  return () => {
    for (const stop of stops) stop();
  };
}
