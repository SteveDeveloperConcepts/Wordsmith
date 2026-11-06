import { Target } from 'lucide-react';
import { useId, useState } from 'react';
import { DEFAULT_GOALS, type Goals } from '@engine/types';
import { useLibrary } from '../state/library';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { Dialog } from './Dialog';
import '../styles/insights.css';

interface GoalOption<V extends string> {
  value: V;
  label: string;
  /** What choosing this changes. Keep in step with buildProfile in the engine. */
  hint: string;
}

const AUDIENCE: GoalOption<Goals['audience']>[] = [
  { value: 'general', label: 'General', hint: 'Strictest on long sentences, and suggests plainer words.' },
  { value: 'knowledgeable', label: 'Knowledgeable', hint: 'Allows longer sentences, and still suggests plainer words.' },
  { value: 'expert', label: 'Expert', hint: 'Allows the longest sentences and complex words, and is easier on passive voice.' },
];

const FORMALITY: GoalOption<Goals['formality']>[] = [
  { value: 'informal', label: 'Informal', hint: 'Lets slang, filler words, hedging, fragments, and passive voice pass.' },
  { value: 'neutral', label: 'Neutral', hint: 'Flags slang and filler words, and allows contractions.' },
  { value: 'formal', label: 'Formal', hint: 'Also flags contractions, exclamation points, and sentences that start with And or But.' },
];

const DOMAIN: GoalOption<Goals['domain']>[] = [
  { value: 'general', label: 'General', hint: 'Uses the standard checks.' },
  { value: 'academic', label: 'Academic', hint: 'Expects formal wording, allows complex words, and is easier on passive voice.' },
  { value: 'business', label: 'Business', hint: 'Adds checks for wording that sounds curt or demanding.' },
  { value: 'email', label: 'Email', hint: 'Adds checks for wording that sounds curt or demanding.' },
  { value: 'casual', label: 'Casual', hint: 'Lets slang, filler words, hedging, fragments, and passive voice pass.' },
  { value: 'creative', label: 'Creative', hint: 'Leaves style to you. Allows fragments, slang, filler words, and longer sentences.' },
];

const INTENT: GoalOption<Goals['intent']>[] = [
  { value: 'inform', label: 'Inform', hint: 'Uses the standard checks. AI writing aims to explain.' },
  { value: 'describe', label: 'Describe', hint: 'Uses the standard checks. AI writing aims to describe.' },
  { value: 'convince', label: 'Convince', hint: 'Uses the standard checks. AI writing aims to persuade.' },
  { value: 'tell-story', label: 'Tell a story', hint: 'Allows longer sentences, fragments, hedging, and passive voice.' },
];

interface GoalGroupProps<V extends string> {
  legend: string;
  options: GoalOption<V>[];
  value: V;
  onChange(value: V): void;
}

/** Native radio buttons, so arrow keys and screen readers work as they do anywhere else. */
function GoalGroup<V extends string>({ legend, options, value, onChange }: GoalGroupProps<V>) {
  const name = useId();
  // Pointing at an option shows its description without choosing it.
  const [pointed, setPointed] = useState<V | null>(null);
  const shown = pointed ?? value;
  const hintId = (option: V) => `${name}-${option}`;

  return (
    <fieldset className="goal" role="radiogroup">
      <legend className="goal__legend">{legend}</legend>
      <div className="segments" onMouseLeave={() => setPointed(null)}>
        {options.map((option) => (
          <label key={option.value} className="segment" onMouseEnter={() => setPointed(option.value)}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={option.value === value}
              aria-describedby={hintId(option.value)}
              onChange={() => onChange(option.value)}
            />
            <span className="segment__label">{option.label}</span>
          </label>
        ))}
      </div>
      {/* All stacked in one cell: the space fits the longest, so the dialog does not jump. */}
      <div className="goal__hints">
        {options.map((option) => (
          <p
            key={option.value}
            id={hintId(option.value)}
            className={`goal__hint${option.value === shown ? ' is-shown' : ''}`}
          >
            {option.hint}
          </p>
        ))}
      </div>
    </fieldset>
  );
}

const setGoal =
  <K extends keyof Goals>(key: K) =>
  (value: Goals[K]): void => {
    const library = useLibrary.getState();
    library.setGoals({ ...(library.current?.goals ?? DEFAULT_GOALS), [key]: value });
  };

/**
 * A modal dialog sits above the app's toast and hides it from assistive
 * technology, so messages raised from here are repeated inside the dialog.
 */
function DialogToast() {
  const toast = useSession((s) => s.toast);
  const dismiss = useSession((s) => s.dismissToast);
  return (
    <div role="status">
      {toast && (
        <div className={`toast toast--${toast.kind}`} onClick={dismiss}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

/** Opens the Goals dialog. Goes in the Assistant panel header. */
export function GoalsButton() {
  const openDialog = useSession((s) => s.openDialog);
  return (
    <button
      type="button"
      className="btn btn--quiet"
      aria-haspopup="dialog"
      title="Set goals for this document"
      onClick={() => openDialog('goals')}
    >
      <Target size={15} aria-hidden /> Goals
    </button>
  );
}

/** What the open document is for, which decides how strict the checks are. Shows while the session says so. */
export function GoalsDialog() {
  const open = useSession((s) => s.dialog === 'goals');
  const openDialog = useSession((s) => s.openDialog);
  const notify = useSession((s) => s.notify);
  const goals = useLibrary((s) => s.current?.goals ?? DEFAULT_GOALS);

  if (!open) return null;

  const close = () => openDialog(null);

  return (
    <Dialog
      title="Goals"
      description="Changes apply right away and affect only this document."
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={() => useLibrary.getState().setGoals(DEFAULT_GOALS)}>
            Reset
          </button>
          <button
            type="button"
            className="btn btn--outline"
            onClick={() => {
              useSettings.getState().update({ defaultGoals: goals });
              notify('New documents will start with these goals.');
            }}
          >
            Use for new documents
          </button>
          <span className="goals__spacer" />
          <button type="button" className="btn btn--primary" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div className="goals">
        <GoalGroup legend="Audience" options={AUDIENCE} value={goals.audience} onChange={setGoal('audience')} />
        <GoalGroup legend="Formality" options={FORMALITY} value={goals.formality} onChange={setGoal('formality')} />
        <GoalGroup legend="Domain" options={DOMAIN} value={goals.domain} onChange={setGoal('domain')} />
        <GoalGroup legend="Intent" options={INTENT} value={goals.intent} onChange={setGoal('intent')} />
      </div>
      <DialogToast />
    </Dialog>
  );
}
