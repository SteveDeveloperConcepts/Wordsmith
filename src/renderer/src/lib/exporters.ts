/** Everything that takes a document out of Wordsmith: files, the clipboard, and the printer. */
import type { SaveResult } from '@shared/api';
import type { JSONContent } from '@tiptap/core';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Tab,
  TextRun,
  type ILevelsOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import TurndownService from 'turndown';
import { copyText, desktop, saveFile } from '../platform';
import '../styles/print.css';
import { fileNameFor } from './format';
import { renderHtml } from './schema';

export type ExportKind = 'docx' | 'html' | 'md' | 'txt' | 'pdf';

/** Put the title above the text, as a heading of the document itself. */
function withTitle(title: string, content: JSONContent): JSONContent {
  const text = title.trim();
  if (!text) return content;
  const heading: JSONContent = { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] };
  return { ...content, content: [heading, ...(content.content ?? [])] };
}

// ---------- HTML ----------

const PAGE_STYLES = `
body { max-width: 42em; margin: 3em auto; padding: 0 1.25em; color: #000; background: #fff; font: 12pt/1.6 Georgia, 'Times New Roman', serif; }
h1, h2, h3 { line-height: 1.25; break-after: avoid; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #999; }
pre { padding: 0.75em; border: 1px solid #ccc; white-space: pre-wrap; }
code { font-family: Consolas, 'Courier New', monospace; font-size: 0.9em; }
a { color: inherit; }
@media print { body { max-width: none; margin: 0; padding: 0; } }
`;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A complete web page that opens and prints on its own. */
export function documentToHtml(title: string, content: JSONContent): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title.trim() || 'Untitled')}</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
${renderHtml(withTitle(title, content))}
</body>
</html>
`;
}

// ---------- Markdown ----------

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    hr: '---',
    // Unlike "_", "*" still means emphasis in the middle of a word.
    emDelimiter: '*',
  });

  // Turndown leaves these unescaped, and each would come back as markup rather than text.
  const escapeMarkdown = service.escape.bind(service);
  service.escape = (text) =>
    escapeMarkdown(text)
      .replace(/[<~]/g, '\\$&')
      .replace(/&(?=#?\w+;)/g, '\\&');

  service.addRule('strike', {
    filter: ['s', 'del'],
    replacement: (content) => `~~${content}~~`,
  });

  // Markdown has no underline of its own, but it does allow inline HTML.
  service.addRule('underline', {
    filter: 'u',
    replacement: (content) => `<u>${content}</u>`,
  });

  // The editor keeps a paragraph in every list item. Treated as ordinary paragraphs they would
  // spread every list out with blank lines.
  service.addRule('listParagraph', {
    filter: (node) => node.nodeName === 'P' && node.parentNode?.nodeName === 'LI' && !node.previousElementSibling,
    replacement: (content) => `${content}\n`,
  });

  // Turndown's own rule pads markers to four columns: "-   item".
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const list = node.parentNode as Element;
      const position = Array.from(list.children).indexOf(node as Element);
      const marker = list.nodeName === 'OL' ? `${Number(list.getAttribute('start') ?? 1) + position}. ` : `${options.bulletListMarker} `;
      const body = content.trim().replace(/\n(?=.)/g, `\n${' '.repeat(marker.length)}`);
      return `${marker}${body}${node.nextSibling ? '\n' : ''}`;
    },
  });

  return service;
}

const turndown = createTurndown();

export function documentToMarkdown(title: string, content: JSONContent): string {
  return `${turndown.turndown(renderHtml(withTitle(title, content)))}\n`;
}

// ---------- Plain text ----------

function inlineText(node: JSONContent): string {
  return (node.content ?? []).map((child) => (child.type === 'hardBreak' ? '\n' : (child.text ?? ''))).join('');
}

function blockText(node: JSONContent): string {
  switch (node.type) {
    case 'bulletList':
    case 'orderedList': {
      const first = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((item, index) => {
          const marker = node.type === 'bulletList' ? '- ' : `${first + index}. `;
          return `${marker}${blocksText(item.content, '\n').replace(/\n/g, `\n${' '.repeat(marker.length)}`)}`;
        })
        .join('\n');
    }
    case 'blockquote':
      return blocksText(node.content).replace(/^/gm, '> ');
    case 'horizontalRule':
      return '---';
    default:
      return inlineText(node);
  }
}

const blocksText = (nodes: JSONContent[] = [], separator = '\n\n'): string => nodes.map(blockText).join(separator);

export function documentToText(title: string, content: JSONContent): string {
  return `${blocksText(withTitle(title, content).content).trimEnd()}\n`;
}

// ---------- Word ----------

const BODY_FONT = 'Calibri';
const CODE_FONT = 'Consolas';
const TEXT_GRAY = '555555';
const RULE_GRAY = 'BBBBBB';
const CODE_FILL = 'F4F4F4';

/** Twips per level of list nesting, and the room a bullet or number takes. */
const LIST_STEP = 360;
const QUOTE_STEP = 360;

/** The deepest list level Word has. */
const LAST_LIST_LEVEL = 8;
const BULLETS = ['•', '◦', '▪'];

const HEADINGS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
};

/** Where a block sits, which decides how it is indented and styled. */
interface Place {
  /** How many lists it is inside. */
  depth: number;
  /** Left indent in twips, for blocks that are not list items themselves. */
  indent: number;
  quoted: boolean;
}

/**
 * docx removes the control characters XML forbids, but not the two noncharacters,
 * and Word refuses to open a file with either in it. Half a surrogate pair would
 * only come out as a replacement character, which nobody wants in their document.
 */
const forXml = (text: string): string => text.replace(/[\p{Cs}\ufffe\uffff]/gu, '');

/**
 * The hyperlink target to write, if the link can be one. The package format calls
 * for a real URI, so the URL parser gets to encode it. Anything else, such as a
 * relative link with nothing to be relative to, stays plain text.
 */
function hyperlinkTarget(node: JSONContent): string | undefined {
  const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
  if (typeof href !== 'string' || !/^\s*(https?|mailto|tel|ftp):/i.test(href)) return undefined;
  try {
    return new URL(forXml(href).trim()).href.replace(/\s/g, '%20');
  } catch {
    return undefined;
  }
}

function runOptions(node: JSONContent, href: string | undefined): IRunOptions {
  const has = (type: string) => node.marks?.some((mark) => mark.type === type) ?? false;
  return {
    bold: has('bold') || undefined,
    italics: has('italic') || undefined,
    underline: has('underline') ? {} : undefined,
    strike: has('strike') || undefined,
    style: has('code') ? 'Code' : href ? 'Hyperlink' : undefined,
  };
}

/** Text as Word wants it: line breaks and tabs are elements, not characters. */
function textRuns(text: string, options: IRunOptions): TextRun[] {
  return forXml(text)
    .split('\n')
    .map(
      (line, index) =>
        new TextRun({
          ...options,
          break: index ? 1 : undefined,
          children: line.split('\t').flatMap((part, position) => (position ? [new Tab(), part] : [part])),
        }),
    );
}

function inlineChildren(nodes: JSONContent[] = []): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  let link: { href: string; runs: TextRun[] } | undefined;

  const endLink = () => {
    if (link) children.push(new ExternalHyperlink({ link: link.href, children: link.runs }));
    link = undefined;
  };

  for (const node of nodes) {
    const href = hyperlinkTarget(node);
    const runs = node.type === 'hardBreak' ? [new TextRun({ break: 1 })] : textRuns(node.text ?? '', runOptions(node, href));
    // Neighbors with the same target stay one link, however their other marks differ.
    if (href !== link?.href) endLink();
    if (!href) children.push(...runs);
    else if (link) link.runs.push(...runs);
    else link = { href, runs };
  }
  endLink();
  return children;
}

/** Indentation for each level of a list, so that its numbers and text line up the way Word's own lists do. */
const listIndent = (level: number, base = 0) => ({ left: base + LIST_STEP * (level + 1), hanging: LIST_STEP });

function listLevels(ordered: boolean, depth: number, start: number, base: number): ILevelsOptions[] {
  return Array.from({ length: LAST_LIST_LEVEL + 1 }, (_, level) => ({
    level,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : BULLETS[level % BULLETS.length],
    alignment: AlignmentType.LEFT,
    start: level === depth ? start : 1,
    style: { paragraph: { indent: listIndent(level, base) } },
  }));
}

/** Turns one document's blocks into paragraphs. It is a class only to number the lists it meets. */
class WordWriter {
  private lists = 0;

  blocks(nodes: JSONContent[] = [], place: Place): Paragraph[] {
    return nodes.flatMap((node) => this.block(node, place));
  }

  private block(node: JSONContent, place: Place): Paragraph[] {
    const indent = place.indent ? { left: place.indent } : undefined;
    switch (node.type) {
      case 'paragraph':
        return [new Paragraph({ style: place.quoted ? 'Quote' : undefined, indent, children: inlineChildren(node.content) })];
      case 'heading':
        return [new Paragraph({ heading: HEADINGS[Number(node.attrs?.level)], indent, children: inlineChildren(node.content) })];
      case 'blockquote':
        return this.blocks(node.content, { ...place, indent: place.indent + QUOTE_STEP, quoted: true });
      case 'bulletList':
      case 'orderedList':
        return this.list(node, place);
      case 'codeBlock':
        return [new Paragraph({ style: 'CodeBlock', indent, children: textRuns(inlineText(node), {}) })];
      case 'horizontalRule':
        return [new Paragraph({ style: 'HorizontalRule', indent })];
      default:
        return [];
    }
  }

  /**
   * Every list gets a numbering definition of its own. Lists that share one count
   * on from each other in Word, and a nested list would only restart after an item
   * of its own definition, which it never has when its parent is a different kind.
   */
  private list(node: JSONContent, place: Place): Paragraph[] {
    const level = Math.min(place.depth, LAST_LIST_LEVEL);
    const start = Number(node.attrs?.start ?? 1);
    // Levels indent by their number; this is whatever comes on top of that, such as a quote around the list.
    const base = place.indent - LIST_STEP * level;
    const levels = listLevels(node.type === 'orderedList', level, start, base);
    const reference = { reference: `wordsmith-list-${++this.lists}`, levels };
    const inside: Place = { ...place, depth: place.depth + 1, indent: listIndent(level, base).left, quoted: false };

    return (node.content ?? []).flatMap((item) => {
      const [first, ...rest] = item.content ?? [];
      return [
        new Paragraph({ numbering: { reference, level }, children: inlineChildren(first?.content) }),
        ...this.blocks(rest, inside),
      ];
    });
  }
}

function wordDocument(title: string, content: JSONContent): Document {
  const name = forXml(title.trim());
  const body = new WordWriter().blocks(content.content, { depth: 0, indent: 0, quoted: false });
  const titleBlock = name ? [new Paragraph({ heading: HeadingLevel.TITLE, children: textRuns(name, {}) })] : [];

  return new Document({
    title: name,
    creator: 'Wordsmith',
    lastModifiedBy: 'Wordsmith',
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 22 },
          paragraph: { spacing: { after: 160, line: 276 } },
        },
        title: { run: { font: BODY_FONT, size: 52, bold: true }, paragraph: { spacing: { after: 240 } } },
        heading1: { run: { font: BODY_FONT, size: 36, bold: true }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: BODY_FONT, size: 30, bold: true }, paragraph: { spacing: { before: 280, after: 100 } } },
        heading3: { run: { font: BODY_FONT, size: 25, bold: true }, paragraph: { spacing: { before: 240, after: 80 } } },
        listParagraph: { paragraph: { contextualSpacing: true } },
      },
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { color: TEXT_GRAY },
          paragraph: { border: { left: { style: BorderStyle.SINGLE, size: 18, color: RULE_GRAY, space: 10 } } },
        },
        {
          id: 'CodeBlock',
          name: 'Code Block',
          basedOn: 'Normal',
          next: 'Normal',
          run: { font: CODE_FONT, size: 19 },
          paragraph: { spacing: { line: 240 }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: CODE_FILL } },
        },
        {
          id: 'HorizontalRule',
          name: 'Horizontal Rule',
          basedOn: 'Normal',
          next: 'Normal',
          paragraph: { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_GRAY, space: 1 } } },
        },
      ],
      characterStyles: [{ id: 'Code', name: 'Code', basedOn: 'DefaultParagraphFont', run: { font: CODE_FONT, size: 20 } }],
    },
    sections: [{ children: [...titleBlock, ...body] }],
  });
}

export function documentToDocx(title: string, content: JSONContent): Promise<Uint8Array> {
  return Packer.pack(wordDocument(title, content), 'uint8array');
}

// ---------- Saving ----------

const FILE_FORMATS = {
  docx: {
    description: 'Word document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  html: { description: 'Web page', mime: 'text/html' },
  md: { description: 'Markdown', mime: 'text/markdown' },
  txt: { description: 'Plain text', mime: 'text/plain' },
};

/**
 * An <input> cannot wrap, so a long title would be cut off at the edge of the paper.
 * print.css shows this copy of it instead, as ordinary text.
 */
function copyTitleForPrinting(): void {
  const input = document.querySelector<HTMLInputElement>('.title-input');
  input?.parentElement?.setAttribute('data-print-title', input.value);
}

window.addEventListener('beforeprint', copyTitleForPrinting);

async function fileBytes(kind: keyof typeof FILE_FORMATS, title: string, content: JSONContent): Promise<Uint8Array> {
  if (kind === 'docx') return documentToDocx(title, content);
  const render = { html: documentToHtml, md: documentToMarkdown, txt: documentToText }[kind];
  return new TextEncoder().encode(render(title, content));
}

export async function exportDocument(kind: ExportKind, title: string, content: JSONContent): Promise<SaveResult> {
  if (kind === 'pdf') {
    copyTitleForPrinting();
    if (desktop) return desktop.savePdf(fileNameFor(title, 'pdf'));
    window.print();
    // The print dialog does not say whether anything was saved.
    return { saved: false };
  }
  const { description, mime } = FILE_FORMATS[kind];
  const data = await fileBytes(kind, title, content);
  return saveFile({ defaultName: fileNameFor(title, kind), description, extensions: [kind], data }, mime);
}

export async function printDocument(): Promise<void> {
  copyTitleForPrinting();
  if (desktop) return desktop.print();
  window.print();
}

// ---------- Clipboard ----------

const PASTE_FONT = 'font-family:Calibri,Arial,sans-serif;';

/**
 * Word and Outlook ignore style sheets on paste and fall back to Times New Roman
 * and browser-sized margins, so every element carries its own styling.
 */
const PASTE_STYLES: Record<string, string> = {
  h1: `${PASTE_FONT}font-size:20pt;font-weight:bold;margin:18pt 0 6pt;`,
  h2: `${PASTE_FONT}font-size:16pt;font-weight:bold;margin:14pt 0 5pt;`,
  h3: `${PASTE_FONT}font-size:13pt;font-weight:bold;margin:12pt 0 4pt;`,
  p: `${PASTE_FONT}font-size:11pt;margin:0 0 8pt;`,
  ul: 'margin:0 0 8pt;padding-left:24pt;',
  ol: 'margin:0 0 8pt;padding-left:24pt;',
  li: `${PASTE_FONT}font-size:11pt;margin:0 0 2pt;`,
  blockquote: 'margin:0;',
  pre: "font-family:Consolas,'Courier New',monospace;font-size:10pt;white-space:pre-wrap;margin:0 0 8pt;",
  code: "font-family:Consolas,'Courier New',monospace;",
  a: 'color:#0563c1;text-decoration:underline;',
  strong: 'font-weight:bold;',
  em: 'font-style:italic;',
  u: 'text-decoration:underline;',
  s: 'text-decoration:line-through;',
  hr: 'border:0;border-top:1px solid #bbbbbb;margin:10pt 0;',
};

/** Word keeps a quote's look only on its paragraphs: their own margins replace whatever the blockquote says. */
const PASTE_QUOTE_STYLE = 'margin-left:12pt;padding-left:10pt;border-left:3px solid #bbbbbb;color:#555555;';

export function htmlForPasting(content: JSONContent): string {
  const { body } = new DOMParser().parseFromString(renderHtml(content), 'text/html');
  // A <p> inside a list item gets a paragraph's spacing, which pastes as a gap between items.
  for (const item of Array.from(body.querySelectorAll('li'))) {
    const blocks = Array.from(item.children).filter((child) => child.localName === 'p');
    if (blocks.length === 1) blocks[0].replaceWith(...Array.from(blocks[0].childNodes));
  }
  for (const element of Array.from(body.querySelectorAll('*'))) {
    const style = PASTE_STYLES[element.localName];
    if (style) element.setAttribute('style', style);
  }
  for (const quoted of Array.from(body.querySelectorAll('blockquote p'))) {
    quoted.setAttribute('style', `${quoted.getAttribute('style')}${PASTE_QUOTE_STYLE}`);
  }
  return body.innerHTML;
}

/** Copy the document so that it pastes with its formatting, or as plain text where that cannot be done. */
export async function copyFormatted(content: JSONContent): Promise<void> {
  const text = blocksText(content.content);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([htmlForPasting(content)], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    await copyText(text);
  }
}
