/**
 * Connects one editor to the analysis worker: re-checks after edits, places the
 * results as underlines, saves the document, and reacts to settings changes.
 */
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { countWords } from '@engine/text';
import { CATEGORIES, ISSUE_TYPES, type AnalysisResult, type Category, type Issue, type IssueType } from '@engine/types';
import { useLibrary } from '../state/library';
import { useSession } from '../state/session';
import { engineSettings, useSettings } from '../state/settings';
import { analysisClient } from './analysisClient';
import { blockIndexAt, extractBlocks, type DocBlock } from './blocks';
import { setActiveIssue, setIssues, type PlacedIssue } from './issues';

/** Pause after the last keystroke before re-checking. */
const TYPING_DELAY = 320;
const SAVE_DELAY = 300;

function recount(issues: Issue[]): AnalysisResult['counts'] {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const byType = Object.fromEntries(ISSUE_TYPES.map((t) => [t, 0])) as Record<IssueType, number>;
  for (const issue of issues) {
    byCategory[issue.category]++;
    byType[issue.type]++;
  }
  return { total: issues.length, byCategory, byType };
}

interface Snapshot {
  doc: PMNode;
  blocks: DocBlock[];
  caretBlock: number | undefined;
  result: AnalysisResult;
}

export class AnalysisController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: Snapshot | null = null;
  private disposed = false;
  private configKey = '';
  /** A spelling flag is being held back because the writer is still typing that word. */
  private holding = false;
  private readonly unsubscribe: Array<() => void>;
  private goals = useLibrary.getState().current?.goals;
  private dismissed = useLibrary.getState().current?.dismissed;

  constructor(private readonly editor: Editor) {
    editor.on('update', this.onUpdate);
    editor.on('selectionUpdate', this.onSelection);
    editor.on('blur', this.onBlur);
    this.unsubscribe = [
      useSettings.subscribe(() => {
        if (this.configure()) this.schedule(0);
      }),
      useLibrary.subscribe((state) => {
        const current = state.current;
        if (!current) return;
        if (current.goals !== this.goals) {
          this.goals = current.goals;
          if (this.configure()) this.schedule(0);
        }
        if (current.dismissed !== this.dismissed) {
          this.dismissed = current.dismissed;
          this.schedule(0);
        }
      }),
      useSession.subscribe((state, previous) => {
        if (state.activeIssue !== previous.activeIssue && !this.editor.isDestroyed) {
          setActiveIssue(this.editor.view, state.activeIssue);
        }
      }),
    ];
    this.configure();
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.save();
    }
    this.editor.off('update', this.onUpdate);
    this.editor.off('selectionUpdate', this.onSelection);
    this.editor.off('blur', this.onBlur);
    for (const off of this.unsubscribe) off();
  }

  /** Push the current settings and goals to the engine. Returns true if they changed. */
  private configure(): boolean {
    const settings = useSettings.getState();
    const goals = useLibrary.getState().current?.goals ?? settings.defaultGoals;
    const next = engineSettings(settings, goals);
    const key = JSON.stringify(next);
    if (key === this.configKey) return false;
    this.configKey = key;
    analysisClient.configure(next);
    return true;
  }

  schedule(delay = TYPING_DELAY): void {
    if (this.disposed) return;
    useSession.getState().setChecking(true);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private caretBlock(blocks: DocBlock[]): number | undefined {
    const { selection } = this.editor.state;
    if (!selection.empty || !this.editor.isFocused) return undefined;
    return blockIndexAt(blocks, selection.head);
  }

  private async run(): Promise<void> {
    if (this.disposed || this.editor.isDestroyed) return;
    const doc = this.editor.state.doc;
    const blocks = extractBlocks(doc);
    const caretBlock = this.caretBlock(blocks);
    const result = await analysisClient.analyze({
      blocks: blocks.map(({ text, kind }) => ({ text, kind })),
      dismissed: useLibrary.getState().current?.dismissed ?? [],
      caretBlock,
    });
    if (this.disposed || this.editor.isDestroyed) return;
    // The text changed while this was running: a newer check is already scheduled.
    if (this.editor.state.doc !== doc) return;
    if (!result) {
      if (!this.timer) useSession.getState().setChecking(false);
      return;
    }
    this.snapshot = { doc, blocks, caretBlock, result };
    this.place();
    if (!this.timer) useSession.getState().setChecking(false);
  }

  /** Draw the latest results, holding back a spelling flag on a word still being typed. */
  private place(): void {
    const snapshot = this.snapshot;
    if (!snapshot || this.editor.isDestroyed || this.editor.state.doc !== snapshot.doc) return;
    const { selection } = this.editor.state;
    const caret = selection.empty && this.editor.isFocused ? selection.head : -1;

    const placed: PlacedIssue[] = [];
    let held = false;
    for (const issue of snapshot.result.issues) {
      const block = snapshot.blocks[issue.block];
      if (!block) continue;
      const from = block.pos + 1 + issue.from;
      const to = block.pos + 1 + issue.to;
      if (issue.type === 'spelling' && caret === to) {
        held = true;
        continue;
      }
      placed.push({ issue, from, to });
    }
    this.holding = held;
    setIssues(this.editor.view, placed);

    const issues = placed.map((p) => p.issue);
    const session = useSession.getState();
    session.setResult(held ? { ...snapshot.result, issues, counts: recount(issues) } : snapshot.result);
    setActiveIssue(this.editor.view, useSession.getState().activeIssue);
    useLibrary.getState().setSummary({ issues: issues.length, score: snapshot.result.score });
  }

  private save(): void {
    if (this.editor.isDestroyed) return;
    const doc = this.editor.state.doc;
    const preview = doc.textBetween(0, Math.min(doc.content.size, 600), ' ', ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const words = this.snapshot?.doc === doc ? this.snapshot.result.stats.words : countWords(doc.textBetween(0, doc.content.size, ' ', ' '));
    useLibrary.getState().saveContent(this.editor.getJSON(), { preview, words });
  }

  private readonly onUpdate = (): void => {
    this.schedule();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY);
  };

  private readonly onSelection = (): void => {
    this.updateSelectionStats();
    const snapshot = this.snapshot;
    if (!snapshot || this.editor.state.doc !== snapshot.doc) return;
    // Moving to another paragraph changes which one counts as "being typed".
    if (this.caretBlock(snapshot.blocks) !== snapshot.caretBlock) this.schedule(150);
    else if (this.holding) this.place();
  };

  private readonly onBlur = (): void => {
    if (this.holding) this.place();
    if (this.snapshot?.caretBlock !== undefined) this.schedule(150);
  };

  private updateSelectionStats(): void {
    const { selection, doc } = this.editor.state;
    if (selection.empty) {
      useSession.getState().setSelection(null);
      return;
    }
    const text = doc.textBetween(selection.from, selection.to, '\n', ' ');
    useSession.getState().setSelection({ words: countWords(text), characters: Array.from(text.replace(/\n/g, '')).length });
  }
}
