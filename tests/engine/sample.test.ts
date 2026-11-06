/**
 * The welcome document is the first thing a new user sees, and its job is to
 * show every kind of suggestion. These tests fail if a rule change leaves one
 * of its deliberate mistakes unflagged.
 */
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '@engine/types';
import { SAMPLE_PARAGRAPHS } from '@renderer/lib/sample';
import { fullAnalyzer } from '../helpers';

describe('welcome document', async () => {
  const analyzer = fullAnalyzer();
  const result = await analyzer.analyze({ blocks: SAMPLE_PARAGRAPHS.map((text) => ({ text, kind: 'paragraph' as const })) });
  const flagged = result.issues.map((i) => i.text.toLowerCase());

  it('triggers every category', () => {
    for (const category of CATEGORIES) {
      expect(result.counts.byCategory[category], category).toBeGreaterThanOrEqual(2);
    }
  });

  it.each([
    'their',
    'alot',
    "you're",
    'less',
    'more',
    'make',
    'in order to',
    'was written',
    'in a timely manner',
    'absolutely essential',
    'utilize',
    'i think',
    'very good',
    'at the end of the day',
    'think outside the box',
    'hey guys',
    'gonna',
    'chairman',
    'today!!',
    'mistakes.',
  ])('flags "%s"', (text) => {
    expect(flagged).toContain(text);
  });

  it('leaves the intro paragraph alone', () => {
    expect(result.issues.filter((i) => i.block === 0)).toEqual([]);
  });

  it('gets a middling score, so there is something to improve', () => {
    expect(result.score).toBeGreaterThan(40);
    expect(result.score).toBeLessThan(85);
  });
});
