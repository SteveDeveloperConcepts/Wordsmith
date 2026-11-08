/**
 * A tiny JSON settings file in the user-data folder for things the main process
 * owns: window placement, the encrypted API key, and the Check Anywhere settings.
 */
import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnywhereSettings, LiveSettings } from '@shared/api';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface Data {
  window?: WindowState;
  /** API key encrypted with safeStorage, base64-encoded. */
  aiKey?: string;
  anywhere?: AnywhereSettings;
  live?: LiveSettings;
  /** The writer has been told the app keeps running in the tray. */
  trayExplained?: boolean;
  lastDirectory?: string;
}

let cache: Data | null = null;

const file = () => join(app.getPath('userData'), 'wordsmith-settings.json');

function load(): Data {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(file(), 'utf8')) as Data;
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(cache ?? {}, null, 2), 'utf8');
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

export function get<K extends keyof Data>(key: K): Data[K] {
  return load()[key];
}

export function set<K extends keyof Data>(key: K, value: Data[K]): void {
  const data = load();
  if (value === undefined) delete data[key];
  else data[key] = value;
  save();
}
