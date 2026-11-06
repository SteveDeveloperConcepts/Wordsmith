import { ArrowLeft, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, DIALECT_LABEL, type Dialect } from '@engine/types';
import { useSettings } from '@renderer/state/settings';

/** The few settings that matter in a pane, in one column. */
export function PaneSettings({ onClose }: { onClose(): void }) {
  const settings = useSettings();
  const [word, setWord] = useState('');

  const addWord = (event: FormEvent) => {
    event.preventDefault();
    settings.addWord(word);
    setWord('');
  };

  return (
    <main className="pane__body pane__body--settings">
      <button type="button" className="btn btn--quiet pane__back" onClick={onClose}>
        <ArrowLeft size={14} aria-hidden /> Back to suggestions
      </button>

      <section className="pane-section">
        <label className="pane-section__title" htmlFor="pane-dialect">
          English dialect
        </label>
        <select
          id="pane-dialect"
          className="select"
          value={settings.dialect}
          onChange={(event) => settings.update({ dialect: event.target.value as Dialect })}
        >
          {Object.entries(DIALECT_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </section>

      <section className="pane-section">
        <h2 className="pane-section__title">What to check</h2>
        {CATEGORIES.map((category) => (
          <label key={category} className="pane-toggle">
            <span>
              <span className="pane-toggle__label">{CATEGORY_LABEL[category]}</span>
              <span className="pane-toggle__hint">{CATEGORY_HINT[category]}</span>
            </span>
            <span className="switch">
              <input
                type="checkbox"
                checked={settings.checks[category]}
                onChange={(event) => settings.setCheck(category, event.target.checked)}
              />
              <span className="switch__track" />
            </span>
          </label>
        ))}
        {settings.disabledRules.length > 0 && (
          <div className="pane-section__row">
            <span className="pane-toggle__hint">
              {settings.disabledRules.length === 1 ? '1 check is off' : `${settings.disabledRules.length} checks are off`}
            </span>
            <button type="button" className="btn btn--quiet" onClick={() => settings.update({ disabledRules: [] })}>
              Turn back on
            </button>
          </div>
        )}
      </section>

      <section className="pane-section">
        <h2 className="pane-section__title">Dictionary</h2>
        <form className="pane-section__row" onSubmit={addWord}>
          <input
            className="input"
            value={word}
            aria-label="Word to add"
            placeholder="Add a word"
            onChange={(event) => setWord(event.target.value)}
          />
          <button type="submit" className="btn btn--outline" disabled={!word.trim()}>
            Add
          </button>
        </form>
        {settings.dictionary.length === 0 ? (
          <p className="pane-toggle__hint">Words you add here are never flagged as misspelled.</p>
        ) : (
          <ul className="pane-words">
            {settings.dictionary.map((entry) => (
              <li key={entry}>
                <span>{entry}</span>
                <button
                  type="button"
                  className="pane-note__close"
                  aria-label={`Remove ${entry}`}
                  onClick={() => settings.removeWord(entry)}
                >
                  <X size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="pane-toggle__hint">Word, Outlook, PowerPoint, and Excel each keep their own copy of these settings.</p>
      </section>
    </main>
  );
}
