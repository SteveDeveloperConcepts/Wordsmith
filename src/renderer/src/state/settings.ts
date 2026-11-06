/**
 * App-wide preferences, kept in localStorage.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_GOALS,
  type Category,
  type Dialect,
  type EngineSettings,
  type Goals,
} from '@engine/types';
import { DEFAULT_AI_MODEL } from '@shared/ai-types';
import type { ThemeChoice } from '@shared/api';

export type EditorFont = 'serif' | 'sans';

export interface SettingsData {
  theme: ThemeChoice;
  dialect: Dialect;
  checks: Record<Category, boolean>;
  options: EngineSettings['options'];
  disabledRules: string[];
  dictionary: string[];
  /** Goals given to new documents. */
  defaultGoals: Goals;
  editorFont: EditorFont;
  /** Editor text size in pixels. */
  editorSize: number;
  aiModel: string;
  libraryOpen: boolean;
  assistantOpen: boolean;
  /** Browser build only: the API key lives in this browser's storage. */
  webApiKey: string;
}

interface SettingsActions {
  update(patch: Partial<SettingsData>): void;
  setCheck(category: Category, on: boolean): void;
  setOption(option: keyof EngineSettings['options'], on: boolean): void;
  addWord(word: string): void;
  removeWord(word: string): void;
  disableRule(ruleId: string): void;
  enableRule(ruleId: string): void;
}

const DEFAULTS: SettingsData = {
  theme: 'system',
  dialect: DEFAULT_ENGINE_SETTINGS.dialect,
  checks: DEFAULT_ENGINE_SETTINGS.checks,
  options: DEFAULT_ENGINE_SETTINGS.options,
  disabledRules: [],
  dictionary: [],
  defaultGoals: DEFAULT_GOALS,
  editorFont: 'serif',
  editorSize: 18,
  aiModel: DEFAULT_AI_MODEL,
  libraryOpen: true,
  assistantOpen: true,
  webApiKey: '',
};

export const useSettings = create<SettingsData & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      update: (patch) => set(patch),
      setCheck: (category, on) => set((s) => ({ checks: { ...s.checks, [category]: on } })),
      setOption: (option, on) => set((s) => ({ options: { ...s.options, [option]: on } })),
      addWord: (word) =>
        set((s) => {
          const w = word.trim();
          if (!w || s.dictionary.some((d) => d.toLowerCase() === w.toLowerCase())) return s;
          return { dictionary: [...s.dictionary, w].sort((a, b) => a.localeCompare(b)) };
        }),
      removeWord: (word) => set((s) => ({ dictionary: s.dictionary.filter((d) => d !== word) })),
      disableRule: (ruleId) =>
        set((s) => (s.disabledRules.includes(ruleId) ? s : { disabledRules: [...s.disabledRules, ruleId] })),
      enableRule: (ruleId) => set((s) => ({ disabledRules: s.disabledRules.filter((r) => r !== ruleId) })),
    }),
    {
      name: 'wordsmith.settings',
      version: 1,
      // Merge so that settings added in later versions pick up their defaults.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsData>;
        return {
          ...current,
          ...saved,
          checks: { ...current.checks, ...saved.checks },
          options: { ...current.options, ...saved.options },
          defaultGoals: { ...current.defaultGoals, ...saved.defaultGoals },
        };
      },
    },
  ),
);

// The main window and the quick window share these settings, so that a word added
// to the dictionary in one takes effect in the other.
window.addEventListener('storage', (event) => {
  if (event.key === useSettings.persist.getOptions().name) void useSettings.persist.rehydrate();
});

/** The engine configuration for a document with the given goals. */
export function engineSettings(s: SettingsData, goals: Goals): EngineSettings {
  return {
    dialect: s.dialect,
    goals,
    checks: s.checks,
    options: s.options,
    disabledRules: s.disabledRules,
    dictionary: s.dictionary,
  };
}

/** Resolve "system" to the theme the operating system is using. */
export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
