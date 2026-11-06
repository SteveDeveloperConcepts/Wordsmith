/// <reference types="chrome" />
/** What the rest of the content script needs from a field, and how fields are found. */
import type { Block, Issue } from '@engine/types';
import { isWebmailHost } from '../shared/sites';

export interface PlacedIssue {
  issue: Issue;
  /** Live, so it follows the text as the page edits around it. */
  range: Range;
  /** The block's text when it was checked, to detect a change before a fix is applied. */
  blockText: string;
}

export interface Field {
  readonly element: HTMLElement;
  /** Read the text afresh. Block numbers passed to the other methods refer to this reading. */
  read(): Block[];
  rangeOf(block: number, from: number, to: number): Range | null;
  caretBlock(): number | undefined;
  /** Replace text through the page's own editing path. False if the edit could not be made. */
  replace(block: number, from: number, to: number, text: string): Promise<boolean>;
  hitTest(x: number, y: number, placed: PlacedIssue[]): PlacedIssue | null;
  /** Bring what the field draws in line with the text as it is now. */
  sync(): void;
  /** Keep what the field draws in line with where the field is now. */
  layout(): void;
  /** Stop drawing until the field becomes active again. */
  suspend(): void;
  /** Whether the field can hold more than one line, which decides where the badge goes. */
  readonly multiline: boolean;
}

export type FormField = HTMLTextAreaElement | HTMLInputElement;

export const isFormField = (element: Element): element is FormField =>
  element.localName === 'textarea' || (element.localName === 'input' && (element as HTMLInputElement).type === 'text');

const isEditableValue = (value: string | null) => value === '' || value === 'true' || value === 'plaintext-only';

/** The outermost element that makes this one editable. */
export function editingHost(element: Element): HTMLElement | null {
  let host: HTMLElement | null = null;
  for (let el: Element | null = element; el; el = el.parentElement) {
    const value = el.getAttribute('contenteditable');
    if (value === 'false') break;
    if (isEditableValue(value)) host = el as HTMLElement;
  }
  return host;
}

const NON_PROSE_ROLES = new Set(['combobox', 'listbox', 'searchbox', 'spinbutton']);

/** A name, an address, or a card number: not prose, and nothing the checker should read. */
function holdsPersonalData(field: HTMLElement): boolean {
  const token = field.getAttribute('autocomplete');
  return token !== null && token !== '' && token !== 'on' && token !== 'off';
}
const RECIPIENT_LABEL = /^(to|cc|bcc)\b/i;

/** Webmail and some rich editors turn off the browser's checker to offer their own, not because the text is code. */
function spellcheckFlagMeansCode(field: HTMLElement, hostname: string): boolean {
  if (isWebmailHost(hostname)) return false;
  return field.getAttribute('data-lexical-editor') !== 'true' && !field.classList.contains('ql-editor');
}

function isProse(field: HTMLElement, hostname: string): boolean {
  if (isFormField(field) && (field.readOnly || field.disabled || holdsPersonalData(field))) return false;
  if (field.getAttribute('data-gramm') === 'false' || field.getAttribute('data-enable-grammarly') === 'false') {
    return false;
  }
  if (field.getAttribute('spellcheck') === 'false' && spellcheckFlagMeansCode(field, hostname)) return false;
  if (field.getAttribute('aria-multiline') === 'true') return true;
  return (
    !NON_PROSE_ROLES.has(field.getAttribute('role') ?? '') &&
    !field.hasAttribute('aria-autocomplete') &&
    !RECIPIENT_LABEL.test(field.getAttribute('aria-label') ?? '')
  );
}

/** The field to check when `element` has focus, or null if it does not hold prose. */
export function checkableField(element: Element | null, hostname: string): HTMLElement | null {
  if (!element) return null;
  const field = isFormField(element) ? element : editingHost(element);
  return field && isProse(field, hostname) ? field : null;
}

/** The element's parent, stepping out of a shadow root to its host. */
export const parentAcrossShadow = (element: Element): Element | null =>
  element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null;

/** Whether this field has focus, in its own document or shadow root. */
export const hasFocus = (element: HTMLElement): boolean =>
  (element.getRootNode() as Document | ShadowRoot).activeElement === element;

/** Code editors type into a hidden sliver of a textarea, which is not a field a person sees. */
export const isBigEnough = (element: HTMLElement): boolean => element.offsetWidth >= 40 && element.offsetHeight >= 12;

/** The focused element, looking inside shadow roots, including closed ones the page cannot be asked about. */
export function deepActiveElement(doc: Document): Element | null {
  let element = doc.activeElement;
  while (element) {
    // The chrome.dom call throws for anything but an HTML element, such as a focused SVG.
    const root = element instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot?.(element) : element.shadowRoot;
    if (!root?.activeElement) break;
    element = root.activeElement;
  }
  return element;
}
