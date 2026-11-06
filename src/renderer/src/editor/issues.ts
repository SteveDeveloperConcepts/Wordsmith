/**
 * The editor extension that draws issue underlines and applies fixes.
 *
 * Each issue is an inline decoration. Decorations move with the text as the
 * writer types, so an underline stays on its word until the next analysis
 * replaces the whole set; an edit inside a flagged range removes that underline
 * immediately, so a fix is never applied to text that has changed.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Fix, Issue } from '@engine/types';
import { blockText } from './blocks';

export interface PlacedIssue {
  issue: Issue;
  /** Document positions of the flagged text. */
  from: number;
  to: number;
}

type Meta =
  | { type: 'set'; placed: PlacedIssue[] }
  | { type: 'active'; id: string | null }
  | { type: 'remove'; id: string };

interface PluginState {
  decorations: DecorationSet;
  active: string | null;
}

interface Spec {
  issue: Issue;
}

export const issuesKey = new PluginKey<PluginState>('wordsmith-issues');

const specOf = (decoration: Decoration) => decoration.spec as Spec;

function buildSet(state: EditorState['doc'], placed: PlacedIssue[]): DecorationSet {
  const size = state.content.size;
  const decorations: Decoration[] = [];
  for (const { issue, from, to } of placed) {
    if (from < 0 || to > size || from >= to) continue;
    decorations.push(
      Decoration.inline(
        from,
        to,
        {
          class: `ws-issue ws-${issue.category}${issue.sentenceLevel ? ' ws-sentence' : ''}`,
          'data-issue': issue.id,
        },
        { issue } satisfies Spec,
      ),
    );
  }
  return DecorationSet.create(state, decorations);
}

export const IssuesExtension = Extension.create({
  name: 'wordsmithIssues',

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: issuesKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty, active: null }),
          apply(tr, previous) {
            let { decorations, active } = previous;

            if (tr.docChanged) {
              // Step by step: drop underlines whose text this step edits, then move the rest.
              tr.mapping.maps.forEach((map, index) => {
                const stale: Decoration[] = [];
                map.forEach((oldStart, oldEnd) => {
                  for (const d of decorations.find(oldStart, oldEnd)) {
                    // Strict overlap: typing right before or after a flagged word leaves it alone.
                    if (oldStart < d.to && oldEnd > d.from) stale.push(d);
                  }
                });
                if (stale.length) decorations = decorations.remove(stale);
                decorations = decorations.map(new Mapping([map]), tr.docs[index + 1] ?? tr.doc);
              });
            }

            const meta = tr.getMeta(issuesKey) as Meta | undefined;
            if (meta?.type === 'set') {
              decorations = buildSet(tr.doc, meta.placed);
              if (active && !meta.placed.some((p) => p.issue.id === active)) active = null;
            } else if (meta?.type === 'active') {
              active = meta.id;
            } else if (meta?.type === 'remove') {
              decorations = decorations.remove(decorations.find(undefined, undefined, (spec) => (spec as Spec).issue.id === meta.id));
              if (active === meta.id) active = null;
            }
            return { decorations, active };
          },
        },
        props: {
          decorations(state) {
            const plugin = issuesKey.getState(state);
            if (!plugin) return null;
            const { decorations, active } = plugin;
            if (!active) return decorations;
            const found = decorations.find(undefined, undefined, (spec) => (spec as Spec).issue.id === active);
            if (!found.length) return decorations;
            return decorations.add(
              state.doc,
              found.map((d) => Decoration.inline(d.from, d.to, { class: `ws-issue-active ws-${specOf(d).issue.category}` })),
            );
          },
        },
      }),
    ];
  },
});

const quiet = (view: EditorView, meta: Meta) =>
  view.dispatch(view.state.tr.setMeta(issuesKey, meta).setMeta('addToHistory', false));

/** Replace every underline with a fresh set. */
export function setIssues(view: EditorView, placed: PlacedIssue[]): void {
  quiet(view, { type: 'set', placed });
}

export function setActiveIssue(view: EditorView, id: string | null): void {
  if (issuesKey.getState(view.state)?.active === id) return;
  quiet(view, { type: 'active', id });
}

export function removeIssue(view: EditorView, id: string): void {
  quiet(view, { type: 'remove', id });
}

/** Where an issue is right now, after any edits since it was found. */
export function locateIssue(state: EditorState, id: string): PlacedIssue | null {
  const found = issuesKey.getState(state)?.decorations.find(undefined, undefined, (spec) => (spec as Spec).issue.id === id);
  const d = found?.[0];
  return d ? { issue: specOf(d).issue, from: d.from, to: d.to } : null;
}

export function allIssues(state: EditorState): PlacedIssue[] {
  const found = issuesKey.getState(state)?.decorations.find() ?? [];
  return found.map((d) => ({ issue: specOf(d).issue, from: d.from, to: d.to }));
}

/** The flagged text as the engine saw it, for checking that nothing changed underneath. */
function textAt(state: EditorState, from: number, to: number): string | null {
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
  return blockText($from.parent).slice($from.parentOffset, $to.parentOffset);
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

/** Translate a block-relative fix into document positions, or null if the text has changed. */
function editFor(state: EditorState, placed: PlacedIssue, fix: Pick<Fix, 'from' | 'to' | 'text'>): Edit | null {
  const { issue, from, to } = placed;
  if (textAt(state, from, to) !== issue.text) return null;
  const editFrom = from + (fix.from - issue.from);
  const editTo = to + (fix.to - issue.to);
  if (editFrom < 0 || editTo > state.doc.content.size || editFrom > editTo) return null;
  const $from = state.doc.resolve(editFrom);
  const $to = state.doc.resolve(editTo);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
  return { from: editFrom, to: editTo, text: fix.text };
}

function applyEdits(view: EditorView, edits: Edit[]): void {
  // Last edit first, so earlier positions stay valid.
  const ordered = [...edits].sort((a, b) => b.from - a.from);
  let tr = view.state.tr;
  for (const edit of ordered) {
    tr = edit.text ? tr.insertText(edit.text, edit.from, edit.to) : tr.delete(edit.from, edit.to);
  }
  view.dispatch(tr);
}

/** Apply one fix. Returns false if the issue is gone or its text changed. */
export function applyFix(view: EditorView, id: string, fix: Fix): boolean {
  const placed = locateIssue(view.state, id);
  if (!placed) return false;
  const edit = editFor(view.state, placed, fix);
  if (!edit) return false;
  applyEdits(view, [edit]);
  return true;
}

/**
 * Replace the whole sentence around an issue (used for AI rewrites), if it still says
 * what it did. Positions are only known for the flagged words until the next check, so
 * an edit elsewhere in the sentence would be overwritten, and leave its last letters behind.
 */
export function replaceSentence(view: EditorView, id: string, expected: string, text: string): boolean {
  if (sentenceText(view.state, id) !== expected) return false;
  const placed = locateIssue(view.state, id);
  if (!placed) return false;
  const { sentence } = placed.issue;
  const edit = editFor(view.state, placed, { from: sentence.from, to: sentence.to, text });
  if (!edit) return false;
  applyEdits(view, [edit]);
  return true;
}

/** The sentence around an issue, as it is in the document now. */
export function sentenceText(state: EditorState, id: string): string | null {
  const placed = locateIssue(state, id);
  if (!placed) return null;
  const { issue, from, to } = placed;
  return textAt(state, from + (issue.sentence.from - issue.from), to + (issue.sentence.to - issue.to));
}

/**
 * Apply the first fix of every matching issue in one undoable step.
 * Returns how many fixes were applied.
 */
export function applyAllFixes(view: EditorView, accept: (issue: Issue) => boolean): number {
  const edits: Edit[] = [];
  for (const placed of allIssues(view.state)) {
    const fix = placed.issue.fixes[0];
    if (!fix || !accept(placed.issue)) continue;
    const edit = editFor(view.state, placed, fix);
    if (edit) edits.push(edit);
  }
  // Never apply two edits that touch the same text.
  edits.sort((a, b) => a.from - b.from);
  const safe: Edit[] = [];
  let end = -1;
  for (const edit of edits) {
    if (edit.from < end) continue;
    safe.push(edit);
    end = Math.max(end, edit.to);
  }
  if (safe.length) applyEdits(view, safe);
  return safe.length;
}

/** The on-screen element for an issue, if it is rendered. */
export function issueElement(view: EditorView, id: string): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(`[data-issue="${CSS.escape(id)}"]`);
}

export function scrollIssueIntoView(view: EditorView, id: string): void {
  issueElement(view, id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
