/**
 * The writer's length target. The choice is kept in localStorage; the math is
 * plain functions so that it can be tested without rendering anything.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TextStats } from '@engine/types';
import { formatNumber, plural } from '../lib/format';

export type TargetUnit = 'words' | 'characters';

export interface LengthTarget {
  unit: TargetUnit;
  /** The target is met from this count up. 0 makes `max` a plain limit, such as an X post. */
  min: number;
  /** The target is met up to this count. */
  max: number;
}

export interface TargetPreset extends LengthTarget {
  id: string;
  label: string;
}

export const TARGET_PRESETS: TargetPreset[] = [
  { id: 'x-post', label: 'X post', unit: 'characters', min: 0, max: 280 },
  { id: 'text-message', label: 'Text message', unit: 'characters', min: 0, max: 160 },
  { id: 'short-email', label: 'Short email', unit: 'words', min: 50, max: 125 },
  { id: 'cover-letter', label: 'Cover letter', unit: 'words', min: 250, max: 400 },
  { id: 'college-essay', label: 'College essay', unit: 'words', min: 250, max: 650 },
  { id: 'blog-post', label: 'Blog post', unit: 'words', min: 1000, max: 1500 },
];

export const NO_TARGET = 'none';
export const CUSTOM_TARGET = 'custom';

export interface TargetChoice {
  /** A preset id, NO_TARGET, or CUSTOM_TARGET. */
  choice: string;
  customValue: number;
  customUnit: TargetUnit;
}

/** The target a choice stands for. A preset id saved by another version counts as no target. */
export function resolveTarget({ choice, customValue, customUnit }: TargetChoice): LengthTarget | null {
  if (choice === CUSTOM_TARGET) return { unit: customUnit, min: customValue, max: customValue };
  return TARGET_PRESETS.find((preset) => preset.id === choice) ?? null;
}

const nounFor = (unit: TargetUnit) => (unit === 'words' ? 'word' : 'character');

/** "280 characters", "50 to 125 words" */
export function describeTarget({ unit, min, max }: LengthTarget): string {
  const upper = plural(max, nounFor(unit));
  return min > 0 && min < max ? `${formatNumber(min)} to ${upper}` : upper;
}

/** The whole number typed into the custom target field, or null if it cannot be a target. */
export function parseTargetValue(raw: string): number | null {
  const value = Math.round(Number(raw));
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/** The count a target is measured against. */
export const targetCount = (target: LengthTarget, stats: Pick<TextStats, 'words' | 'characters'>): number =>
  target.unit === 'words' ? stats.words : stats.characters;

export interface TargetProgress {
  status: 'under' | 'met' | 'over';
  /** How far the writer is from the target, in plain words. */
  message: string;
  /** The count at the far end of the meter. */
  scale: number;
  /** Where the count sits on the meter, from 0 to 1. */
  fill: number;
  /** Where the edges of the target sit on the meter, from 0 to 1. */
  marks: number[];
}

/** The meter runs past the target, so that going over has somewhere to show. */
const METER_HEADROOM = 1.25;

export function targetProgress(target: LengthTarget, count: number): TargetProgress {
  const { min, max } = target;
  const noun = nounFor(target.unit);
  const isLimit = min === 0;
  const scale = Math.ceil(max * METER_HEADROOM);
  const meter = {
    scale,
    fill: Math.min(1, count / scale),
    marks: (min > 0 && min < max ? [min, max] : [max]).map((edge) => edge / scale),
  };

  if (count > max) {
    return { ...meter, status: 'over', message: `${plural(count - max, noun)} over the ${isLimit ? 'limit' : 'target'}` };
  }
  if (count < min) return { ...meter, status: 'under', message: `${plural(min - count, noun)} under the target` };
  return { ...meter, status: 'met', message: isLimit ? `${plural(max - count, noun)} left` : 'On target' };
}

interface TargetActions {
  choose(choice: string): void;
  setCustom(patch: Partial<Pick<TargetChoice, 'customValue' | 'customUnit'>>): void;
}

export const useTarget = create<TargetChoice & TargetActions>()(
  persist(
    (set) => ({
      choice: NO_TARGET,
      customValue: 500,
      customUnit: 'words',
      choose: (choice) => set({ choice }),
      setCustom: (patch) => set(patch),
    }),
    { name: 'wordsmith.target', version: 1 },
  ),
);
