/** Position math for the mirror, the badge, and the card. No DOM access, so it can be tested alone. */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  left: number;
  top: number;
}

/** What is measured from a textarea or input. */
export interface FieldMetrics {
  rect: Box;
  borderLeft: number;
  borderRight: number;
  borderTop: number;
  borderBottom: number;
  /** Include a left scrollbar in right-to-left text, which plain border widths would miss. */
  clientLeft: number;
  clientTop: number;
  /** Exclude scrollbars, so text in the mirror wraps at the same width as in the field. */
  clientWidth: number;
  clientHeight: number;
  offsetWidth: number;
  offsetHeight: number;
  paddingTop: number;
  paddingBottom: number;
  multiline: boolean;
}

export interface MirrorBox extends Box {
  /** Set for single-line inputs, which center their text in whatever height they are given. */
  lineHeight: number | null;
}

/** The mirror covers the field's padding box. Padding is copied, so content boxes match too. */
export function mirrorBox(field: FieldMetrics): MirrorBox {
  const { rect } = field;
  if (field.multiline) {
    return {
      left: rect.left + field.clientLeft,
      top: rect.top + field.clientTop,
      width: field.clientWidth,
      height: field.clientHeight,
      lineHeight: null,
    };
  }
  // Chromium folds an input's side padding into its clientLeft and clientWidth, so
  // those cannot be used here. Inputs have no scrollbars for them to allow for anyway.
  const height = rect.height - field.borderTop - field.borderBottom;
  return {
    left: rect.left + field.borderLeft,
    top: rect.top + field.borderTop,
    width: rect.width - field.borderLeft - field.borderRight,
    height,
    lineHeight: Math.max(height - field.paddingTop - field.paddingBottom, 0),
  };
}

/**
 * A transform or zoom makes the field's drawn size differ from its layout size.
 * Text in the mirror would drift out of line, and no underline is better than a wrong one.
 */
export const isScaled = (field: FieldMetrics): boolean =>
  Math.abs(field.rect.width - field.offsetWidth) > 1 || Math.abs(field.rect.height - field.offsetHeight) > 1;

export function intersect(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** A clip-path that hides the parts of `box` outside `visible`, for fields in scrolled panes. */
export function clipPath(box: Box, visible: Box): string {
  const top = Math.max(visible.top - box.top, 0);
  const left = Math.max(visible.left - box.left, 0);
  const bottom = Math.max(box.top + box.height - (visible.top + visible.height), 0);
  const right = Math.max(box.left + box.width - (visible.left + visible.width), 0);
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`;
}

const BADGE_INSET = 6;
/** Keeps the badge clear of a textarea's resize grip and scrollbar. */
const BADGE_GRIP = 18;

/** The bottom right corner of a field, or the right end of one too short for a corner. */
export function placeBadge(field: Box, badge: Size, multiline: boolean): Point {
  const left = field.left + field.width - badge.width - (multiline ? BADGE_GRIP : BADGE_INSET);
  const top = multiline
    ? field.top + field.height - badge.height - BADGE_INSET
    : field.top + (field.height - badge.height) / 2;
  return { left: Math.max(left, field.left), top: Math.max(top, field.top) };
}

const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;

/** Below the flagged text if there is room, otherwise above it, and always on screen. */
export function placeCard(anchor: Box, card: Size, viewport: Size): Point {
  const below = anchor.top + anchor.height + CARD_GAP;
  const above = anchor.top - card.height - CARD_GAP;
  const fitsBelow = below + card.height <= viewport.height - VIEWPORT_MARGIN;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  const top = fitsBelow || !fitsAbove ? below : above;

  const maxLeft = viewport.width - card.width - VIEWPORT_MARGIN;
  const maxTop = viewport.height - card.height - VIEWPORT_MARGIN;
  return {
    left: Math.max(Math.min(anchor.left, maxLeft), VIEWPORT_MARGIN),
    top: Math.max(Math.min(top, maxTop), VIEWPORT_MARGIN),
  };
}

/** Rectangles are slightly widened downward because an underline is drawn below the text's box. */
export function pointInRects(rects: Iterable<Box>, x: number, y: number, slop = 3): Box | null {
  for (const rect of rects) {
    const inX = x >= rect.left && x <= rect.left + rect.width;
    const inY = y >= rect.top && y <= rect.top + rect.height + slop;
    if (inX && inY) return rect;
  }
  return null;
}
