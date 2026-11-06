/**
 * The AI tab's state, and the document work behind it. Requests run here rather
 * than in components so they keep going when the writer changes tabs, and so the
 * floating selection menu can start one.
 */
import { createNodeFromContent, selectionToInsertionEnd } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice, type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { Marked } from 'marked';
import { create } from 'zustand';
import type { Dialect, Goals, Issue } from '@engine/types';
import { AiError, type AiErrorInfo, type AiRequest, type AiSuggestion } from '@shared/ai-types';
import { runAi } from '../ai/client';
import { extractBlocks, plainText } from '../editor/blocks';
import { locateIssue, sentenceText } from '../editor/issues';
import { MOD } from '../platform';
import { useLibrary } from './library';
import { useSession } from './session';
import { useSettings } from './settings';

/* ---------- Following text as the writer edits ---------- */

interface Range {
  from: number;
  to: number;
}

type HighlightKind = 'target' | 'reveal';

interface TrackerState {
  /** The passage being rewritten and the suggestion being read: highlighted, and kept in place through edits. */
  highlights: DecorationSet;
  /** Where each paragraph sent for proofreading is now, or null if it was deleted. */
  paragraphs: Array<number | null>;
}

interface TrackerMeta {
  target?: Range | null;
  reveal?: Range | null;
  paragraphs?: number[];
}

const trackerKey = new PluginKey<TrackerState>('wordsmith-ai');

function highlight(state: DecorationSet, doc: PMNode, kind: HighlightKind, range: Range | null): DecorationSet {
  const cleared = state.remove(state.find(undefined, undefined, (spec) => spec.kind === kind));
  if (!range) return cleared;
  return cleared.add(doc, [Decoration.inline(range.from, range.to, { class: `ws-ai-${kind}` }, { kind })]);
}

const tracker = new Plugin<TrackerState>({
  key: trackerKey,
  state: {
    init: () => ({ highlights: DecorationSet.empty, paragraphs: [] }),
    apply(tr, previous) {
      let highlights = previous.highlights.map(tr.mapping, tr.doc);
      let paragraphs = previous.paragraphs;
      if (tr.docChanged) {
        paragraphs = paragraphs.map((pos) => {
          if (pos === null) return null;
          const mapped = tr.mapping.mapResult(pos, 1);
          return mapped.deleted ? null : mapped.pos;
        });
      }
      const meta = tr.getMeta(trackerKey) as TrackerMeta | undefined;
      if (meta?.target !== undefined) highlights = highlight(highlights, tr.doc, 'target', meta.target);
      if (meta?.reveal !== undefined) highlights = highlight(highlights, tr.doc, 'reveal', meta.reveal);
      if (meta?.paragraphs) paragraphs = meta.paragraphs;
      return { highlights, paragraphs };
    },
  },
  props: {
    decorations: (state) => trackerKey.getState(state)?.highlights,
  },
});

function track(editor: Editor, meta: TrackerMeta): void {
  if (editor.isDestroyed) return;
  if (!trackerKey.get(editor.state)) editor.registerPlugin(tracker);
  editor.view.dispatch(editor.state.tr.setMeta(trackerKey, meta).setMeta('addToHistory', false));
}

function highlightedRange(state: EditorState, kind: HighlightKind): Range | null {
  // A highlight over several blocks comes back as one decoration per block.
  const parts = trackerKey.getState(state)?.highlights.find(undefined, undefined, (spec) => spec.kind === kind) ?? [];
  if (parts.length === 0) return null;
  return { from: Math.min(...parts.map((d) => d.from)), to: Math.max(...parts.map((d) => d.to)) };
}

/* ---------- Reading the document ---------- */

/** One character per document position inside a text block, as in `blockText`, but with inline code left readable. */
const leafText = (leaf: PMNode): string => {
  if (leaf.type.name === 'hardBreak') return '\n';
  return leaf.isInline ? '￼' : '';
};

const textblockText = (node: PMNode): string => node.textBetween(0, node.content.size, undefined, leafText);

/** The part of each text block inside a range. */
function blockRanges(doc: PMNode, { from, to }: Range): Range[] {
  const ranges: Range[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = Math.max(from, pos + 1);
    const end = Math.min(to, pos + 1 + node.content.size);
    if (start < end) ranges.push({ from: start, to: end });
    return false;
  });
  return ranges;
}

/** What a range says, with a blank line between blocks. */
function rangeText(doc: PMNode, range: Range): string {
  return blockRanges(doc, range)
    .map(({ from, to }) => doc.textBetween(from, to, undefined, leafText))
    .join('\n\n');
}

/**
 * Pull a range in past any whitespace at its edges. Double-clicking a word often
 * takes the space after it, and a rewrite that replaced it would glue two words.
 */
function tightRange(doc: PMNode, range: Range): Range | null {
  const blocks = blockRanges(doc, range);
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (!first) return null;
  const head = doc.textBetween(first.from, first.to, undefined, leafText);
  const tail = doc.textBetween(last.from, last.to, undefined, leafText);
  const from = first.from + head.length - head.trimStart().length;
  const to = last.to - (tail.length - tail.trimEnd().length);
  return from < to ? { from, to } : null;
}

/** The selected text, as a rewrite would see it. Empty when there is nothing to rewrite. */
export function selectedPassage(state: EditorState): string {
  const range = tightRange(state.doc, state.selection);
  return range ? rangeText(state.doc, range) : '';
}

/** How far to read either side of a passage for context. */
const CONTEXT_REACH = 1500;

/** The text around a range, so that a rewrite fits where it sits. */
function surroundings(doc: PMNode, { from, to }: Range): string | undefined {
  const before = doc.textBetween(Math.max(0, from - CONTEXT_REACH), from, '\n\n', leafText).trim();
  const after = doc.textBetween(to, Math.min(doc.content.size, to + CONTEXT_REACH), '\n\n', leafText).trim();
  if (!before && !after) return undefined;
  return [before, '[the passage]', after].filter(Boolean).join('\n\n');
}

function writingContext(): { goals: Goals; dialect: Dialect } {
  const settings = useSettings.getState();
  return { goals: useLibrary.getState().current?.goals ?? settings.defaultGoals, dialect: settings.dialect };
}

/** The request to rewrite the sentence around an issue, or null if the sentence is gone. */
export function sentenceRequest(state: EditorState, issue: Issue): AiRequest | null {
  const placed = locateIssue(state, issue.id);
  if (!placed || !issue.rewriteHint || sentenceText(state, issue.id) === null) return null;
  const range = {
    from: placed.from + (issue.sentence.from - issue.from),
    to: placed.to + (issue.sentence.to - issue.to),
  };
  return {
    kind: 'rewrite',
    // Read from the document, not `sentenceText`, which masks inline code the rewrite must keep.
    text: rangeText(state.doc, range),
    instruction: issue.rewriteHint,
    context: surroundings(state.doc, range),
    ...writingContext(),
  };
}

/* ---------- Writing to the document ---------- */

/** The marks every part of a range shares, so that rewriting a bold passage leaves it bold. */
function sharedMarks(doc: PMNode, { from, to }: Range): readonly Mark[] {
  let shared: readonly Mark[] | null = null;
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) shared = shared ? shared.filter((mark) => mark.isInSet(node.marks)) : node.marks;
  });
  return shared ?? [];
}

function inlineContent(schema: Schema, text: string, marks: readonly Mark[]): Fragment {
  const nodes: PMNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push(schema.nodes.hardBreak.create());
    if (line) nodes.push(schema.text(line, marks));
  });
  return Fragment.fromArray(nodes);
}

const paragraphsOf = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

function paragraphNodes(schema: Schema, text: string, marks: readonly Mark[] = []): PMNode[] {
  return paragraphsOf(text).map((paragraph) => schema.nodes.paragraph.create(null, inlineContent(schema, paragraph, marks)));
}

/** Put rewritten text over a range and select it, so the writer can see what changed. */
function writeRewrite(tr: Transaction, range: Range, output: string): void {
  const { doc } = tr;
  const { schema } = doc.type;
  const marks = sharedMarks(doc, range);
  const blocks = blockRanges(doc, range);
  const isCode = (block: Range) => doc.resolve(block.from).parent.type.spec.code === true;
  const paragraphs = blocks.length === 1 && isCode(blocks[0]) ? [output] : paragraphsOf(output);

  if (paragraphs.length === blocks.length) {
    // The same shape: each paragraph goes back into its own block, so headings
    // and list items stay what they are. Last first, so earlier positions hold.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const content = isCode(blocks[i]) ? schema.text(paragraphs[i]) : inlineContent(schema, paragraphs[i], marks);
      tr.replaceWith(blocks[i].from, blocks[i].to, content);
    }
  } else {
    tr.replaceRange(range.from, range.to, Slice.maxOpen(Fragment.from(paragraphNodes(schema, output, marks))));
  }
  const $start = tr.doc.resolve(tr.mapping.map(range.from, -1));
  const $end = tr.doc.resolve(tr.mapping.map(range.to, 1));
  tr.setSelection(TextSelection.between($start, $end));
}

/** Apply an AI edit as one undo step of its own and hand the keyboard back to the document. */
function commit(editor: Editor, tr: Transaction, meta: TrackerMeta = {}): void {
  editor.view.dispatch(closeHistory(tr).setMeta(trackerKey, { reveal: null, ...meta }).scrollIntoView());
  editor.view.focus();
}

/* ---------- Reading AI replies ---------- */

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const markdown = new Marked({
  renderer: {
    // A reply is text, not markup to obey: raw HTML stays visible as typed, and
    // nothing here should ever fetch a remote image from a private document.
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
  },
});

export function markdownToHtml(text: string): string {
  return markdown.parse(text, { async: false });
}

/** Split a reader's reaction into its bullet points. Works on a reply that is still arriving. */
export function reactionItems(text: string): string[] {
  const items: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1]);
    else if (items.length > 0) items[items.length - 1] += ` ${line}`;
    else items.push(line);
  }
  return items;
}

export interface AiErrorHelp {
  message: string;
  /** What the service itself said, when that is more than a generic failure. */
  detail?: string;
  next: 'settings' | 'retry' | null;
}

/** Turn an error into words for the writer, and the step most likely to fix it. */
export function explainAiError({ code, message }: AiErrorInfo): AiErrorHelp {
  // The SDK's error messages embed the raw response body; only its "message" is meant for people.
  const raw = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(message)?.[1];
  const said = raw
    ? { message: 'The AI service could not complete this request.', detail: raw.replace(/\\(.)/g, '$1') }
    : { message };
  switch (code) {
    case 'no-key':
    case 'auth':
    case 'bad-request':
      return { ...said, next: 'settings' };
    case 'rate-limit':
    case 'overloaded':
    case 'network':
    case 'declined':
    case 'unknown':
      return { ...said, next: 'retry' };
    case 'truncated':
    case 'too-long':
    case 'cancelled':
      return { ...said, next: null };
  }
}

/* ---------- The store ---------- */

export type AiSectionId = 'rewrite' | 'compose' | 'reader' | 'proofread';
export type AiStatus = 'idle' | 'running' | 'done' | 'failed';
type TextSection = Exclude<AiSectionId, 'proofread'>;

interface TextRun {
  status: AiStatus;
  /** The reply so far. */
  output: string;
  error: AiErrorInfo | null;
}

export interface RewriteRun extends TextRun {
  /** The passage, exactly as it was sent. */
  source: string;
  instruction: string;
  /** Names the instruction in the preview, e.g. "Shorten it". */
  label: string;
  /** Why the last attempt to use the result did not go through. */
  note: string | null;
}

export interface SuggestionCard extends AiSuggestion {
  id: string;
  /** Why the last Apply did not go through. */
  note: string | null;
}

export interface ProofreadRun {
  status: AiStatus;
  cards: SuggestionCard[];
  /** How many suggestions the reply had, before any were applied or dismissed. */
  found: number;
  error: AiErrorInfo | null;
}

const IDLE_TEXT: TextRun = { status: 'idle', output: '', error: null };
const IDLE_REWRITE: RewriteRun = { ...IDLE_TEXT, source: '', instruction: '', label: '', note: null };
const IDLE_PROOFREAD: ProofreadRun = { status: 'idle', cards: [], found: 0, error: null };

const TEXT_CHANGED = 'The selected text has changed, so it was not replaced. Insert the result below it, or discard this and select the text again.';
const QUOTE_MISSING = 'This text has changed, so the suggestion was not applied.';
const QUOTE_REPEATED = 'This text appears more than once in the paragraph, so the suggestion was not applied. Change it by hand.';

/** Find a suggestion's quote in its paragraph, or say why it cannot be used. */
function findQuote(state: EditorState, card: AiSuggestion): Range | string {
  const pos = trackerKey.getState(state)?.paragraphs[card.paragraph] ?? null;
  const node = pos === null ? null : state.doc.nodeAt(pos);
  if (pos === null || !node?.isTextblock) return QUOTE_MISSING;
  const text = textblockText(node);
  const index = text.indexOf(card.quote);
  if (index < 0) return QUOTE_MISSING;
  if (text.indexOf(card.quote, index + 1) >= 0) return QUOTE_REPEATED;
  const from = pos + 1 + index;
  return { from, to: from + card.quote.length };
}

const errorInfo = (err: unknown): AiErrorInfo =>
  err instanceof AiError ? err.toInfo() : { code: 'unknown', message: err instanceof Error ? err.message : String(err) };

/** The request each section has in flight. Starting another stops the first. */
const inFlight = new Map<AiSectionId, AbortController>();

function claim(section: AiSectionId): AbortSignal {
  inFlight.get(section)?.abort();
  const controller = new AbortController();
  inFlight.set(section, controller);
  return controller.signal;
}

function release(section: AiSectionId): void {
  inFlight.get(section)?.abort();
  inFlight.delete(section);
}

const currentEditor = (): Editor | null => useSession.getState().editor;

interface AiState {
  /** Which sections are expanded. */
  open: Record<AiSectionId, boolean>;
  customInstruction: string;
  composePrompt: string;
  readerName: string;
  /** The custom instruction box should take the keyboard once it is on screen. */
  focusInstruction: boolean;

  rewrite: RewriteRun;
  compose: TextRun;
  reader: TextRun;
  proofread: ProofreadRun;

  toggleSection(section: AiSectionId): void;
  /** Bring a section into view from anywhere in the app. */
  showSection(section: AiSectionId): void;
  setDraft(draft: Partial<Pick<AiState, 'customInstruction' | 'composePrompt' | 'readerName'>>): void;
  /** Stop a request and forget its partial result. */
  cancel(section: AiSectionId): void;

  /** Rewrite the current selection. */
  runRewrite(instruction: string, label: string): void;
  retryRewrite(): void;
  /** Put the result over the passage it was made from. */
  replaceRewrite(): void;
  insertRewriteBelow(): void;
  discardRewrite(): void;

  runCompose(): void;
  insertComposed(): void;
  discardComposed(): void;

  runReader(): void;
  clearReader(): void;

  runProofread(): void;
  applySuggestion(id: string): void;
  dismissSuggestion(id: string): void;
  /** Show a suggestion's quote in the document, or stop showing one. */
  revealSuggestion(id: string | null): void;

  /** Forget every result, because they belong to a document that is no longer open. */
  clearResults(): void;
}

export const useAi = create<AiState>()((set, get) => {
  const patchRewrite = (patch: Partial<RewriteRun>) => set((s) => ({ rewrite: { ...s.rewrite, ...patch } }));
  const patchRun = (section: TextSection, patch: Partial<TextRun>) =>
    set((s) => ({ [section]: { ...s[section], ...patch } }));

  const stream = async (section: TextSection, request: AiRequest): Promise<void> => {
    const signal = claim(section);
    patchRun(section, { status: 'running', output: '', error: null });
    try {
      const result = await runAi(request, {
        signal,
        onText: (delta) => {
          if (!signal.aborted) patchRun(section, { output: get()[section].output + delta });
        },
      });
      if (signal.aborted) return;
      const text = result.kind === 'text' ? result.text : '';
      if (!text) throw new AiError('unknown', 'The reply came back empty. Try again.');
      // The final text rather than the pieces: if a declined attempt was retried on
      // another model, the pieces hold both attempts and only this has the right one.
      patchRun(section, { status: 'done', output: text });
    } catch (err) {
      if (!signal.aborted) patchRun(section, { status: 'failed', error: errorInfo(err) });
    }
  };

  const requestRewrite = (editor: Editor, range: Range) => {
    const { source, instruction } = get().rewrite;
    void stream('rewrite', {
      kind: 'rewrite',
      text: source,
      instruction,
      context: surroundings(editor.state.doc, range),
      ...writingContext(),
    });
  };

  /** Where the rewrite's passage is now, if it still says what was sent. */
  const intactTarget = (editor: Editor): Range | null => {
    const range = highlightedRange(editor.state, 'target');
    return range && rangeText(editor.state.doc, range) === get().rewrite.source ? range : null;
  };

  const endRewrite = () => {
    const editor = currentEditor();
    if (editor) track(editor, { target: null });
    set({ rewrite: IDLE_REWRITE });
  };

  return {
    open: { rewrite: true, compose: false, reader: false, proofread: false },
    customInstruction: '',
    composePrompt: '',
    readerName: '',
    focusInstruction: false,

    rewrite: IDLE_REWRITE,
    compose: IDLE_TEXT,
    reader: IDLE_TEXT,
    proofread: IDLE_PROOFREAD,

    toggleSection: (section) => set((s) => ({ open: { ...s.open, [section]: !s.open[section] } })),

    showSection(section) {
      useSettings.getState().update({ assistantOpen: true });
      useSession.getState().setTab('ai');
      set((s) => ({ open: { ...s.open, [section]: true } }));
    },

    setDraft: (draft) => set(draft),

    cancel(section) {
      release(section);
      if (section === 'rewrite') endRewrite();
      else if (section === 'proofread') set({ proofread: IDLE_PROOFREAD });
      else set({ [section]: IDLE_TEXT });
    },

    runRewrite(instruction, label) {
      const editor = currentEditor();
      if (!editor) return;
      const { doc, selection } = editor.state;
      const range = tightRange(doc, selection);
      if (!range) return;
      track(editor, { target: range });
      set({ rewrite: { ...IDLE_REWRITE, source: rangeText(doc, range), instruction, label } });
      requestRewrite(editor, range);
    },

    retryRewrite() {
      const editor = currentEditor();
      if (!editor) return;
      const range = intactTarget(editor);
      if (range) {
        patchRewrite({ note: null });
        requestRewrite(editor, range);
      } else {
        patchRewrite({ note: TEXT_CHANGED });
      }
    },

    replaceRewrite() {
      const editor = currentEditor();
      if (!editor) return;
      const range = intactTarget(editor);
      if (!range) {
        patchRewrite({ note: TEXT_CHANGED });
        return;
      }
      const tr = editor.state.tr;
      writeRewrite(tr, range, get().rewrite.output);
      commit(editor, tr, { target: null });
      set({ rewrite: IDLE_REWRITE });
      useSession.getState().notify(`Replaced. Press ${MOD}+Z to undo.`);
    },

    insertRewriteBelow() {
      const editor = currentEditor();
      if (!editor) return;
      const { doc, schema, selection } = editor.state;
      const anchor = highlightedRange(editor.state, 'target')?.to ?? selection.to;
      const $anchor = doc.resolve(anchor);
      const tr = editor.state.tr;
      const steps = tr.steps.length;
      tr.insert($anchor.parent.isTextblock ? $anchor.after() : anchor, paragraphNodes(schema, get().rewrite.output));
      selectionToInsertionEnd(tr, steps, -1);
      commit(editor, tr, { target: null });
      set({ rewrite: IDLE_REWRITE });
    },

    discardRewrite() {
      release('rewrite');
      endRewrite();
    },

    runCompose() {
      const editor = currentEditor();
      const prompt = get().composePrompt.trim();
      if (!editor || !prompt) return;
      const document = plainText(editor.state.doc);
      void stream('compose', { kind: 'compose', prompt, document: document || undefined, ...writingContext() });
    },

    insertComposed() {
      const editor = currentEditor();
      if (!editor) return;
      const { schema, selection } = editor.state;
      const content = createNodeFromContent(markdownToHtml(get().compose.output), schema, { slice: true });
      // Added after any selection rather than over it, and never inside a code block.
      const pos = selection.$to.parent.type.spec.code ? selection.$to.after() : selection.to;
      const tr = editor.state.tr;
      const steps = tr.steps.length;
      tr.replaceRange(pos, pos, Slice.maxOpen(Fragment.from(content)));
      selectionToInsertionEnd(tr, steps, -1);
      commit(editor, tr);
      set({ compose: IDLE_TEXT });
    },

    discardComposed: () => get().cancel('compose'),

    runReader() {
      const editor = currentEditor();
      const reader = get().readerName.trim();
      const document = editor ? plainText(editor.state.doc) : '';
      if (!reader || !document) return;
      void stream('reader', { kind: 'reader', reader, document });
    },

    clearReader: () => get().cancel('reader'),

    runProofread() {
      const editor = currentEditor();
      if (!editor) return;
      const { doc } = editor.state;
      const blocks = extractBlocks(doc)
        .filter((block) => block.kind !== 'code')
        .map(({ pos }) => ({ pos, text: textblockText(doc.nodeAt(pos) as PMNode) }))
        .filter(({ text }) => text.trim());
      if (blocks.length === 0) return;

      track(editor, { paragraphs: blocks.map((block) => block.pos), reveal: null });
      const signal = claim('proofread');
      set({ proofread: { ...IDLE_PROOFREAD, status: 'running' } });
      runAi({ kind: 'proofread', paragraphs: blocks.map((block) => block.text), ...writingContext() }, { signal })
        .then((result) => {
          if (signal.aborted) return;
          const suggestions = result.kind === 'proofread' ? result.suggestions : [];
          const cards = suggestions.map((suggestion, index) => ({ ...suggestion, id: String(index), note: null }));
          set({ proofread: { status: 'done', cards, found: cards.length, error: null } });
        })
        .catch((err: unknown) => {
          if (!signal.aborted) set({ proofread: { ...IDLE_PROOFREAD, status: 'failed', error: errorInfo(err) } });
        });
    },

    applySuggestion(id) {
      const editor = currentEditor();
      const card = get().proofread.cards.find((c) => c.id === id);
      if (!editor || !card) return;
      const place = findQuote(editor.state, card);
      if (typeof place === 'string') {
        set((s) => ({
          proofread: { ...s.proofread, cards: s.proofread.cards.map((c) => (c.id === id ? { ...c, note: place } : c)) },
        }));
        return;
      }
      const { doc, schema, tr } = editor.state;
      tr.replaceWith(place.from, place.to, inlineContent(schema, card.replacement, sharedMarks(doc, place)));
      commit(editor, tr);
      get().dismissSuggestion(id);
    },

    dismissSuggestion: (id) =>
      set((s) => ({ proofread: { ...s.proofread, cards: s.proofread.cards.filter((c) => c.id !== id) } })),

    revealSuggestion(id) {
      const editor = currentEditor();
      if (!editor) return;
      const card = get().proofread.cards.find((c) => c.id === id);
      const place = card ? findQuote(editor.state, card) : null;
      const range = typeof place === 'string' ? null : place;
      track(editor, { reveal: range });
      if (range) editor.view.dom.querySelector('.ws-ai-reveal')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },

    clearResults() {
      for (const section of inFlight.keys()) release(section);
      set({ rewrite: IDLE_REWRITE, compose: IDLE_TEXT, reader: IDLE_TEXT, proofread: IDLE_PROOFREAD });
    },
  };
});

// Everything above points into one document, so opening another starts clean.
useSession.subscribe((state, previous) => {
  if (state.editor !== previous.editor) useAi.getState().clearResults();
});
