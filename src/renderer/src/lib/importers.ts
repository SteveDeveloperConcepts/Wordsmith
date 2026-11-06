/** Turns files people bring in (Word, web pages, Markdown, plain text) into editor documents. */
import type { PickedFile } from '@shared/api';
import type { JSONContent } from '@tiptap/core';
import type Mammoth from 'mammoth';
// @ts-expect-error The prebuilt bundle has no types of its own; its API is the main entry's.
import mammothBundle from 'mammoth/mammoth.browser.js';
import { marked } from 'marked';
import { plural } from './format';
import { textToDoc } from './sample';
import { parseHtml } from './schema';

/**
 * Mammoth's main entry reads files through Node, and only a bundler that honors
 * its "browser" remapping avoids that. This bundle has no Node in it at all, so
 * the app and the tests run the very same code.
 */
const mammoth = mammothBundle as typeof Mammoth;

export interface ImportedDocument {
  title: string;
  content: JSONContent;
  /** Things a person should know were lost or changed on the way in. */
  warnings?: string[];
}

interface Converted {
  content: JSONContent;
  warnings: string[];
}

const SUPPORTED = '.docx, .html, .htm, .md, .markdown, or .txt';

const DOCX_STYLE_MAP = [
  // Mammoth drops underlines unless asked to keep them, because they look like links on the web.
  'u => u',
  // The rest are the styles Word itself uses and the ones documentToDocx writes.
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code Block'] => pre:separator('\\n')",
  "r[style-name='Code'] => code",
  "p[style-name='Horizontal Rule'] => hr",
];

/** "Report.final.docx" becomes "Report.final" and "docx". */
function splitName(name: string): { title: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return { title: name.trim() || 'Untitled', extension: '' };
  return { title: name.slice(0, dot).trim() || 'Untitled', extension: name.slice(dot + 1).toLowerCase() };
}

function decode(data: Uint8Array): string {
  const utf16 = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : null;
  return new TextDecoder(utf16 ?? 'utf-8').decode(data);
}

function readText(file: PickedFile): { text: string; warnings: string[] } {
  const text = decode(file.data);
  // No text encoding this reads produces a NUL from real writing, so this is binary data with the wrong name.
  if (text.includes('\u0000')) {
    throw new Error(`"${file.name}" is not a text file, even though its name says it is. Check that it is the right file, or save it again as text.`);
  }
  const warnings = text.includes('\ufffd')
    ? ['Some characters could not be read and show as \ufffd. Save the file as UTF-8 and import it again to keep them.']
    : [];
  return { text, warnings };
}

function replaceTag(element: Element, tag: string): void {
  const replacement = element.ownerDocument.createElement(tag);
  replacement.append(...Array.from(element.childNodes));
  element.replaceWith(replacement);
}

/**
 * The schema has no tables, and table cells are not block elements to its parser,
 * so "<td>a</td><td>b</td>" would come out as "ab". One block per cell keeps every
 * cell's text apart, along with any lists or paragraphs inside it.
 */
function flattenTable(table: Element): void {
  for (const cell of Array.from(table.querySelectorAll('caption, th, td'))) {
    if (!cell.textContent?.trim()) continue;
    const block = table.ownerDocument.createElement('div');
    block.append(...Array.from(cell.childNodes));
    table.before(block);
  }
  table.remove();
}

/** Reshape HTML from anywhere into what the schema can hold, then parse it. */
function htmlToContent(html: string): Converted {
  const { body } = new DOMParser().parseFromString(html, 'text/html');

  const images = Array.from(body.querySelectorAll('img'));
  for (const image of images) {
    const paragraph = image.closest('p');
    image.remove();
    // A paragraph that only held a picture would stay behind as an empty line.
    if (paragraph && !paragraph.textContent?.trim()) paragraph.remove();
  }

  // Innermost first, so that a table inside a cell is already gone when its parent is flattened.
  for (const table of Array.from(body.querySelectorAll('table')).reverse()) flattenTable(table);

  // The schema stops at h3; left alone, deeper headings would turn into plain paragraphs.
  for (const heading of Array.from(body.querySelectorAll('h4, h5, h6'))) replaceTag(heading, 'h3');

  // Markdown ends every code block with a newline that nobody typed, and a browser would not show it.
  for (const pre of Array.from(body.querySelectorAll('pre'))) {
    const last = (pre.querySelector('code') ?? pre).lastChild;
    if (last?.nodeType === Node.TEXT_NODE) last.nodeValue = last.nodeValue?.replace(/\n$/, '') ?? '';
  }

  const warnings = images.length
    ? [`${plural(images.length, 'image was', 'images were')} left out, because Wordsmith documents hold text only.`]
    : [];
  return { content: parseHtml(body.innerHTML), warnings };
}

async function docxToHtml(file: PickedFile): Promise<string> {
  try {
    const result = await mammoth.convertToHtml(
      // The view may cover only part of its buffer, and mammoth reads the whole buffer.
      { arrayBuffer: file.data.slice().buffer },
      {
        styleMap: DOCX_STYLE_MAP,
        // The pictures are dropped, so there is no point in encoding them first.
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      },
    );
    return result.value;
  } catch {
    throw new Error(
      `"${file.name}" could not be opened. It may be damaged, password protected, or not really a Word document. Open it in Word, save a new copy as .docx, and import that.`,
    );
  }
}

function blockText(block: JSONContent): string {
  return block.text ?? (block.content ?? []).map(blockText).join('');
}

/** Ignores what differs between a title and the file name made from it: "Q3: Plans" is saved as "Q3 Plans". */
const comparable = (text: string): string => text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

/**
 * The exporters write the title above the text, and the editor shows the title
 * on its own line. Without this, every export and import would add another copy.
 */
function withoutRepeatedTitle(content: JSONContent, title: string): JSONContent {
  const [first, ...rest] = content.content ?? [];
  const wanted = comparable(title);
  if (!wanted || !first || (first.type !== 'heading' && first.type !== 'paragraph')) return content;
  if (comparable(blockText(first)) !== wanted) return content;
  return { ...content, content: rest.length ? rest : [{ type: 'paragraph' }] };
}

async function convert(file: PickedFile, extension: string): Promise<Converted> {
  switch (extension) {
    case 'docx':
      return htmlToContent(await docxToHtml(file));
    case 'html':
    case 'htm': {
      const { text, warnings } = readText(file);
      const converted = htmlToContent(text);
      return { ...converted, warnings: [...warnings, ...converted.warnings] };
    }
    case 'md':
    case 'markdown': {
      const { text, warnings } = readText(file);
      const converted = htmlToContent(marked.parse(text, { async: false }));
      return { ...converted, warnings: [...warnings, ...converted.warnings] };
    }
    case 'txt': {
      const { text, warnings } = readText(file);
      return { content: textToDoc(text), warnings };
    }
    case 'doc':
      throw new Error(`"${file.name}" uses the older .doc format. Open it in Word, save it as .docx, and import that.`);
    default:
      throw new Error(`Wordsmith can't import "${file.name}". Choose a ${SUPPORTED} file.`);
  }
}

/** Read a picked file into a document. Rejects with a message meant for the person importing it. */
export async function importFile(file: PickedFile): Promise<ImportedDocument> {
  const { title, extension } = splitName(file.name);
  const { content, warnings } = await convert(file, extension);
  return {
    title,
    content: withoutRepeatedTitle(content, title),
    ...(warnings.length ? { warnings } : {}),
  };
}
