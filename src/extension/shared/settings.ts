/// <reference types="chrome" />
/**
 * Settings and the personal dictionary, kept in chrome.storage.sync so they
 * follow the writer between browsers.
 */
import {
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_GOALS,
  type Category,
  type Dialect,
  type EngineSettings,
} from '@engine/types';

export interface ExtensionSettings {
  enabled: boolean;
  /** Hostnames the writer turned off. */
  disabledSites: string[];
  dialect: Dialect;
  checks: Record<Category, boolean>;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  disabledSites: [],
  dialect: DEFAULT_ENGINE_SETTINGS.dialect,
  checks: DEFAULT_ENGINE_SETTINGS.checks,
};

const SETTINGS_KEY = 'settings';
const DICTIONARY_PREFIX = 'dictionary.';

/** storage.sync refuses items over 8 KB, so the word list is spread across keys. */
const MAX_SHARD_BYTES = 7000;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function splitDictionary(words: string[]): string[][] {
  const shards: string[][] = [];
  let shard: string[] = [];
  let size = 2;
  for (const word of words) {
    const cost = bytes(word) + 1;
    if (shard.length > 0 && size + cost > MAX_SHARD_BYTES) {
      shards.push(shard);
      shard = [];
      size = 2;
    }
    shard.push(word);
    size += cost;
  }
  if (shard.length > 0) shards.push(shard);
  return shards;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...saved, checks: { ...DEFAULT_SETTINGS.checks, ...saved?.checks } };
}

export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const settings = await loadSettings();
  await chrome.storage.sync.set({ [SETTINGS_KEY]: { ...settings, ...patch } });
}

export async function loadDictionary(): Promise<string[]> {
  const stored = await chrome.storage.sync.get(null);
  return Object.keys(stored)
    .filter((key) => key.startsWith(DICTIONARY_PREFIX))
    .flatMap((key) => stored[key] as string[]);
}

export async function addToDictionary(word: string): Promise<void> {
  const stored = await chrome.storage.sync.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(DICTIONARY_PREFIX));
  const words = new Set(keys.flatMap((key) => stored[key] as string[]));
  words.add(word);
  const shards = splitDictionary([...words].sort());
  const items = Object.fromEntries(shards.map((shard, i) => [`${DICTIONARY_PREFIX}${i}`, shard]));
  await chrome.storage.sync.set(items);
  const stale = keys.filter((key) => !(key in items));
  if (stale.length > 0) await chrome.storage.sync.remove(stale);
}

export function engineSettings(settings: ExtensionSettings, dictionary: string[]): EngineSettings {
  return {
    ...DEFAULT_ENGINE_SETTINGS,
    // The extension is mostly used in webmail, so it checks text as email.
    goals: { ...DEFAULT_GOALS, domain: 'email' },
    dialect: settings.dialect,
    checks: settings.checks,
    dictionary,
  };
}

export const isSiteOn = (settings: ExtensionSettings, hostname: string): boolean =>
  settings.enabled && !settings.disabledSites.includes(hostname);

export function setSiteOn(settings: ExtensionSettings, hostname: string, on: boolean): string[] {
  const others = settings.disabledSites.filter((site) => site !== hostname);
  return on ? others : [...others, hostname];
}

export function onSettingsChanged(listener: () => void): void {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') listener();
  });
}
