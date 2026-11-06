import { CircleCheck, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  CATEGORIES,
  CATEGORY_HINT,
  CATEGORY_LABEL,
  DEFAULT_ENGINE_SETTINGS,
  DIALECT_LABEL,
  type Category,
  type Dialect,
  type EngineSettings,
} from '@engine/types';
import { AI_MODELS } from '@shared/ai-types';
import type { ThemeChoice } from '@shared/api';
import { plural } from '../lib/format';
import { desktop } from '../platform';
import { useSession } from '../state/session';
import { useSettings, type EditorFont } from '../state/settings';
import { Dialog } from './Dialog';
import { IntegrationsSection } from './IntegrationsSection';
import { Group, OutLink, Setting, Switch } from './settingsParts';
import '../styles/settings.css';

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const FONTS: Array<{ value: EditorFont; label: string }> = [
  { value: 'serif', label: 'Serif' },
  { value: 'sans', label: 'Sans' },
];

const DIALECTS = Object.keys(DIALECT_LABEL) as Dialect[];

const MIN_TEXT_SIZE = 14;
const MAX_TEXT_SIZE = 24;

interface CheckOption {
  option: keyof EngineSettings['options'];
  label: string;
  hint: string;
  /** Issues from this check belong to this category, so turning it off silences the check too. */
  category: Category;
}

const CHECK_OPTIONS: CheckOption[] = [
  { option: 'passiveVoice', label: 'Passive voice', hint: 'Sentences that could be more direct', category: 'clarity' },
  { option: 'longSentences', label: 'Long sentences', hint: 'Sentences that are hard to follow', category: 'clarity' },
  { option: 'inclusiveLanguage', label: 'Inclusive language', hint: 'Terms that can exclude people', category: 'delivery' },
  { option: 'oxfordComma', label: 'Oxford comma', hint: 'A comma before the last item in a list', category: 'correctness' },
];

/** The dictionary gets a search box once it is too long to scan. */
const DICTIONARY_SEARCH_AT = 12;

const ANTHROPIC_CONSOLE = 'https://console.anthropic.com/';
const HARPER_SITE = 'https://writewithharper.com';
const REPOSITORY = 'https://github.com/SteveDeveloperConcepts/Wordsmith';

/** "harper/SpellCheck" as "Spell check", "ws/long-sentence" as "Long sentence". */
function ruleName(ruleId: string): string {
  const words = ruleId
    .replace(/^(?:ws|harper)\//, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    // Harper's names read as phrases, so "I" and "IIRC" keep their capitals: "As far as I know".
    .map((word) => (word === 'A' || /^[A-Z][a-z]/.test(word) ? word.toLowerCase() : word));
  const name = words.join(' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * For a button that removes its own row: without this, focus falls out of the
 * list and keyboard users start again from the top of the dialog.
 */
function focusNextRow(list: HTMLElement | null, index: number, fallback: HTMLElement | null): void {
  const buttons = list?.querySelectorAll<HTMLElement>('button') ?? [];
  const target = buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : fallback;
  target?.focus();
}

/* ---------- Shared parts ---------- */

interface SegmentedProps<V extends string> {
  label: string;
  options: Array<{ value: V; label: string }>;
  value: V;
  onChange(value: V): void;
}

/** Native radio buttons, so arrow keys and screen readers work as they do anywhere else. */
function Segmented<V extends string>({ label, options, value, onChange }: SegmentedProps<V>) {
  const name = useId();
  return (
    <div className="settings-segments" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className="settings-segment">
          <input type="radio" name={name} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span className="settings-segment__label">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/* ---------- General ---------- */

function GeneralSection() {
  const theme = useSettings((s) => s.theme);
  const dialect = useSettings((s) => s.dialect);
  const editorFont = useSettings((s) => s.editorFont);
  const editorSize = useSettings((s) => s.editorSize);
  const update = useSettings((s) => s.update);
  const dialectId = useId();
  const sizeId = useId();

  return (
    <div className="settings-rows">
      <Setting label="Theme">
        <Segmented label="Theme" options={THEMES} value={theme} onChange={(value) => update({ theme: value })} />
      </Setting>
      <Setting label="English dialect" hint="Sets the spelling and punctuation that checks expect" controlId={dialectId}>
        <select
          id={dialectId}
          className="select"
          value={dialect}
          onChange={(event) => update({ dialect: event.target.value as Dialect })}
        >
          {DIALECTS.map((value) => (
            <option key={value} value={value}>
              {DIALECT_LABEL[value]}
            </option>
          ))}
        </select>
      </Setting>
      <Setting label="Editor font">
        <Segmented
          label="Editor font"
          options={FONTS}
          value={editorFont}
          onChange={(value) => update({ editorFont: value })}
        />
      </Setting>
      <Setting label="Text size" controlId={sizeId}>
        <div className="settings-range">
          <input
            id={sizeId}
            type="range"
            min={MIN_TEXT_SIZE}
            max={MAX_TEXT_SIZE}
            step={1}
            value={editorSize}
            aria-valuetext={`${editorSize} pixels`}
            onChange={(event) => update({ editorSize: Number(event.target.value) })}
          />
          <output htmlFor={sizeId}>{editorSize} px</output>
        </div>
      </Setting>
    </div>
  );
}

/* ---------- Checks ---------- */

function ChecksSection() {
  const checks = useSettings((s) => s.checks);
  const options = useSettings((s) => s.options);
  const disabledRules = useSettings((s) => s.disabledRules);
  const setCheck = useSettings((s) => s.setCheck);
  const setOption = useSettings((s) => s.setOption);
  const enableRule = useSettings((s) => s.enableRule);
  const update = useSettings((s) => s.update);
  const [restored, setRestored] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const defaults = DEFAULT_ENGINE_SETTINGS;
  const atDefaults =
    disabledRules.length === 0 &&
    CATEGORIES.every((c) => checks[c] === defaults.checks[c]) &&
    CHECK_OPTIONS.every(({ option }) => options[option] === defaults.options[option]);

  const rules = disabledRules
    .map((id) => ({ id, name: ruleName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const turnBackOn = (ruleId: string, index: number) => {
    flushSync(() => enableRule(ruleId));
    focusNextRow(list.current, index, panel.current);
  };

  const restore = () => {
    update({ checks: defaults.checks, options: defaults.options, disabledRules: [] });
    setRestored(true);
  };

  return (
    <div ref={panel} tabIndex={-1} className="settings-plain-focus">
      <Group title="Categories">
        <div className="settings-rows">
          {CATEGORIES.map((category) => (
            <Switch
              key={category}
              label={CATEGORY_LABEL[category]}
              hint={CATEGORY_HINT[category]}
              lead={<span className={`dot dot--${category}`} />}
              checked={checks[category]}
              onChange={(on) => setCheck(category, on)}
            />
          ))}
        </div>
      </Group>

      <Group title="Specific checks">
        <div className="settings-rows">
          {CHECK_OPTIONS.map(({ option, label, hint, category }) => (
            <Switch
              key={option}
              label={label}
              hint={checks[category] ? hint : `Off while ${CATEGORY_LABEL[category]} is off`}
              checked={options[option]}
              disabled={!checks[category]}
              onChange={(on) => setOption(option, on)}
            />
          ))}
        </div>
      </Group>

      <Group title="Turned-off rules">
        {rules.length > 0 ? (
          <ul ref={list} className="settings-list">
            {rules.map((rule, index) => (
              <li key={rule.id} className="settings-list__item">
                <span className="settings-list__text">{rule.name}</span>
                <button
                  type="button"
                  className="btn btn--outline btn--small"
                  aria-label={`Turn back on: ${rule.name}`}
                  onClick={() => turnBackOn(rule.id, index)}
                >
                  Turn back on
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-note">
            None so far. To stop seeing a kind of suggestion, choose Turn off on its card in the Assistant panel.
          </p>
        )}
      </Group>

      <div className="settings-actions">
        <button type="button" className="btn btn--outline" onClick={restore}>
          Restore default checks
        </button>
        <p className="settings-note" role="status">
          {restored && atDefaults ? 'Default checks restored.' : ''}
        </p>
      </div>
    </div>
  );
}

/* ---------- Dictionary ---------- */

function DictionarySection() {
  const dictionary = useSettings((s) => s.dictionary);
  const addWord = useSettings((s) => s.addWord);
  const removeWord = useSettings((s) => s.removeWord);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [duplicate, setDuplicate] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const fieldId = useId();

  const searchable = dictionary.length >= DICTIONARY_SEARCH_AT;
  const filter = searchable ? query.trim().toLowerCase() : '';
  const words = filter ? dictionary.filter((word) => word.toLowerCase().includes(filter)) : dictionary;

  const add = (event: FormEvent) => {
    event.preventDefault();
    // Spell checking looks at one word at a time, so an entry with a space in it would never match.
    const entries = draft.split(/[\s,;]+/).filter(Boolean);
    const known = new Set(dictionary.map((word) => word.toLowerCase()));
    const fresh = entries.filter((word) => !known.has(word.toLowerCase()));
    for (const word of fresh) addWord(word);
    setDuplicate(fresh.length === 0 ? (entries[0] ?? '') : '');
    setDraft('');
    setQuery('');
    field.current?.focus();
  };

  const remove = (word: string, index: number) => {
    flushSync(() => removeWord(word));
    focusNextRow(list.current, index, field.current);
  };

  return (
    <>
      <p className="settings-note settings-note--intro">Words here are never flagged as misspellings.</p>

      <form className="settings-inline" onSubmit={add}>
        <label className="settings-hidden-label" htmlFor={fieldId}>
          Add a word
        </label>
        <input
          ref={field}
          id={fieldId}
          className="input"
          type="text"
          placeholder="Add a word"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDuplicate('');
          }}
        />
        <button type="submit" className="btn btn--primary" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      <p className="settings-note" role="status">
        {duplicate ? `“${duplicate}” is already in your dictionary.` : ''}
      </p>

      <div className="settings-list-header">
        <p className="settings-count" role="status">
          {filter ? `${words.length} of ${plural(dictionary.length, 'word')}` : plural(dictionary.length, 'word')}
        </p>
        {searchable && (
          <div className="settings-search">
            <Search size={14} aria-hidden />
            <input
              className="input"
              type="search"
              placeholder="Search words"
              aria-label="Search your dictionary"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
      </div>

      {words.length > 0 ? (
        <ul ref={list} className="settings-list">
          {words.map((word, index) => (
            <li key={word} className="settings-list__item">
              <span className="settings-list__text">{word}</span>
              <button
                type="button"
                className="icon-btn settings-list__remove"
                title="Remove"
                aria-label={`Remove ${word}`}
                onClick={() => remove(word, index)}
              >
                <X size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-empty">
          {dictionary.length === 0
            ? 'No words yet. Add names and terms you use often, or choose Add to dictionary on a spelling suggestion.'
            : `No words match “${query.trim()}”.`}
        </p>
      )}
    </>
  );
}

/* ---------- AI ---------- */

/** The desktop app keeps the key out of the page, in the main process. The browser build has only its own storage. */
const bridge = desktop;
const keyStore = bridge
  ? {
      has: () => bridge.aiHasKey(),
      save: (key: string) => bridge.aiSetKey(key),
      clear: () => bridge.aiClearKey(),
    }
  : {
      has: async () => useSettings.getState().webApiKey !== '',
      save: async (key: string) => useSettings.getState().update({ webApiKey: key }),
      clear: async () => useSettings.getState().update({ webApiKey: '' }),
    };

/** Only ever reports whether a key exists. A saved key never comes back to this form. */
function ApiKeyForm() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const noteId = useId();

  useEffect(() => {
    let current = true;
    keyStore.has().then(
      (has) => {
        if (current) setSaved(has);
      },
      () => {
        if (current) setError('Could not check for a saved key.');
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const key = draft.trim();
    if (!key) return;
    setError('');
    try {
      await keyStore.save(key);
      setDraft('');
      setSaved(await keyStore.has());
    } catch {
      setError('The key could not be saved. Try again.');
    }
  };

  const remove = async () => {
    setError('');
    try {
      await keyStore.clear();
      setSaved(await keyStore.has());
      field.current?.focus();
    } catch {
      setError('The key could not be removed. Try again.');
    }
  };

  return (
    <form className="settings-key" onSubmit={(event) => void save(event)}>
      <label className="setting__label" htmlFor={fieldId}>
        Anthropic API key
      </label>
      <div className="settings-inline">
        <input
          ref={field}
          id={fieldId}
          className="input"
          type="password"
          placeholder={saved ? 'Paste a new key to replace the saved one' : 'Paste your key'}
          autoComplete="new-password"
          spellCheck={false}
          aria-describedby={noteId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={!draft.trim()}>
          Save key
        </button>
      </div>

      <div className="settings-key__status">
        <p className={`settings-note${error ? ' settings-note--error' : ''}`} role="status">
          {error ||
            (saved === null ? (
              ''
            ) : saved ? (
              <>
                <CircleCheck size={15} aria-hidden className="settings-key__ok" /> A key is saved.
              </>
            ) : (
              'No key saved yet.'
            ))}
        </p>
        {saved && (
          <button type="button" className="btn btn--ghost btn--small" onClick={() => void remove()}>
            Remove key
          </button>
        )}
      </div>

      <p id={noteId} className="settings-note">
        {desktop
          ? 'Wordsmith encrypts the key with your operating system’s credential protection and does not show it again.'
          : 'The key stays in this browser, unencrypted, and is sent only to Anthropic. Use this on a computer you trust.'}
      </p>
      <p className="settings-note">
        You need your own key. <OutLink href={ANTHROPIC_CONSOLE}>Get one from the Anthropic Console</OutLink>
      </p>
    </form>
  );
}

function AiSection() {
  const aiModel = useSettings((s) => s.aiModel);
  const update = useSettings((s) => s.update);
  const modelId = useId();
  const model = AI_MODELS.find((m) => m.id === aiModel);

  return (
    <>
      <div className="settings-prose">
        <p>AI features are optional. Everything else in Wordsmith works without them.</p>
        <p>
          Checking your writing never leaves this device. Your text goes to Anthropic only when you use an AI feature.
        </p>
      </div>

      <Group title="Your key">
        <ApiKeyForm />
      </Group>

      <Group title="Model">
        <div className="settings-rows">
          <Setting label="Model for AI features" hint={model?.note} controlId={modelId}>
            <select
              id={modelId}
              className="select"
              value={model?.id ?? ''}
              onChange={(event) => update({ aiModel: event.target.value })}
            >
              {/* A model saved by an older version may no longer be offered. */}
              {!model && (
                <option value="" disabled>
                  Choose a model
                </option>
              )}
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Setting>
        </div>
      </Group>
    </>
  );
}

/* ---------- About ---------- */

function AboutSection() {
  const [version, setVersion] = useState(desktop ? '' : 'Web version');

  useEffect(() => {
    let current = true;
    void desktop?.info().then((info) => {
      if (current) setVersion(`Version ${info.version}`);
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      <p className="settings-version">
        <strong>Wordsmith</strong> {version}
      </p>

      <Group title="Privacy">
        <div className="settings-prose">
          <p>
            Your writing stays on this device. Documents are stored here and checking runs here, with or without an
            internet connection. Wordsmith sends text to Anthropic only when you use an AI feature.
          </p>
        </div>
      </Group>

      <Group title="Credits">
        <div className="settings-prose">
          <p>
            Grammar checking uses the open-source <OutLink href={HARPER_SITE}>Harper</OutLink> engine.
          </p>
          <p>
            Wordsmith is open source too. <OutLink href={REPOSITORY}>See the code on GitHub</OutLink>
          </p>
        </div>
      </Group>
    </>
  );
}

/* ---------- The dialog ---------- */

export interface SettingsSection {
  id: string;
  label: string;
  render(): ReactNode;
}

/** The dialog's section list and panels both come from here, so adding a section is one more entry. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'general', label: 'General', render: () => <GeneralSection /> },
  { id: 'checks', label: 'Checks', render: () => <ChecksSection /> },
  { id: 'dictionary', label: 'Dictionary', render: () => <DictionarySection /> },
  { id: 'integrations', label: 'Other apps', render: () => <IntegrationsSection /> },
  { id: 'ai', label: 'AI', render: () => <AiSection /> },
  { id: 'about', label: 'About', render: () => <AboutSection /> },
];

function SettingsPanels({ onClose }: { onClose(): void }) {
  const [activeId, setActiveId] = useState(SETTINGS_SECTIONS[0].id);
  const nav = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const active = SETTINGS_SECTIONS.find((section) => section.id === activeId) ?? SETTINGS_SECTIONS[0];
  const tabId = (id: string) => `${baseId}-${id}`;

  // Runs after Dialog's own effect has shown the dialog, which moves focus to its close button.
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  const onNavKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = SETTINGS_SECTIONS.length;
    const index = SETTINGS_SECTIONS.indexOf(active);
    // The list runs across the top in a narrow window, so left and right count too.
    const moves: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowRight: index + 1,
      ArrowUp: index - 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: count - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key] + count) % count;
    setActiveId(SETTINGS_SECTIONS[next].id);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next].focus();
  };

  return (
    <Dialog title="Settings" size="wide" onClose={onClose}>
      <div className="settings">
        <div
          ref={nav}
          className="settings__nav"
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          onKeyDown={onNavKey}
        >
          {SETTINGS_SECTIONS.map((section) => (
            <button
              key={section.id}
              id={tabId(section.id)}
              type="button"
              role="tab"
              className={`settings__tab${section === active ? ' is-active' : ''}`}
              aria-selected={section === active}
              aria-controls={`${baseId}-panel`}
              tabIndex={section === active ? 0 : -1}
              onClick={() => setActiveId(section.id)}
            >
              {section.label}
            </button>
          ))}
        </div>
        {/* Keyed so each section starts scrolled to the top, with its own state fresh. */}
        <div
          key={active.id}
          id={`${baseId}-panel`}
          className="settings__panel"
          role="tabpanel"
          aria-labelledby={tabId(active.id)}
          tabIndex={0}
        >
          <h3 className="settings__heading">{active.label}</h3>
          {active.render()}
        </div>
      </div>
    </Dialog>
  );
}

/** App preferences. Changes apply as they are made. Shows while the session says so. */
export function SettingsDialog() {
  const open = useSession((s) => s.dialog === 'settings');
  const openDialog = useSession((s) => s.openDialog);
  if (!open) return null;
  return <SettingsPanels onClose={() => openDialog(null)} />;
}
