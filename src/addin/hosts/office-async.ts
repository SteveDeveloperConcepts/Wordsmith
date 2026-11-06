/// <reference types="office-js" />
/**
 * Promises over the callback style of the Office Common and Outlook APIs, and the
 * per-document store for dismissed suggestions.
 */

export class OfficeError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
  ) {
    super(message);
  }
}

export function settle<T>(start: (done: (result: Office.AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    start((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value);
      else reject(new OfficeError(result.error.code, result.error.message));
    });
  });
}

const DISMISSED = 'wordsmith.dismissed';

/**
 * Word, PowerPoint, and Excel keep add-in settings inside the file, so a dismissal
 * follows the document to another computer. Only hashed ids are stored, never text.
 */
export function readDismissed(): string[] {
  try {
    const saved: unknown = Office.context.document.settings.get(DISMISSED);
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export async function writeDismissed(ids: string[]): Promise<void> {
  const { settings } = Office.context.document;
  settings.set(DISMISSED, ids);
  await settle<void>((done) => settings.saveAsync(done));
}
