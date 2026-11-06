import { ChevronRight, CircleCheck, CircleDashed, PenLine, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { MIN_TONE_WORDS } from '@engine/tone';
import {
  ISSUE_TYPES,
  READING_WPM,
  SPEAKING_WPM,
  TYPE_LABEL,
  WORDS_PER_PAGE,
  type Category,
  type Issue,
  type IssueType,
  type Readability,
  type TextStats,
  type ToneScore,
} from '@engine/types';
import { formatDuration, formatNumber, plural } from '../lib/format';
import { useSession, type SelectionStats } from '../state/session';
import {
  CUSTOM_TARGET,
  NO_TARGET,
  TARGET_PRESETS,
  describeTarget,
  parseTargetValue,
  resolveTarget,
  targetCount,
  targetProgress,
  useTarget,
  type LengthTarget,
  type TargetProgress,
  type TargetUnit,
} from '../state/target';
import '../styles/insights.css';

export interface SuggestionRow {
  type: IssueType;
  count: number;
  /** The Review filter that shows exactly these issues. */
  category: Category | 'all';
}

/**
 * One row per kind of issue present, in the usual order. Some types, such as
 * sentence issues, occur in several categories; those rows filter across all
 * categories, because any one category would show fewer issues than the row counts.
 */
export function suggestionRows(issues: Issue[]): SuggestionRow[] {
  const found = new Map<IssueType, SuggestionRow>();
  for (const { type, category } of issues) {
    const row = found.get(type);
    if (!row) found.set(type, { type, count: 1, category });
    else {
      row.count++;
      if (row.category !== category) row.category = 'all';
    }
  }
  return ISSUE_TYPES.flatMap((type) => found.get(type) ?? []);
}

type MeterLevel = 'progress' | 'good' | 'warn' | 'bad';

/** Follows the Flesch bands: plain English and easier, then difficult, then very difficult. */
export function readabilityLevel(score: number): MeterLevel {
  if (score >= 60) return 'good';
  return score >= 30 ? 'warn' : 'bad';
}

const TARGET_LEVEL: Record<TargetProgress['status'], MeterLevel> = { under: 'progress', met: 'good', over: 'bad' };

const TARGET_ICON: Record<TargetProgress['status'], ReactNode> = {
  under: <CircleDashed size={14} aria-hidden />,
  met: <CircleCheck size={14} aria-hidden />,
  over: <TriangleAlert size={14} aria-hidden />,
};

const STRENGTH_LABEL: Record<ToneScore['strength'], string> = { 1: 'Slight', 2: 'Moderate', 3: 'Strong' };

interface SectionProps {
  title: string;
  /** Sits at the right of the title. */
  aside?: ReactNode;
  children: ReactNode;
}

function Section({ title, aside, children }: SectionProps) {
  const titleId = useId();
  return (
    <section className="insight" aria-labelledby={titleId}>
      <div className="insight__header">
        <h3 className="insight__title" id={titleId}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

interface MeterProps {
  label: string;
  level: MeterLevel;
  value: number;
  max: number;
  /** What a screen reader says instead of the bare number. */
  valueText: string;
  /** Tick marks, from 0 to 1. */
  marks?: number[];
}

function Meter({ label, level, value, max, valueText, marks = [] }: MeterProps) {
  // A meter's value may not pass its maximum, even when the writer has passed the target.
  const shown = Math.min(value, max);
  return (
    <div
      className={`meter meter--${level}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={valueText}
    >
      <div className="meter__fill" style={{ width: `${(shown / max) * 100}%` }} />
      {marks.map((mark) => (
        <span key={mark} className="meter__mark" style={{ left: `${mark * 100}%` }} />
      ))}
    </div>
  );
}

function Counts({ stats, selection }: { stats: TextStats; selection: SelectionStats | null }) {
  const counts: Array<[label: string, value: string]> = [
    ['Words', formatNumber(stats.words)],
    ['Characters', formatNumber(stats.characters)],
    ['Characters without spaces', formatNumber(stats.charactersNoSpaces)],
    ['Sentences', formatNumber(stats.sentences)],
    ['Paragraphs', formatNumber(stats.paragraphs)],
    ['Pages', formatNumber(stats.pages)],
    ['Reading time', formatDuration(stats.readingTimeSec)],
    ['Speaking time', formatDuration(stats.speakingTimeSec)],
  ];
  return (
    <Section
      title="Counts"
      aside={
        // Beside the title, so that selecting text does not push the rest of the panel down.
        selection && (
          <p className="insight__aside">
            Selected: {plural(selection.words, 'word')}, {plural(selection.characters, 'character')}
          </p>
        )
      }
    >
      <dl className="counts">
        {counts.map(([label, value]) => (
          <div className="counts__item" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="insight__note">
        Assumes reading at {READING_WPM} and speaking at {SPEAKING_WPM} words a minute, and {WORDS_PER_PAGE} words a
        page.
      </p>
    </Section>
  );
}

function CustomTarget() {
  const customValue = useTarget((s) => s.customValue);
  const customUnit = useTarget((s) => s.customUnit);
  const setCustom = useTarget((s) => s.setCustom);
  // The field can be blank or invalid mid-edit; the meter keeps the last number that worked.
  const [draft, setDraft] = useState(String(customValue));

  return (
    <div className="target__custom">
      <input
        className="input"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        aria-label="Custom target"
        aria-invalid={parseTargetValue(draft) === null}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseTargetValue(event.target.value);
          if (parsed !== null) setCustom({ customValue: parsed });
        }}
        onBlur={() => setDraft(String(customValue))}
      />
      <select
        className="select"
        aria-label="Custom target unit"
        value={customUnit}
        onChange={(event) => setCustom({ customUnit: event.target.value as TargetUnit })}
      >
        <option value="words">Words</option>
        <option value="characters">Characters</option>
      </select>
    </div>
  );
}

function TargetMeter({ target, count }: { target: LengthTarget; count: number }) {
  const { status, message, scale, marks } = targetProgress(target, count);
  const current = plural(count, target.unit === 'words' ? 'word' : 'character');
  return (
    <>
      <Meter
        label="Progress toward your length target"
        level={TARGET_LEVEL[status]}
        value={count}
        max={scale}
        valueText={`${current}. ${message}.`}
        marks={marks}
      />
      <div className="target__status">
        {TARGET_ICON[status]}
        <span className="target__message">{message}</span>
        <span className="target__count">{current}</span>
      </div>
    </>
  );
}

function LengthTargetSection({ stats }: { stats: TextStats }) {
  const choice = useTarget((s) => s.choice);
  const customValue = useTarget((s) => s.customValue);
  const customUnit = useTarget((s) => s.customUnit);
  const choose = useTarget((s) => s.choose);
  const selectId = useId();
  const target = resolveTarget({ choice, customValue, customUnit });

  return (
    <div className="insight">
      <label className="insight__title" htmlFor={selectId}>
        Length target
      </label>
      <select id={selectId} className="select" value={choice} onChange={(event) => choose(event.target.value)}>
        <option value={NO_TARGET}>No target</option>
        {TARGET_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label} ({describeTarget(preset)})
          </option>
        ))}
        <option value={CUSTOM_TARGET}>Custom</option>
      </select>
      {choice === CUSTOM_TARGET && <CustomTarget />}
      {target && <TargetMeter target={target} count={targetCount(target, stats)} />}
    </div>
  );
}

function ReadabilitySection({ stats, readability }: { stats: TextStats; readability: Readability }) {
  const { fleschReadingEase: score, gradeLevel, label, description } = readability;
  return (
    <Section title="Readability">
      {score !== null && (
        <div className="flesch">
          <div className="flesch__heading">
            <span>Flesch reading ease</span>
            <strong>{score}</strong>
          </div>
          <Meter
            label="Flesch reading ease"
            level={readabilityLevel(score)}
            value={score}
            max={100}
            valueText={`${score} out of 100: ${label}`}
          />
          <div className="flesch__ends" aria-hidden>
            <span>Harder to read</span>
            <span>Easier to read</span>
          </div>
        </div>
      )}
      <p className="insight__text">
        <strong>{label}.</strong> {description}
      </p>
      <dl className="facts">
        {gradeLevel !== null && (
          <div className="facts__row">
            <dt>Grade level (U.S.)</dt>
            <dd>{formatNumber(gradeLevel)}</dd>
          </div>
        )}
        <div className="facts__row">
          <dt>Average sentence length</dt>
          <dd>{plural(stats.avgSentenceLength, 'word')}</dd>
        </div>
        <div className="facts__row">
          <dt>Longest sentence</dt>
          <dd>{plural(stats.longestSentenceWords, 'word')}</dd>
        </div>
        <div className="facts__row">
          <dt>Average word length</dt>
          <dd>{plural(stats.avgWordLength, 'letter')}</dd>
        </div>
      </dl>
    </Section>
  );
}

function VocabularySection({ stats }: { stats: TextStats }) {
  return (
    <Section title="Vocabulary">
      <dl className="facts">
        <div className="facts__row">
          <dt>Unique words</dt>
          <dd>{stats.uniqueWordsPct}%</dd>
          <dd className="facts__hint">Different words as a share of all your words. Higher means more variety.</dd>
        </div>
        <div className="facts__row">
          <dt>Rare words</dt>
          <dd>{stats.rareWordsPct}%</dd>
          <dd className="facts__hint">Words outside everyday vocabulary. Names and numbers do not count.</dd>
        </div>
      </dl>
    </Section>
  );
}

function Strength({ strength }: { strength: ToneScore['strength'] }) {
  const label = STRENGTH_LABEL[strength];
  return (
    <span className="strength" role="img" aria-label={`${label} strength`} title={label}>
      {[1, 2, 3].map((step) => (
        <span key={step} className={`strength__step${step <= strength ? ' is-on' : ''}`} />
      ))}
    </span>
  );
}

function ToneSection({ tones, words }: { tones: ToneScore[]; words: number }) {
  return (
    <Section title="Tone">
      {tones.length > 0 ? (
        <>
          <ul className="tones">
            {tones.map((tone) => (
              <li className="tones__item" key={tone.id}>
                <span className="tones__emoji" aria-hidden>
                  {tone.emoji}
                </span>
                <span className="tones__label">{tone.label}</span>
                <Strength strength={tone.strength} />
              </li>
            ))}
          </ul>
          <p className="insight__note">Tone detection is an estimate based on word choice and punctuation.</p>
        </>
      ) : (
        <p className="insight__text">Write {plural(MIN_TONE_WORDS - words, 'more word')} to see the tone.</p>
      )}
    </Section>
  );
}

function SuggestionsSection({ issues }: { issues: Issue[] }) {
  const setFilter = useSession((s) => s.setFilter);
  const setTab = useSession((s) => s.setTab);
  const rows = suggestionRows(issues);

  return (
    <Section title="Suggestions by type">
      {rows.length > 0 ? (
        <ul className="types">
          {rows.map(({ type, count, category }) => (
            <li key={type}>
              <button
                type="button"
                className="types__row"
                aria-label={`${TYPE_LABEL[type]}: ${plural(count, 'suggestion')}`}
                title="Show in Review"
                onClick={() => {
                  setFilter(category, type);
                  setTab('review');
                }}
              >
                <span className={category === 'all' ? 'dot' : `dot dot--${category}`} />
                <span className="types__label">{TYPE_LABEL[type]}</span>
                <span className="types__count">{formatNumber(count)}</span>
                <ChevronRight size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="insight__text">No suggestions right now.</p>
      )}
    </Section>
  );
}

/** The word counter and writing report. */
export function InsightsTab() {
  const result = useSession((s) => s.result);
  const selection = useSession((s) => s.selection);
  const engineFailed = useSession((s) => s.engine.error !== undefined);

  if (!result) {
    return (
      <div className="empty">
        {engineFailed ? (
          <>
            <TriangleAlert size={28} aria-hidden />
            <h3>Insights are not available</h3>
            <p>The checker did not start, so your text has not been measured.</p>
          </>
        ) : (
          <>
            <div className="spinner" aria-hidden />
            <h3>Measuring your text…</h3>
          </>
        )}
      </div>
    );
  }

  const { stats, readability, tones, issues } = result;

  if (stats.characters === 0) {
    return (
      <div className="insights">
        <div className="empty">
          <PenLine size={28} aria-hidden />
          <h3>Nothing to measure yet</h3>
          <p>Start typing or paste your text to see counts, readability, and tone.</p>
        </div>
        {/* A target is something to aim for, so it can be set before the first word. */}
        <LengthTargetSection stats={stats} />
      </div>
    );
  }

  return (
    <div className="insights">
      <Counts stats={stats} selection={selection} />
      <LengthTargetSection stats={stats} />
      <ReadabilitySection stats={stats} readability={readability} />
      <VocabularySection stats={stats} />
      <ToneSection tones={tones} words={stats.words} />
      <SuggestionsSection issues={issues} />
    </div>
  );
}
