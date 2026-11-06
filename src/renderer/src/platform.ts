/**
 * One interface over the two places Wordsmith runs: the desktop app (where
 * `window.wordsmith` is provided by the preload script) and a plain browser.
 */
import type { DesktopBridge, PickedFile, SaveFileRequest, SaveResult } from '@shared/api';

export const desktop: DesktopBridge | undefined = window.wordsmith;
export const isDesktop = desktop !== undefined;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Label for the platform's command key, for shortcut hints. */
export const MOD = isMac ? '⌘' : 'Ctrl';

export const IMPORT_ACCEPT = '.docx,.txt,.md,.markdown,.html,.htm';

/** Let the user choose documents to import. */
export function pickFiles(): Promise<PickedFile[]> {
  if (desktop) return desktop.pickFiles();
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = IMPORT_ACCEPT;
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const files = await readFiles(Array.from(input.files ?? []));
      input.remove();
      resolve(files);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function readFiles(files: File[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const file of files) out.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
  return out;
}

/** Save bytes to a file the user chooses (desktop) or download them (browser). */
export async function saveFile(request: SaveFileRequest, mime: string): Promise<SaveResult> {
  if (desktop) return desktop.saveFile(request);
  const blob = new Blob([request.data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = request.defaultName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { saved: true };
}

export async function copyText(text: string): Promise<void> {
  if (desktop) return desktop.writeClipboard(text);
  await navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
  if (desktop) return desktop.readClipboard();
  return navigator.clipboard.readText();
}

export function openExternal(url: string): void {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
