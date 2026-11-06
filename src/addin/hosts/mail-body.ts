/**
 * Reading what the writer wrote out of a draft, and writing fixes back into it.
 *
 * A draft holds more than the writer's words: a signature, and in a reply the whole
 * earlier thread. Those are left out of the check. They still go back to Outlook,
 * because the only way to change a draft is to replace all of it, so a fix is
 * spliced into the original HTML string. applyEdits decides what changes, and those
 * changes alone are carried across, leaving every other byte as Outlook gave it.
 *
 * Outlook strips most classes and data attributes from bodies (office-js 5296) and
 * says not to depend on its markup, so none of these markers is promised. Each one
 * only has to match for its own client, and the text patterns catch what they miss.
 */
import type { Block } from '@engine/types';
import { applyEdits, diffText, readBlocks, type HtmlBlock, type ReadOptions } from '@shared/html-text';
import { findAgain } from './types';

const QUOTE_IDS = /^(x_)?(appendonsend|divRplyFwdMsg|OLK_SRC_BODY_SECTION)$/;
const QUOTE_CLASSES = /\b(gmail_quote|yahoo_quoted|moz-cite-prefix)\b/;
const WORD_SEPARATOR = /border-top:\s*solid\s+(#E1E1E1|#B5C4DF)/i;
const SIGNATURE_IDS = /^(x_)?(Signature|ms-outlook-mobile-signature)$/;
const SIGNATURE_CLASSES = /\b(gmail_signature|moz-signature)\b/;

const ORIGINAL_MESSAGE = /^\s*-{2,}\s*Original Message\s*-{2,}/i;
const HEADER_START = /^\s*From:\s/;
// No word boundaries: a <br> between header lines adds nothing to textContent, so "Sam" meets "Sent:".
const HEADER_REST = /(Sent|Date):\s[\s\S]*Subject:\s/;

function looksLikeReplyHeader(element: Element): boolean {
  const tag = element.localName;
  if (tag !== 'div' && tag !== 'p') return false;
  const text = (element.textContent ?? '').slice(0, 1000);
  return ORIGINAL_MESSAGE.test(text) || (HEADER_START.test(text) && HEADER_REST.test(text));
}

export const MAIL_BOUNDARY: ReadOptions = {
  stop: (element) =>
    QUOTE_IDS.test(element.id) ||
    QUOTE_CLASSES.test(element.getAttribute('class') ?? '') ||
    (element.localName === 'blockquote' && element.getAttribute('type') === 'cite') ||
    (element.localName === 'a' && /^_Mail(Original|AutoSig)$/.test(element.getAttribute('name') ?? '')) ||
    WORD_SEPARATOR.test(element.getAttribute('style') ?? '') ||
    looksLikeReplyHeader(element),
  skip: (element) =>
    SIGNATURE_IDS.test(element.id) || SIGNATURE_CLASSES.test(element.getAttribute('class') ?? ''),
};

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function readHtmlBlocks(doc: Document): HtmlBlock[] {
  return readBlocks(doc.body, MAIL_BOUNDARY);
}

/** Every picture in the body, so a write can be checked for what Outlook did to them. */
export function pictureSources(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('img'), (image) => image.getAttribute('src') ?? '');
}

export type Patch = { status: 'ok'; body: string } | { status: 'stale' | 'unplaced' };

/**
 * Replaces one block's text in a draft's HTML. `was` holds the texts of the blocks as
 * last read, so the block can be found again and confirmed to still say what it said.
 */
export function replaceHtmlBlock(source: string, was: string[], index: number, after: string): Patch {
  const doc = parseHtml(source);
  const block = findAgain(readHtmlBlocks(doc), (candidate) => candidate.text, was, index);
  if (!block) return { status: 'stale' };

  const nodes = textNodes(doc);
  const original = nodes.map((node) => node.data);
  if (!applyEdits(block, diffText(was[index], after))) return { status: 'unplaced' };

  const spliced = spliceText(source, nodes, original);
  const body = spliced !== null && sameBlocks(spliced, doc) ? spliced : serialize(doc, source);
  return { status: 'ok', body };
}

function sameBlocks(html: string, doc: Document): boolean {
  const expected = readHtmlBlocks(doc).map((block) => block.text);
  const actual = readHtmlBlocks(parseHtml(html)).map((block) => block.text);
  return expected.length === actual.length && expected.every((text, i) => text === actual[i]);
}

/** Some clients hand over a whole document and others a fragment, and what went in has to come out. */
function serialize(doc: Document, source: string): string {
  if (!/<(?:html|head|body)[\s>]/i.test(source)) return doc.body.innerHTML;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source)?.[0] ?? '';
  return doctype + doc.documentElement.outerHTML;
}

/* ---------- Splicing into the source ---------- */

/** Elements whose text is not parsed as markup, so it never lines up with ordinary text. */
const OPAQUE = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

function textNodes(doc: Document): Text[] {
  const nodes: Text[] = [];
  const walk = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) nodes.push(child as Text);
      else if (child.nodeType === 1 && !OPAQUE.has((child as Element).localName)) walk(child);
    }
  };
  walk(doc.documentElement);
  return nodes;
}

/** The spans of `html` that hold character data, in order. */
function* textSpans(html: string): Generator<[number, number]> {
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) {
      yield [at, html.length];
      return;
    }
    if (open > at) yield [at, open];

    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(html.slice(open, open + 80));
    if (!tag) {
      if (/[!?/]/.test(html[open + 1] ?? '')) {
        const end = html.indexOf('>', open);
        at = end === -1 ? html.length : end + 1;
      } else {
        // A lone "<" is text.
        yield [open, open + 1];
        at = open + 1;
      }
      continue;
    }

    let end = open + tag[0].length;
    let quote = '';
    for (; end < html.length; end++) {
      const ch = html[end];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    at = end + 1;

    const name = tag[2].toLowerCase();
    if (!tag[1] && OPAQUE.has(name)) {
      const close = new RegExp(`</${name}`, 'ig');
      close.lastIndex = at;
      const found = close.exec(html);
      at = found ? found.index : html.length;
    }
  }
}

const ENTITY = /&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][\da-zA-Z]*);?/y;
const decoded = new Map<string, string>();

function decodeEntity(entity: string): string {
  let value = decoded.get(entity);
  if (value === undefined) {
    value = parseHtml(`<!doctype html><body>${entity}`).body.textContent ?? entity;
    decoded.set(entity, value);
  }
  return value;
}

/** One character of source text: what it means, and how many characters of source it takes. */
function readUnit(html: string, at: number): { value: string; length: number } {
  const ch = html[at];
  if (ch === '\r') return { value: '\n', length: html[at + 1] === '\n' ? 2 : 1 };
  if (ch === '&') {
    ENTITY.lastIndex = at;
    const entity = ENTITY.exec(html)?.[0];
    if (entity) {
      const value = decodeEntity(entity);
      if (value !== entity) return { value, length: entity.length };
    }
  }
  return { value: ch, length: 1 };
}

/**
 * Where each character of the wanted nodes sits in the source, found by walking the
 * source and the DOM side by side. They agree character for character except for
 * whitespace the parser dropped. Anything else means the parser rearranged the markup,
 * so the walk gives up rather than guess. Text entries are one longer than the node's
 * data: the last is where the node ends.
 */
function mapOffsets(html: string, data: string[], wanted: Set<number>): Map<number, number[]> | null {
  const spans = textSpans(html);
  let span = spans.next();
  let at = span.done ? 0 : span.value[0];
  const offsets = new Map<number, number[]>();

  for (let n = 0; n < data.length; n++) {
    const text = data[n];
    const map: number[] | null = wanted.has(n) ? new Array<number>(text.length + 1) : null;
    let k = 0;
    while (k < text.length) {
      while (!span.done && at >= span.value[1]) {
        span = spans.next();
        if (!span.done) at = span.value[0];
      }
      if (span.done) return null;

      const unit = readUnit(html, at);
      if (text.startsWith(unit.value, k)) {
        if (map) for (let m = 0; m < unit.value.length; m++) map[k + m] = at;
        k += unit.value.length;
        at += unit.length;
      } else if (/^\s$/.test(unit.value)) {
        at += unit.length;
      } else {
        return null;
      }
    }
    if (map) {
      map[text.length] = at;
      offsets.set(n, map);
    }
  }
  return offsets;
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');

const isLowSurrogate = (ch: string | undefined) => ch !== undefined && ch >= '\uDC00' && ch <= '\uDFFF';

/** Carries changed text nodes into the source string. Null if the two cannot be lined up. */
function spliceText(source: string, nodes: Text[], original: string[]): string | null {
  const changed = new Set<number>();
  nodes.forEach((node, i) => {
    if (node.data !== original[i]) changed.add(i);
  });
  const offsets = mapOffsets(source, original, changed);
  if (!offsets) return null;

  const patches = [...changed].map((i) => {
    const before = original[i];
    const after = nodes[i].data;
    const limit = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < limit && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    // Two different emoji can share half a surrogate pair. The pair has to change whole.
    if (isLowSurrogate(before[prefix]) || isLowSurrogate(after[prefix])) prefix--;
    if (suffix > 0 && (isLowSurrogate(before[before.length - suffix]) || isLowSurrogate(after[after.length - suffix]))) suffix--;

    const map = offsets.get(i) as number[];
    return {
      start: map[prefix],
      end: map[before.length - suffix],
      text: escapeText(after.slice(prefix, after.length - suffix)),
    };
  });

  let result = source;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  }
  return result;
}

/* ---------- Plain text drafts ---------- */

export interface PlainBlock extends Block {
  /** Where the line starts in the body. */
  start: number;
  /** The line as it stands in the body. */
  raw: string;
}

/** The first line of what the writer did not write: a quote, a reply header, or a signature. */
function isPlainBoundary(lines: string[], index: number): boolean {
  const line = lines[index];
  if (/^>/.test(line) || /^-- ?$/.test(line) || /^_{10,}\s*$/.test(line) || ORIGINAL_MESSAGE.test(line)) return true;
  return HEADER_START.test(line) && HEADER_REST.test(lines.slice(index, index + 6).join('\n'));
}

export function readPlainBlocks(body: string): PlainBlock[] {
  const blocks: PlainBlock[] = [];
  const lines = body.split(/\r\n|\r|\n/);
  // Lines are measured in the source, whichever line ending it uses.
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (isPlainBoundary(lines, i)) break;
    if (raw.trim()) blocks.push({ text: raw.replace(/ /g, ' '), kind: 'paragraph', start, raw });
    start += raw.length;
    if (body[start] === '\r' && body[start + 1] === '\n') start += 2;
    else start += 1;
  }
  return blocks;
}

export function replacePlainBlock(source: string, was: string[], index: number, after: string): Patch {
  const block = findAgain(readPlainBlocks(source), (candidate) => candidate.text, was, index);
  if (!block) return { status: 'stale' };
  let line = block.raw;
  for (const edit of diffText(was[index], after).reverse()) {
    line = line.slice(0, edit.from) + edit.text + line.slice(edit.to);
  }
  return { status: 'ok', body: source.slice(0, block.start) + line + source.slice(block.start + block.raw.length) };
}
