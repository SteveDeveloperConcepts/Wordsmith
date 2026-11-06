/**
 * Reading plain text out of HTML, and writing edits back without disturbing the
 * markup around them.
 *
 * Outlook add-ins can only replace a draft's whole body, and text pasted back
 * into another app replaces the whole selection. Sending plain text either way
 * would strip bold, links, and fonts, so fixes are applied to the original HTML:
 * every character of the extracted text remembers where it lives in the DOM, and
 * an edit changes only the text nodes it touches.
 */
import type { Block, BlockKind } from '@engine/types';

/** A change to a block's text. Offsets are UTF-16 code units. */
export interface TextEdit {
  from: number;
  to: number;
  text: string;
}

/** Where one character of a block's text came from. */
interface Source {
  node: Text;
  /** Range in `node.data`. Wider than one character where whitespace was collapsed. */
  start: number;
  end: number;
}

export interface HtmlBlock extends Block {
  /** One entry per code unit of `text`; null where there is no text node (line breaks, images). */
  sources: Array<Source | null>;
}

export interface ReadOptions {
  /** Leave out this element and everything inside it: quoted replies, signatures. */
  skip?(element: Element): boolean;
  /**
   * Stop reading here, leaving out this element and all that follows it. A reply's
   * quoted thread usually runs to the end of the message without a single wrapper.
   */
  stop?(element: Element): boolean;
}

/** Stands in for an inline object such as an image, so offsets stay honest. */
const OBJECT = '￼';

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dir', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const IGNORED_TAGS = new Set([
  'base', 'head', 'link', 'meta', 'noscript', 'object', 'script', 'style', 'svg', 'template', 'title', 'xml',
]);

const OBJECT_TAGS = new Set(['img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'embed']);

function kindOf(tag: string): BlockKind | null {
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'li') return 'list';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'pre') return 'code';
  return null;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** ASCII whitespace plus the non-breaking space mail clients use between words. */
const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === ' ';

/**
 * Extract the text of an element as blocks, one per paragraph-like element.
 * Whitespace is collapsed as a browser would render it, and non-breaking spaces
 * read as plain spaces, so the checker sees the text the writer sees.
 */
export function readBlocks(root: Element, options: ReadOptions = {}): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  let text = '';
  let sources: Array<Source | null> = [];
  let kind: BlockKind = 'paragraph';
  let stopped = false;

  const flush = () => {
    let end = text.length;
    while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\n')) end--;
    if (end > 0) blocks.push({ text: text.slice(0, end), kind, sources: sources.slice(0, end) });
    text = '';
    sources = [];
  };

  const appendText = (node: Text, preserve: boolean) => {
    const data = node.data;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (preserve) {
        text += ch === ' ' ? ' ' : ch;
        sources.push({ node, start: i, end: i + 1 });
        i++;
      } else if (isSpace(ch)) {
        let j = i + 1;
        while (j < data.length && isSpace(data[j])) j++;
        // Leading space in a block, or a space after a space, renders as nothing.
        if (text.length > 0 && text[text.length - 1] !== ' ' && text[text.length - 1] !== '\n') {
          text += ' ';
          sources.push({ node, start: i, end: j });
        }
        i = j;
      } else {
        text += ch;
        sources.push({ node, start: i, end: i + 1 });
        i++;
      }
    }
  };

  const walk = (parent: Node, preserve: boolean) => {
    for (let child = parent.firstChild; child && !stopped; child = child.nextSibling) {
      if (child.nodeType === TEXT_NODE) {
        appendText(child as Text, preserve);
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.localName.toLowerCase();
      if (IGNORED_TAGS.has(tag)) continue;
      if (options.stop?.(element)) {
        flush();
        stopped = true;
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (options.skip?.(element)) {
        if (block) flush();
        continue;
      }
      if (tag === 'br') {
        if (text.length > 0) {
          // A space before a line break renders as nothing.
          if (text[text.length - 1] === ' ') {
            text = text.slice(0, -1);
            sources.pop();
          }
          text += '\n';
          sources.push(null);
        }
      } else if (OBJECT_TAGS.has(tag)) {
        text += OBJECT;
        sources.push(null);
      } else if (block) {
        flush();
        const outer = kind;
        kind = kindOf(tag) ?? kind;
        walk(element, preserve || tag === 'pre');
        flush();
        kind = outer;
      } else {
        walk(element, preserve);
      }
    }
  };

  walk(root, false);
  flush();
  return blocks;
}

/** Apply one edit to the DOM. Earlier offsets in the block stay valid; later ones do not. */
function applyEdit(block: HtmlBlock, edit: TextEdit): boolean {
  const { sources } = block;
  const write = (node: Text, start: number, end: number, value: string) => {
    node.data = node.data.slice(0, start) + value + node.data.slice(end);
  };

  if (edit.from === edit.to) {
    // Join the text before the insertion point, so that a new comma takes on the word's formatting.
    for (let i = edit.from - 1; i >= 0; i--) {
      const source = sources[i];
      if (source) {
        write(source.node, source.end, source.end, edit.text);
        return true;
      }
    }
    const next = sources.slice(edit.from).find(Boolean);
    if (!next) return false;
    write(next.node, next.start, next.start, edit.text);
    return true;
  }

  // Runs of characters that sit in one text node, in document order.
  const runs: Source[] = [];
  for (let i = edit.from; i < edit.to; i++) {
    const source = sources[i];
    if (!source) continue;
    const last = runs[runs.length - 1];
    if (last && last.node === source.node && last.end === source.start) last.end = source.end;
    else runs.push({ ...source });
  }
  if (runs.length === 0) return false;

  // Delete the later runs first, so the first run's offsets stay valid. The
  // replacement goes in the first run, so it takes on that run's formatting.
  for (let i = runs.length - 1; i > 0; i--) write(runs[i].node, runs[i].start, runs[i].end, '');
  write(runs[0].node, runs[0].start, runs[0].end, edit.text);
  return true;
}

/**
 * Apply edits to one block, changing the underlying DOM. The block is spent
 * afterwards: read the blocks again before making further edits.
 * Returns false if any edit could not be placed.
 */
export function applyEdits(block: HtmlBlock, edits: TextEdit[]): boolean {
  const ordered = [...edits].sort((a, b) => b.from - a.from || b.to - a.to);
  let end = Infinity;
  for (const edit of ordered) {
    if (edit.from < 0 || edit.to > block.text.length || edit.from > edit.to || edit.to > end) return false;
    end = edit.from;
  }
  let ok = true;
  for (const edit of ordered) ok = applyEdit(block, edit) && ok;
  return ok;
}

const TOKEN = /\s+|[\p{L}\p{N}'’-]+|./gsu;

/** Above this many table cells the comparison would be slow; one big edit is returned instead. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * The smallest word-level edits that turn `before` into `after`, so that a change
 * to one word leaves the formatting of every other word alone.
 */
export function diffText(before: string, after: string): TextEdit[] {
  if (before === after) return [];

  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const tokensA = a.match(TOKEN) ?? [];
  const tokensB = b.match(TOKEN) ?? [];
  const whole: TextEdit = { from: prefix, to: before.length - suffix, text: b };
  if (tokensA.length === 0 || tokensB.length === 0 || tokensA.length * tokensB.length > MAX_DIFF_CELLS) return [whole];

  // Longest common subsequence of tokens.
  const width = tokensB.length + 1;
  const table = new Uint32Array((tokensA.length + 1) * width);
  for (let i = tokensA.length - 1; i >= 0; i--) {
    for (let j = tokensB.length - 1; j >= 0; j--) {
      table[i * width + j] =
        tokensA[i] === tokensB[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const edits: TextEdit[] = [];
  let i = 0;
  let j = 0;
  let offset = prefix;
  let pending: TextEdit | null = null;
  const take = (from: number, to: number, text: string) => {
    if (pending && pending.to === from) {
      pending.to = to;
      pending.text += text;
    } else {
      if (pending) edits.push(pending);
      pending = { from, to, text };
    }
  };
  while (i < tokensA.length || j < tokensB.length) {
    if (i < tokensA.length && j < tokensB.length && tokensA[i] === tokensB[j]) {
      offset += tokensA[i].length;
      i++;
      j++;
    } else if (j < tokensB.length && (i === tokensA.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
      take(offset, offset, tokensB[j]);
      j++;
    } else {
      take(offset, offset + tokensA[i].length, '');
      offset += tokensA[i].length;
      i++;
    }
  }
  if (pending) edits.push(pending);
  return edits;
}
