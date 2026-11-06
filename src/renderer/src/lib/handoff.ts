/**
 * Moving a finished document into Word or a new email in one step. Desktop only:
 * a browser cannot open another app with a file.
 */
import type { JSONContent } from '@tiptap/core';
import { desktop } from '../platform';
import { documentToDocx, documentToText, htmlForPasting } from './exporters';
import { fileNameFor } from './format';

const base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Mail lines stop at 998 characters, and 76 is what mail programs expect of base64. */
const wrapped = (text: string) => base64(text).replace(/.{76}/g, '$&\r\n');

/** A header value may only be ASCII, so anything else travels as an encoded word. */
const encodedHeader = (text: string) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64(text)}?=`);

/**
 * A draft email file. X-Unsent is what makes Outlook open it ready to send rather
 * than as a received message.
 */
export function documentToEml(title: string, content: JSONContent): string {
  const boundary = 'wordsmith-boundary';
  const subject = encodedHeader(title.replace(/[\r\n]+/g, ' ').trim());
  return [
    'X-Unsent: 1',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(documentToText('', content)),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapped(`<!doctype html><html><body>${htmlForPasting(content)}</body></html>`),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function open(name: string, data: Uint8Array): Promise<void> {
  const problem = (await desktop?.openInDefaultApp(name, data)) ?? 'This needs the desktop app.';
  if (problem) throw new Error(problem);
}

export async function openInWord(title: string, content: JSONContent): Promise<void> {
  await open(fileNameFor(title, 'docx'), await documentToDocx(title, content));
}

export async function startEmail(title: string, content: JSONContent): Promise<void> {
  await open(fileNameFor(title, 'eml'), new TextEncoder().encode(documentToEml(title, content)));
}
