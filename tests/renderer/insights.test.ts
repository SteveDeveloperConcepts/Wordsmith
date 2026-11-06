// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Issue } from '@engine/types';
import { suggestionRows } from '@renderer/assistant/InsightsTab';
import {
  CUSTOM_TARGET,
  NO_TARGET,
  describeTarget,
  parseTargetValue,
  resolveTarget,
  targetCount,
  targetProgress,
} from '@renderer/state/target';

const issue = (type: Issue['type'], category: Issue['category']) => ({ type, category }) as Issue;

describe('targetProgress', () => {
  const email = { unit: 'words', min: 50, max: 125 } as const;
  const post = { unit: 'characters', min: 0, max: 280 } as const;

  it('says how far under a range the writer is', () => {
    const progress = targetProgress(email, 20);
    expect(progress.status).toBe('under');
    expect(progress.message).toBe('30 words under the target');
  });

  it('counts both ends of a range as on target', () => {
    expect(targetProgress(email, 50).status).toBe('met');
    expect(targetProgress(email, 125).status).toBe('met');
    expect(targetProgress(email, 80).message).toBe('On target');
  });

  it('says how far over a range the writer is', () => {
    const progress = targetProgress(email, 126);
    expect(progress.status).toBe('over');
    expect(progress.message).toBe('1 word over the target');
  });

  it('treats a target with no minimum as a limit', () => {
    expect(targetProgress(post, 0).message).toBe('280 characters left');
    expect(targetProgress(post, 279).message).toBe('1 character left');
    expect(targetProgress(post, 300).message).toBe('20 characters over the limit');
  });

  it('marks both edges of a range on the meter, and leaves room past the end', () => {
    const { marks, scale, fill } = targetProgress(email, 200);
    expect(marks).toHaveLength(2);
    expect(scale).toBeGreaterThan(email.max);
    expect(fill).toBe(1);
    expect(targetProgress(post, 10).marks).toHaveLength(1);
  });
});

describe('choosing a target', () => {
  it('resolves presets, custom targets, and no target', () => {
    const base = { customValue: 300, customUnit: 'characters' } as const;
    expect(resolveTarget({ ...base, choice: NO_TARGET })).toBeNull();
    expect(resolveTarget({ ...base, choice: 'x-post' })).toMatchObject({ unit: 'characters', max: 280 });
    expect(resolveTarget({ ...base, choice: CUSTOM_TARGET })).toEqual({ unit: 'characters', min: 300, max: 300 });
    expect(resolveTarget({ ...base, choice: 'removed-in-a-later-version' })).toBeNull();
  });

  it('describes targets in words', () => {
    expect(describeTarget({ unit: 'characters', min: 0, max: 280 })).toBe('280 characters');
    expect(describeTarget({ unit: 'words', min: 1000, max: 1500 })).toBe('1,000 to 1,500 words');
    expect(describeTarget({ unit: 'words', min: 1, max: 1 })).toBe('1 word');
  });

  it('accepts only whole positive numbers as custom targets', () => {
    expect(parseTargetValue('250')).toBe(250);
    expect(parseTargetValue('12.6')).toBe(13);
    expect(parseTargetValue('0')).toBeNull();
    expect(parseTargetValue('-4')).toBeNull();
    expect(parseTargetValue('lots')).toBeNull();
  });

  it('measures words or characters', () => {
    const stats = { words: 12, characters: 70 };
    expect(targetCount({ unit: 'words', min: 0, max: 1 }, stats)).toBe(12);
    expect(targetCount({ unit: 'characters', min: 0, max: 1 }, stats)).toBe(70);
  });
});

describe('suggestionRows', () => {
  it('counts each kind of issue, in the usual order', () => {
    const rows = suggestionRows([
      issue('tone', 'delivery'),
      issue('spelling', 'correctness'),
      issue('spelling', 'correctness'),
    ]);
    expect(rows.map((r) => [r.type, r.count])).toEqual([
      ['spelling', 2],
      ['tone', 1],
    ]);
  });

  it('filters across categories when a kind spans more than one', () => {
    const rows = suggestionRows([issue('sentence', 'correctness'), issue('sentence', 'clarity')]);
    expect(rows).toEqual([{ type: 'sentence', count: 2, category: 'all' }]);
  });

  it('keeps the category when a kind stays in one', () => {
    expect(suggestionRows([issue('grammar', 'correctness')])[0].category).toBe('correctness');
  });
});
