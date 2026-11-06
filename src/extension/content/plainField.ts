/** A textarea or a single-line input. */
import type { Block } from '@engine/types';
import { hasFocus, type Field, type FormField, type PlacedIssue } from './field';
import { pointInRects } from './geometry';
import { Mirror } from './mirror';

export interface PlainBlock extends Block {
  /** Where this line starts in the field's value. */
  start: number;
}

/** One block per non-empty line, so offsets map straight back into the value. */
export function plainBlocks(value: string): PlainBlock[] {
  const blocks: PlainBlock[] = [];
  let start = 0;
  for (const line of value.split('\n')) {
    if (line.trim()) blocks.push({ text: line, kind: 'paragraph', start });
    start += line.length + 1;
  }
  return blocks;
}

function setNativeValue(field: FormField, value: string): void {
  const prototype = field.localName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // React and others wrap the element's own value property to watch for changes;
  // going around the wrapper means the input event below still looks like a change to them.
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
}

export class PlainField implements Field {
  readonly multiline: boolean;
  private blocks: PlainBlock[] = [];
  private readonly mirror: Mirror;

  constructor(
    readonly element: FormField,
    overlayRoot: ShadowRoot,
  ) {
    this.multiline = element.localName === 'textarea';
    this.mirror = new Mirror(element, overlayRoot);
  }

  read(): Block[] {
    this.blocks = plainBlocks(this.element.value);
    this.sync();
    return this.blocks;
  }

  rangeOf(block: number, from: number, to: number): Range | null {
    const target = this.blocks[block];
    return target ? this.mirror.range(target.start + from, target.start + to) : null;
  }

  caretBlock(): number | undefined {
    const caret = this.element.selectionEnd;
    if (caret === null || !hasFocus(this.element)) return undefined;
    const index = this.blocks.findIndex(({ start, text }) => caret >= start && caret <= start + text.length);
    return index === -1 ? undefined : index;
  }

  async replace(block: number, from: number, to: number, text: string): Promise<boolean> {
    const target = this.blocks[block];
    if (!target) return false;
    const { element } = this;
    const start = target.start + from;
    const end = target.start + to;
    const before = element.value;

    element.focus({ preventScroll: true });
    element.setSelectionRange(start, end);
    const doc = element.ownerDocument;
    const done = text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete');
    if (done && element.value !== before) return true;

    setNativeValue(element, before.slice(0, start) + text + before.slice(end));
    element.setSelectionRange(start + text.length, start + text.length);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    return true;
  }

  hitTest(x: number, y: number, placed: PlacedIssue[]): PlacedIssue | null {
    return placed.find(({ range }) => pointInRects(range.getClientRects(), x, y)) ?? null;
  }

  sync(): void {
    this.mirror.setValue(this.element.value);
  }

  layout(): void {
    this.sync();
    this.mirror.layout();
  }

  suspend(): void {
    this.mirror.hide();
  }
}
