/** A contenteditable field: an email body or any rich text editor. */
import type { Block } from '@engine/types';
import { readBlocks, type HtmlBlock } from '@shared/html-text';
import { READ_OPTIONS } from './boundaries';
import { hasFocus, type Field, type PlacedIssue } from './field';
import { pointInRects } from './geometry';
import { blockAt, blockRange, sameFlaggedText } from './offsets';

/**
 * Slate and CKEditor hold the text in their own model and ignore or undo changes
 * they are not told about first. Chrome's execCommand does not fire beforeinput,
 * so they are told with a synthetic one, which they apply and cancel.
 */
const NEEDS_BEFOREINPUT = '[data-slate-editor], .ck-editor__editable';

const SELECTION_WAIT_MS = 50;

function offerToEditor(root: HTMLElement, range: Range, text: string): boolean {
  if (!root.matches(NEEDS_BEFOREINPUT)) return false;
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertReplacementText',
    data: text,
    targetRanges: [new StaticRange(range)],
  });
  root.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Rich editors learn of a new selection from the selectionchange event, which fires
 * after a task. Editing before that lands on the editor's old selection, leaving the
 * flagged word in place with the fix typed at the caret.
 */
function selectionSettled(doc: Document): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      doc.removeEventListener('selectionchange', done);
      setTimeout(resolve);
    };
    // Selecting what is already selected fires nothing.
    const timer = setTimeout(done, SELECTION_WAIT_MS);
    doc.addEventListener('selectionchange', done);
  });
}

function caretAt(doc: Document, x: number, y: number, tree: Node): { node: Node; offset: number } | null {
  if (doc.caretPositionFromPoint) {
    const shadowRoots = tree instanceof ShadowRoot ? [tree] : [];
    const position = doc.caretPositionFromPoint(x, y, { shadowRoots });
    return position && { node: position.offsetNode, offset: position.offset };
  }
  const range = doc.caretRangeFromPoint(x, y);
  return range && { node: range.startContainer, offset: range.startOffset };
}

export class RichField implements Field {
  readonly multiline = true;
  private blocks: HtmlBlock[] = [];

  constructor(readonly element: HTMLElement) {}

  private get doc(): Document {
    return this.element.ownerDocument;
  }

  read(): Block[] {
    this.blocks = readBlocks(this.element, READ_OPTIONS);
    return this.blocks;
  }

  rangeOf(block: number, from: number, to: number): Range | null {
    const target = this.blocks[block];
    return target ? blockRange(target, from, to) : null;
  }

  caretBlock(): number | undefined {
    const selection = this.doc.getSelection();
    if (!selection || !hasFocus(this.element)) return undefined;
    return blockAt(this.blocks, selection.focusNode, selection.focusOffset);
  }

  async replace(block: number, from: number, to: number, text: string): Promise<boolean> {
    const target = this.blocks[block];
    const range = target ? blockRange(target, from, to) : null;
    const selection = this.doc.getSelection();
    if (!range || !selection) return false;

    this.element.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    await selectionSettled(this.doc);
    // If the selection did not take, or the page moved it, an insert would land in the wrong place.
    if (!sameFlaggedText(selection.toString(), target.text.slice(from, to))) return false;

    if (offerToEditor(this.element, range, text)) return true;
    return text ? this.doc.execCommand('insertText', false, text) : this.doc.execCommand('delete');
  }

  hitTest(x: number, y: number, placed: PlacedIssue[]): PlacedIssue | null {
    const caret = caretAt(this.doc, x, y, this.element.getRootNode());
    if (!caret) return null;
    // The caret snaps to the nearest text however far away the pointer is, so check the pointer too.
    const hit = placed.find(({ range }) => range.isPointInRange(caret.node, caret.offset));
    return hit && pointInRects(hit.range.getClientRects(), x, y) ? hit : null;
  }

  sync(): void {}

  layout(): void {}

  suspend(): void {}
}
