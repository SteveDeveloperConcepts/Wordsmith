import type { EditorState } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import {
  ArrowRight,
  ChevronRight,
  KeyRound,
  MessagesSquare,
  PenLine,
  ScanText,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, type FocusEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { CATEGORY_LABEL } from '@engine/types';
import { READER_PERSONAS, REWRITE_PRESETS, type AiErrorInfo } from '@shared/ai-types';
import { useAiReady } from '../ai/client';
import { extractBlocks, plainText } from '../editor/blocks';
import { plural } from '../lib/format';
import {
  explainAiError,
  markdownToHtml,
  reactionItems,
  selectedPassage,
  useAi,
  type AiSectionId,
  type AiStatus,
  type SuggestionCard,
} from '../state/ai';
import { useSession } from '../state/session';
import '../styles/ai.css';

const ai = () => useAi.getState();

/** How the selected text is shown: long passages are clipped in the middle, so both ends stay readable. */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const half = Math.floor((max - 1) / 2);
  return `${clean.slice(0, half).trimEnd()} … ${clean.slice(-half).trimStart()}`;
}

const clippedSelection = (state: EditorState) => clip(selectedPassage(state), 180);
const hasText = (state: EditorState) => plainText(state.doc) !== '';
const hasProse = (state: EditorState) =>
  extractBlocks(state.doc).some((block) => block.kind !== 'code' && block.text.trim() !== '');

/** A value read from the open document, kept current as the writer edits and selects. */
function useDocument<T>(read: (state: EditorState) => T, fallback: T): T {
  const editor = useSession((s) => s.editor);
  // Reads `editor` from here, not the selector's argument: that one keeps the previous
  // editor until the next transaction, so it is out of date just after a document opens.
  const value = useEditorState({ editor, selector: () => (editor ? read(editor.state) : fallback) });
  return value ?? fallback;
}

/* ---------- Shared parts ---------- */

const STATE_LABEL: Record<AiStatus, string> = {
  idle: '',
  running: 'Working…',
  done: 'Ready',
  failed: 'Did not finish',
};

interface SectionProps {
  id: AiSectionId;
  title: string;
  icon: ReactNode;
  status: AiStatus;
  /** Says more than "Ready", when the section can. */
  doneLabel?: string;
  children: ReactNode;
}

function Section({ id, title, icon, status, doneLabel, children }: SectionProps) {
  const open = useAi((s) => s.open[id]);
  const bodyId = useId();
  const state = (status === 'done' && doneLabel) || STATE_LABEL[status];

  return (
    <section className="ai-section">
      <h3 className="ai-section__heading">
        <button
          type="button"
          className="ai-section__toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => ai().toggleSection(id)}
        >
          {icon}
          <span className="ai-section__title">{title}</span>
          {/* Requests keep going in a collapsed section, so the outcome has to show here. */}
          {!open && state && <span className="ai-section__state">{state}</span>}
          <ChevronRight size={15} className="ai-section__chevron" aria-hidden />
        </button>
      </h3>
      <p className="ai-sr" role="status">
        {state}
      </p>
      {open && (
        <div id={bodyId} className="ai-section__body">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * For a button that takes itself away: without this, the keyboard drops out of the
 * panel and starts again from the top of the page.
 */
function thenFocusSection(action: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    event.currentTarget.closest('.ai-section')?.querySelector<HTMLElement>('.ai-section__toggle')?.focus();
    action();
  };
}

export function Progress({ label, onCancel }: { label: string; onCancel(): void }) {
  return (
    <div className="ai-progress">
      <span className="spinner ai-progress__spinner" aria-hidden />
      <span className="ai-progress__label">{label}</span>
      <button type="button" className="btn btn--outline btn--small" onClick={thenFocusSection(onCancel)}>
        Cancel
      </button>
    </div>
  );
}

interface AiErrorNoticeProps {
  error: AiErrorInfo;
  onRetry(): void;
}

/** What went wrong, in the writer's terms, with the step most likely to fix it. */
export function AiErrorNotice({ error, onRetry }: AiErrorNoticeProps) {
  const openDialog = useSession((s) => s.openDialog);
  const { message, detail, next } = explainAiError(error);

  return (
    <div className="notice notice--warn" role="alert">
      <TriangleAlert size={16} aria-hidden />
      <div className="ai-notice__body">
        <p>
          {message}
          {detail && <span className="notice__detail"> ({detail})</span>}
        </p>
        {next === 'settings' && (
          <button type="button" className="btn btn--outline btn--small" onClick={() => openDialog('settings', 'ai')}>
            Open Settings
          </button>
        )}
        {next === 'retry' && (
          <button type="button" className="btn btn--outline btn--small" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="notice notice--warn" role="alert">
      <TriangleAlert size={16} aria-hidden />
      <p>{children}</p>
    </div>
  );
}

interface ReplyProps {
  run: { status: AiStatus; output: string; error: AiErrorInfo | null };
  /** Says what is happening while the reply arrives. */
  progress: string;
  /** Names what the reply is. */
  heading: string;
  note?: string | null;
  onCancel(): void;
  onRetry(): void;
  onDiscard(): void;
  discardLabel?: string;
  /** What can be done with a finished reply. */
  actions?: ReactNode;
  /** The reply so far. */
  children: ReactNode;
}

/** A text reply from start to finish: arriving, finished, or failed. */
function Reply({ run, progress, heading, note, onCancel, onRetry, onDiscard, discardLabel = 'Discard', actions, children }: ReplyProps) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { status, output, error } = run;
  const running = status === 'running';

  // A long section can leave the reply, and what to do with it, below the edge of the panel.
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [status]);

  // Keep the newest text in view until the reply is complete.
  useEffect(() => {
    if (running && box.current) box.current.scrollTop = box.current.scrollHeight;
  });

  if (status === 'idle') return null;

  const discard = (
    <button type="button" className="btn btn--ghost btn--small" onClick={thenFocusSection(onDiscard)}>
      {discardLabel}
    </button>
  );

  if (status === 'failed') {
    return (
      <div ref={root} className="ai-result">
        {error && <AiErrorNotice error={error} onRetry={onRetry} />}
        {note && <Note>{note}</Note>}
        <div className="ai-actions">{discard}</div>
      </div>
    );
  }

  return (
    <div ref={root} className="ai-result">
      <p className="ai-result__heading">{heading}</p>
      {output && (
        <div ref={box} className="ai-preview" tabIndex={0} role="group" aria-label={heading}>
          {children}
        </div>
      )}
      {note && <Note>{note}</Note>}
      {running ? (
        <Progress label={progress} onCancel={onCancel} />
      ) : (
        <div className="ai-actions">
          {actions}
          <button type="button" className="btn btn--ghost btn--small" onClick={onRetry}>
            Try again
          </button>
          {discard}
        </div>
      )}
    </div>
  );
}

/* ---------- Rewrite ---------- */

function RewriteControls({ ready }: { ready: boolean }) {
  const passage = useDocument(clippedSelection, '');
  const instruction = useAi((s) => s.customInstruction);
  const focusInstruction = useAi((s) => s.focusInstruction);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();

  useEffect(() => {
    if (!focusInstruction) return;
    field.current?.focus();
    useAi.setState({ focusInstruction: false });
  }, [focusInstruction]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (text && passage) ai().runRewrite(text, text);
  };

  return (
    <fieldset className="ai-fields" disabled={!ready}>
      <legend className="ai-sr">Rewrite the selected text</legend>
      {passage ? (
        <blockquote className="ai-selection" aria-label="Selected text">
          {passage}
        </blockquote>
      ) : (
        <p className="ai-hint">Nothing is selected. Select some text in your document to rewrite it.</p>
      )}

      <div className="ai-presets">
        {REWRITE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="btn btn--outline btn--small"
            disabled={!passage}
            // Keep the text selection, so the writer can still see what is being rewritten.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => ai().runRewrite(preset.instruction, preset.label)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <form className="ai-form" onSubmit={submit}>
        <label className="ai-label" htmlFor={fieldId}>
          Your own instruction
        </label>
        <div className="ai-form__row">
          <input
            ref={field}
            id={fieldId}
            className="input"
            type="text"
            placeholder="Translate into Spanish"
            autoComplete="off"
            value={instruction}
            onChange={(event) => ai().setDraft({ customInstruction: event.target.value })}
          />
          <button type="submit" className="btn btn--primary" disabled={!passage || !instruction.trim()}>
            Rewrite
          </button>
        </div>
      </form>
    </fieldset>
  );
}

function RewriteReply() {
  const run = useAi((s) => s.rewrite);
  return (
    <Reply
      run={run}
      progress="Rewriting…"
      heading={run.label}
      note={run.note}
      onCancel={() => ai().cancel('rewrite')}
      onRetry={() => ai().retryRewrite()}
      onDiscard={() => ai().discardRewrite()}
      actions={
        <>
          <button type="button" className="btn btn--primary btn--small" onClick={() => ai().replaceRewrite()}>
            Replace
          </button>
          <button type="button" className="btn btn--outline btn--small" onClick={() => ai().insertRewriteBelow()}>
            Insert below
          </button>
        </>
      }
    >
      <p className="ai-plain">{run.output}</p>
    </Reply>
  );
}

/* ---------- Write for me ---------- */

/** A reply can hold links, and following one here would take the page away from the document. */
const stayOnPage = (event: MouseEvent) => event.preventDefault();

function ComposeControls({ ready }: { ready: boolean }) {
  const prompt = useAi((s) => s.composePrompt);
  const running = useAi((s) => s.compose.status === 'running');
  const fieldId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    ai().runCompose();
  };

  return (
    <fieldset className="ai-fields" disabled={!ready}>
      <legend className="ai-sr">Write new text</legend>
      <form className="ai-form" onSubmit={submit}>
        <label className="ai-label" htmlFor={fieldId}>
          What should it say?
        </label>
        <textarea
          id={fieldId}
          className="textarea"
          rows={3}
          placeholder="A short thank-you note to the team"
          value={prompt}
          onChange={(event) => ai().setDraft({ composePrompt: event.target.value })}
        />
        <div className="ai-actions">
          <button type="submit" className="btn btn--primary btn--small" disabled={!prompt.trim() || running}>
            Write
          </button>
        </div>
      </form>
    </fieldset>
  );
}

function ComposeReply() {
  const run = useAi((s) => s.compose);

  const insert = () => {
    ai().insertComposed();
    ai().setDraft({ composePrompt: '' });
  };

  return (
    <Reply
      run={run}
      progress="Writing…"
      heading="Draft"
      onCancel={() => ai().cancel('compose')}
      onRetry={() => ai().runCompose()}
      onDiscard={() => ai().discardComposed()}
      actions={
        <button type="button" className="btn btn--primary btn--small" onClick={insert}>
          Insert at cursor
        </button>
      }
    >
      <div className="ai-prose" onClick={stayOnPage} dangerouslySetInnerHTML={{ __html: markdownToHtml(run.output) }} />
    </Reply>
  );
}

/* ---------- Reader reactions ---------- */

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function ReaderControls({ ready }: { ready: boolean }) {
  const reader = useAi((s) => s.readerName);
  const running = useAi((s) => s.reader.status === 'running');
  const documentHasText = useDocument(hasText, false);
  const fieldId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    ai().runReader();
  };

  return (
    <fieldset className="ai-fields" disabled={!ready}>
      <legend className="ai-sr">Choose a reader</legend>
      <p className="ai-hint">
        {documentHasText
          ? 'See how a particular reader is likely to take the whole document.'
          : 'Your document is empty, so there is nothing to react to yet.'}
      </p>
      <div className="chips" role="group" aria-label="Common readers">
        {READER_PERSONAS.map((persona) => (
          <button
            key={persona}
            type="button"
            className={`chip${reader === persona ? ' is-active' : ''}`}
            aria-pressed={reader === persona}
            onClick={() => ai().setDraft({ readerName: persona })}
          >
            {sentenceCase(persona)}
          </button>
        ))}
      </div>
      <form className="ai-form" onSubmit={submit}>
        <label className="ai-label" htmlFor={fieldId}>
          Reader
        </label>
        <div className="ai-form__row">
          <input
            id={fieldId}
            className="input"
            type="text"
            placeholder="A new hire on their first day"
            autoComplete="off"
            value={reader}
            onChange={(event) => ai().setDraft({ readerName: event.target.value })}
          />
          <button type="submit" className="btn btn--primary" disabled={!reader.trim() || !documentHasText || running}>
            Get reactions
          </button>
        </div>
      </form>
    </fieldset>
  );
}

function ReaderReply() {
  const run = useAi((s) => s.reader);
  return (
    <Reply
      run={run}
      progress="Reading your document…"
      heading="Reactions"
      onCancel={() => ai().cancel('reader')}
      onRetry={() => ai().runReader()}
      onDiscard={() => ai().clearReader()}
      discardLabel="Clear"
    >
      <ul className="ai-reactions">
        {reactionItems(run.output).map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </Reply>
  );
}

/* ---------- Deep proofread ---------- */

function Suggestion({ card, onDismiss }: { card: SuggestionCard; onDismiss(): void }) {
  const stopRevealing = (event: FocusEvent<HTMLLIElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) ai().revealSuggestion(null);
  };
  const removal = card.replacement === '';

  return (
    <li
      className={`card card--${card.category} is-open`}
      onMouseEnter={() => ai().revealSuggestion(card.id)}
      onMouseLeave={() => ai().revealSuggestion(null)}
      onFocus={() => ai().revealSuggestion(card.id)}
      onBlur={stopRevealing}
    >
      <div className="issue">
        <div className="issue__type">
          <span className={`dot dot--${card.category}`} />
          {CATEGORY_LABEL[card.category]}
        </div>
        <div className="issue__title">{card.title}</div>
        <div className="issue__change">
          <span className="issue__old">{clip(card.quote, 70)}</span>
          {!removal && (
            <>
              <ArrowRight size={14} className="issue__arrow" aria-hidden />
              <span className="ai-card__new">{clip(card.replacement, 70)}</span>
            </>
          )}
        </div>
        <p className="issue__message">{card.explanation}</p>
        {card.note && (
          <p className="ai-card__note" role="alert">
            {card.note}
          </p>
        )}
        <div className="ai-card__actions">
          <button
            type="button"
            className={`fix fix--${card.category} fix--primary`}
            aria-label={`Apply: ${card.title}`}
            onClick={() => ai().applySuggestion(card.id)}
          >
            Apply
          </button>
          <button type="button" className="btn btn--quiet" aria-label={`Dismiss: ${card.title}`} onClick={onDismiss}>
            <X size={14} aria-hidden /> Dismiss
          </button>
        </div>
      </div>
    </li>
  );
}

function ProofreadBody({ ready }: { ready: boolean }) {
  const { status, cards, found, error } = useAi((s) => s.proofread);
  const documentHasProse = useDocument(hasProse, false);
  const list = useRef<HTMLUListElement>(null);
  const start = useRef<HTMLButtonElement>(null);
  const running = status === 'running';

  // A pointer or the keyboard can leave this tab without ever leaving the card it was on.
  useEffect(() => () => ai().revealSuggestion(null), []);

  const dismiss = (id: string, index: number) => {
    ai().revealSuggestion(null);
    flushSync(() => ai().dismissSuggestion(id));
    // The button that had the keyboard is gone with its card, so hand it to the next one.
    const next = list.current?.querySelectorAll<HTMLElement>('.fix') ?? [];
    (next[Math.min(index, next.length - 1)] ?? start.current)?.focus();
  };

  return (
    <>
      <fieldset className="ai-fields" disabled={!ready}>
        <legend className="ai-sr">Proofread the whole document</legend>
        <p className="ai-hint">
          {documentHasProse
            ? 'A slower, closer read of the whole document, for mistakes that need context, such as a wrong word or a shift in tense.'
            : 'Your document is empty, so there is nothing to proofread yet.'}
        </p>
        <div className="ai-actions">
          <button
            ref={start}
            type="button"
            className="btn btn--primary btn--small"
            disabled={!documentHasProse || running}
            onClick={() => ai().runProofread()}
          >
            {status === 'done' ? 'Proofread again' : 'Proofread document'}
          </button>
        </div>
      </fieldset>

      {running && <Progress label="Proofreading your document…" onCancel={() => ai().cancel('proofread')} />}
      {status === 'failed' && error && <AiErrorNotice error={error} onRetry={() => ai().runProofread()} />}
      {status === 'done' && found === 0 && <p className="ai-hint">The proofread found nothing to change.</p>}
      {status === 'done' && found > 0 && cards.length === 0 && (
        <p className="ai-hint">You have gone through every suggestion.</p>
      )}

      {cards.length > 0 && (
        <ul ref={list} className="cards" aria-label="Proofreading suggestions">
          {cards.map((card, index) => (
            <Suggestion key={card.id} card={card} onDismiss={() => dismiss(card.id, index)} />
          ))}
        </ul>
      )}
    </>
  );
}

/* ---------- The tab ---------- */

function KeySetup() {
  const openDialog = useSession((s) => s.openDialog);
  return (
    <div className="ai-setup">
      <h3 className="ai-setup__title">
        <KeyRound size={15} aria-hidden /> AI features need an API key
      </h3>
      <p>Rewriting, drafting, reader reactions, and deep proofreading use Claude, with your own Anthropic API key.</p>
      <p>Checking still works without AI. Spelling, grammar, and style suggestions run on this device.</p>
      <button type="button" className="btn btn--primary btn--small" onClick={() => openDialog('settings', 'ai')}>
        Open Settings
      </button>
    </div>
  );
}

/** Rewriting, drafting, reader reactions, and deep proofreading. */
export function AiTab() {
  const ready = useAiReady();
  const rewriteStatus = useAi((s) => s.rewrite.status);
  const composeStatus = useAi((s) => s.compose.status);
  const readerStatus = useAi((s) => s.reader.status);
  const proofreadStatus = useAi((s) => s.proofread.status);
  const suggestions = useAi((s) => s.proofread.cards.length);

  return (
    <div className="ai">
      {!ready && <KeySetup />}

      <Section id="rewrite" title="Rewrite" icon={<Sparkles size={15} aria-hidden />} status={rewriteStatus}>
        <RewriteControls ready={ready} />
        <RewriteReply />
      </Section>

      <Section id="compose" title="Write for me" icon={<PenLine size={15} aria-hidden />} status={composeStatus}>
        <ComposeControls ready={ready} />
        <ComposeReply />
      </Section>

      <Section id="reader" title="Reader reactions" icon={<MessagesSquare size={15} aria-hidden />} status={readerStatus}>
        <ReaderControls ready={ready} />
        <ReaderReply />
      </Section>

      <Section
        id="proofread"
        title="Deep proofread"
        icon={<ScanText size={15} aria-hidden />}
        status={proofreadStatus}
        doneLabel={plural(suggestions, 'suggestion')}
      >
        <ProofreadBody ready={ready} />
      </Section>

      <p className="ai-privacy">AI features send the text they work on to Anthropic. Checking stays on this device.</p>
    </div>
  );
}
