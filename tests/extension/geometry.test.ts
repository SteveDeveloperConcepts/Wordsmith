import { describe, expect, it } from 'vitest';
import {
  clipPath,
  intersect,
  isScaled,
  mirrorBox,
  placeBadge,
  placeCard,
  pointInRects,
  type FieldMetrics,
} from '../../src/extension/content/geometry';

const metrics = (overrides: Partial<FieldMetrics> = {}): FieldMetrics => ({
  rect: { left: 100, top: 50, width: 304, height: 124 },
  borderLeft: 2,
  borderRight: 2,
  borderTop: 2,
  borderBottom: 2,
  clientLeft: 2,
  clientTop: 2,
  clientWidth: 300,
  clientHeight: 120,
  offsetWidth: 304,
  offsetHeight: 124,
  paddingTop: 8,
  paddingBottom: 8,
  multiline: true,
  ...overrides,
});

describe('the mirror', () => {
  it('sits on the field\'s padding box, inside the border', () => {
    expect(mirrorBox(metrics())).toEqual({ left: 102, top: 52, width: 300, height: 120, lineHeight: null });
  });

  it('narrows with a scrollbar, so text wraps where the field wraps it', () => {
    expect(mirrorBox(metrics({ clientWidth: 285 })).width).toBe(285);
  });

  it('moves right of a left-hand scrollbar in right-to-left text', () => {
    expect(mirrorBox(metrics({ clientLeft: 17, clientWidth: 285 })).left).toBe(117);
  });

  it('follows a page scroll through the field\'s rectangle', () => {
    const scrolled = metrics({ rect: { left: 100, top: -30, width: 304, height: 124 } });
    expect(mirrorBox(scrolled).top).toBe(-28);
  });

  // These are the numbers Chromium 158 reports for a 544 by 33 input with 2px borders and 6px 10px padding.
  const input = (overrides: Partial<FieldMetrics> = {}) =>
    metrics({
      multiline: false,
      rect: { left: 24, top: 24, width: 544, height: 33 },
      clientLeft: 12,
      clientTop: 2,
      clientWidth: 520,
      clientHeight: 29,
      offsetWidth: 544,
      offsetHeight: 33,
      paddingTop: 6,
      paddingBottom: 6,
      ...overrides,
    });

  it('goes by the borders of an input, whose client numbers include its side padding', () => {
    expect(mirrorBox(input())).toMatchObject({ left: 26, top: 26, width: 540, height: 29 });
  });

  it('centers a single line by making its line as tall as the content box', () => {
    expect(mirrorBox(input()).lineHeight).toBe(17);
  });

  it('never gives a negative line height to a squashed input', () => {
    const squashed = input({ rect: { left: 24, top: 24, width: 544, height: 12 }, offsetHeight: 12 });
    expect(mirrorBox(squashed).lineHeight).toBe(0);
  });

  it('notices a field drawn at a different size from its layout', () => {
    expect(isScaled(metrics())).toBe(false);
    expect(isScaled(metrics({ rect: { left: 0, top: 0, width: 456, height: 186 } }))).toBe(true);
    expect(isScaled(metrics({ rect: { left: 0, top: 0, width: 304.4, height: 124.4 } }))).toBe(false);
  });
});

describe('clipping to what can be seen', () => {
  it('finds the overlap of two boxes', () => {
    expect(
      intersect({ left: 0, top: 0, width: 100, height: 100 }, { left: 50, top: 60, width: 100, height: 100 }),
    ).toEqual({ left: 50, top: 60, width: 50, height: 40 });
  });

  it('finds no overlap between boxes that only touch', () => {
    expect(intersect({ left: 0, top: 0, width: 10, height: 10 }, { left: 10, top: 0, width: 10, height: 10 })).toBeNull();
  });

  it('cuts what a scrolled pane hides, and nothing else', () => {
    const box = { left: 100, top: 100, width: 200, height: 100 };
    expect(clipPath(box, box)).toBe('inset(0px 0px 0px 0px)');
    expect(clipPath(box, { left: 100, top: 130, width: 200, height: 40 })).toBe('inset(30px 0px 30px 0px)');
    expect(clipPath(box, { left: 120, top: 100, width: 150, height: 100 })).toBe('inset(0px 30px 0px 20px)');
  });
});

describe('placing the badge', () => {
  const size = { width: 30, height: 22 };

  it('sits in the bottom right corner of a tall field, clear of the resize grip', () => {
    const point = placeBadge({ left: 100, top: 100, width: 300, height: 200 }, size, true);
    expect(point).toEqual({ left: 352, top: 272 });
  });

  it('centers on a single line', () => {
    const point = placeBadge({ left: 100, top: 100, width: 300, height: 30 }, size, false);
    expect(point).toEqual({ left: 364, top: 104 });
  });

  it('stays inside a field smaller than itself', () => {
    const point = placeBadge({ left: 100, top: 100, width: 20, height: 12 }, size, false);
    expect(point).toEqual({ left: 100, top: 100 });
  });
});

describe('placing the card', () => {
  const card = { width: 300, height: 150 };
  const viewport = { width: 1000, height: 700 };

  it('opens below the text', () => {
    expect(placeCard({ left: 200, top: 100, width: 50, height: 18 }, card, viewport)).toEqual({ left: 200, top: 124 });
  });

  it('flips above text near the bottom of the window', () => {
    expect(placeCard({ left: 200, top: 650, width: 50, height: 18 }, card, viewport)).toEqual({ left: 200, top: 494 });
  });

  it('moves left to stay on screen', () => {
    expect(placeCard({ left: 900, top: 100, width: 50, height: 18 }, card, viewport).left).toBe(692);
  });

  it('stays on screen in a window too short to fit it either way', () => {
    const short = { width: 1000, height: 160 };
    const point = placeCard({ left: 200, top: 70, width: 50, height: 18 }, card, short);
    expect(point.top).toBe(8);
  });
});

describe('finding the pointer', () => {
  const rects = [
    { left: 10, top: 10, width: 100, height: 20 },
    { left: 10, top: 30, width: 40, height: 20 },
  ];

  it('finds the line of a wrapped underline', () => {
    expect(pointInRects(rects, 20, 40)).toBe(rects[1]);
  });

  it('counts the pixels just below the text, where the underline is drawn', () => {
    expect(pointInRects(rects, 20, 52)).toBe(rects[1]);
    expect(pointInRects(rects, 20, 54)).toBeNull();
  });

  it('misses beyond the end of a wrapped line', () => {
    expect(pointInRects(rects, 90, 40)).toBeNull();
  });
});
