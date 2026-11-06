/**
 * Turning the editor document into the plain-text blocks the engine analyzes,
 * while keeping a 1:1 mapping between text offsets and document positions.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Block, BlockKind } from '@engine/types';

export interface DocBlock extends Block {
  /** Document position just before the block; its text starts at `pos + 1`. */
  pos: number;
}

/** Stands in for content the checker should not read (inline code, embedded objects). */
const OPAQUE = '￼';

/**
 * The text of one text block, with exactly one character per document position:
 * a hard break becomes "\n" and inline code is masked out.
 */
export function blockText(node: PMNode): string {
  let out = '';
  node.forEach((child) => {
    if (child.isText) {
      const text = child.text ?? '';
      out += child.marks.some((m) => m.type.name === 'code') ? OPAQUE.repeat(text.length) : text;
    } else if (child.type.name === 'hardBreak') {
      out += '\n';
    } else {
      out += OPAQUE.repeat(child.nodeSize);
    }
  });
  return out;
}

export function extractBlocks(doc: PMNode): DocBlock[] {
  const blocks: DocBlock[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isTextblock) return true;
    let kind: BlockKind = 'paragraph';
    if (node.type.name === 'heading') kind = 'heading';
    else if (node.type.name === 'codeBlock') kind = 'code';
    else if (parent?.type.name === 'listItem') kind = 'list';
    else if (parent?.type.name === 'blockquote') kind = 'quote';
    blocks.push({ pos, kind, text: blockText(node) });
    return false;
  });
  return blocks;
}

/** Index of the block containing document position `pos`, or undefined. */
export function blockIndexAt(blocks: DocBlock[], pos: number): number | undefined {
  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].pos;
    if (pos > start && pos <= start + blocks[i].text.length + 1) return i;
  }
  return undefined;
}

const inlineText = (node: PMNode): string =>
  node.textBetween(0, node.content.size, undefined, (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''));

function childrenText(node: PMNode, separator: string): string {
  const parts: string[] = [];
  node.forEach((child) => parts.push(nodeText(child)));
  return parts.join(separator);
}

function nodeText(node: PMNode): string {
  const name = node.type.name;
  if (node.isTextblock) return inlineText(node);
  if (name === 'horizontalRule') return '———';
  if (name === 'bulletList' || name === 'orderedList') {
    const start = name === 'orderedList' ? Number(node.attrs.start ?? 1) : 0;
    const items: string[] = [];
    node.forEach((item, _offset, index) => {
      const marker = name === 'orderedList' ? `${start + index}. ` : '• ';
      const pad = ' '.repeat(marker.length);
      items.push(
        childrenText(item, '\n')
          .split('\n')
          .map((line, i) => (i === 0 ? marker : pad) + line)
          .join('\n'),
      );
    });
    return items.join('\n');
  }
  return childrenText(node, '\n\n');
}

/** The document as plain text: paragraphs separated by blank lines, lists with markers. */
export function plainText(doc: PMNode): string {
  return childrenText(doc, '\n\n').trim();
}
