import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addToDictionary,
  DEFAULT_SETTINGS,
  engineSettings,
  isSiteOn,
  loadDictionary,
  loadSettings,
  saveSettings,
  setSiteOn,
  splitDictionary,
} from '../../src/extension/shared/settings';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Enough of chrome.storage.sync to hold items, and to refuse what the real one refuses. */
function fakeStorage() {
  const items = new Map<string, unknown>();
  const sync = {
    get: async (key: string | null) =>
      Object.fromEntries([...items].filter(([name]) => key === null || name === key)),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        if (bytes(key) + bytes(value) > 8192) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
        items.set(key, value);
      }
    },
    remove: async (keys: string[]) => {
      for (const key of keys) items.delete(key);
    },
  };
  vi.stubGlobal('chrome', { storage: { sync } });
  return items;
}

describe('settings', () => {
  beforeEach(() => {
    fakeStorage();
  });

  it('starts on, with every check on', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(Object.values(DEFAULT_SETTINGS.checks)).toEqual([true, true, true, true]);
  });

  it('merges a partial save with what is there', async () => {
    await saveSettings({ dialect: 'british' });
    await saveSettings({ enabled: false });
    expect(await loadSettings()).toMatchObject({ dialect: 'british', enabled: false });
  });

  it('fills in a category added after the settings were saved', async () => {
    await saveSettings({ checks: { correctness: false } as never });
    const { checks } = await loadSettings();
    expect(checks).toEqual({ correctness: false, clarity: true, engagement: true, delivery: true });
  });

  it('checks a site only when both switches are on', () => {
    const settings = { ...DEFAULT_SETTINGS, disabledSites: ['mail.google.com'] };
    expect(isSiteOn(settings, 'outlook.office.com')).toBe(true);
    expect(isSiteOn(settings, 'mail.google.com')).toBe(false);
    expect(isSiteOn({ ...settings, enabled: false }, 'outlook.office.com')).toBe(false);
  });

  it('adds and removes a site without duplicates', () => {
    const off = setSiteOn(DEFAULT_SETTINGS, 'a.com', false);
    expect(off).toEqual(['a.com']);
    expect(setSiteOn({ ...DEFAULT_SETTINGS, disabledSites: off }, 'a.com', false)).toEqual(['a.com']);
    expect(setSiteOn({ ...DEFAULT_SETTINGS, disabledSites: off }, 'a.com', true)).toEqual([]);
  });

  it('builds engine settings with the writer\'s choices and an email goal', () => {
    const settings = engineSettings(
      { ...DEFAULT_SETTINGS, dialect: 'canadian', checks: { ...DEFAULT_SETTINGS.checks, delivery: false } },
      ['wordsmith'],
    );
    expect(settings).toMatchObject({ dialect: 'canadian', dictionary: ['wordsmith'] });
    expect(settings.checks.delivery).toBe(false);
    expect(settings.goals.domain).toBe('email');
  });
});

describe('the dictionary', () => {
  it('keeps words that fit in one item together', () => {
    expect(splitDictionary(['one', 'two'])).toEqual([['one', 'two']]);
    expect(splitDictionary([])).toEqual([]);
  });

  it('splits a long list so no item passes the 8 KB limit, counting bytes and not characters', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `naïveté-${i}`);
    const shards = splitDictionary(words);
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.flat()).toEqual(words);
    for (const shard of shards) expect(bytes(shard)).toBeLessThan(8192);
  });

  it('saves and loads words past the size of one item', async () => {
    const items = fakeStorage();
    const seed = Array.from({ length: 1500 }, (_, i) => `word${i}`);
    items.set('dictionary.0', seed);
    await addToDictionary('zebra');
    const loaded = await loadDictionary();
    expect(loaded).toHaveLength(1501);
    expect(loaded).toContain('zebra');
    expect([...items.keys()].length).toBeGreaterThan(1);
  });

  it('does not store a word twice', async () => {
    fakeStorage();
    await addToDictionary('wordsmith');
    await addToDictionary('wordsmith');
    expect(await loadDictionary()).toEqual(['wordsmith']);
  });

  it('does not touch other settings', async () => {
    fakeStorage();
    await saveSettings({ dialect: 'british' });
    await addToDictionary('wordsmith');
    expect((await loadSettings()).dialect).toBe('british');
  });
});
