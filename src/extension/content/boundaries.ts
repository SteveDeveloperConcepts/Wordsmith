/**
 * Where the writer's own text ends in a compose body. A reply carries the old
 * thread and a signature below the new text, and neither should be checked.
 *
 * The markers come from third-party parsers and open-source mail tools, not from
 * reading Outlook's or Gmail's code, so they can go out of date. An unknown marker
 * only means some quoted text gets checked; it cannot lose or change anything.
 */
import type { ReadOptions } from '@shared/html-text';

const QUOTE_IDS = new Set([
  'appendonsend',
  'divRplyFwdMsg',
  'OLK_SRC_BODY_SECTION',
  'mail-editor-reference-message-container',
]);
const QUOTE_CLASSES = ['gmail_quote', 'gmail_quote_container', 'gmail_extra', 'yahoo_quoted', 'moz-cite-prefix'];
const SIGNATURE_IDS = new Set(['Signature', 'ms-outlook-mobile-signature']);
const SIGNATURE_CLASSES = ['gmail_signature', 'gmail_signature_prefix', 'moz-signature', 'ms-outlook-mobile-signature'];

/** Bookmarks Word leaves above a quoted message and at the start of a signature. */
const WORD_BOOKMARK = /^_Mail(Original|AutoSig)$/;
/** The thin rule Word draws above a quoted message's From line. */
const WORD_SEPARATOR = /border-top:\s*solid\s+(#E1E1E1|#B5C4DF)/i;

const hasClass = (element: Element, names: string[]) => names.some((name) => element.classList.contains(name));

/** Gmail's Quote button marks text the same way, and the writer may keep typing below it. */
const isWritersQuote = (element: Element) =>
  element.localName === 'blockquote' && element.classList.contains('gmail_quote');

function startsQuotedThread(element: Element): boolean {
  if (isWritersQuote(element)) return false;
  return (
    QUOTE_IDS.has(element.id) ||
    hasClass(element, QUOTE_CLASSES) ||
    (element.localName === 'blockquote' && element.getAttribute('type') === 'cite') ||
    (element.localName === 'a' && WORD_BOOKMARK.test(element.getAttribute('name') ?? '')) ||
    WORD_SEPARATOR.test(element.getAttribute('style') ?? '')
  );
}

function isLeftOut(element: Element): boolean {
  return (
    SIGNATURE_IDS.has(element.id) ||
    hasClass(element, SIGNATURE_CLASSES) ||
    element.getAttribute('data-smartmail') === 'gmail_signature' ||
    isWritersQuote(element) ||
    // Chips and cards inside an editor. Their text cannot be edited, so a fix could never land.
    element.getAttribute('contenteditable') === 'false'
  );
}

export const READ_OPTIONS: ReadOptions = { stop: startsQuotedThread, skip: isLeftOut };
