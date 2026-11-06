/**
 * State for the current editing session: the editor instance, the latest
 * analysis, and what the Assistant panel is showing. Not persisted.
 */
import type { Editor } from '@tiptap/react';
import { create } from 'zustand';
import type { AnalysisResult, Category, IssueType } from '@engine/types';
import type { EngineStatus } from '../editor/analysisClient';

export type AssistantTab = 'review' | 'insights' | 'ai';
export type DialogName = 'goals' | 'settings';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

export interface SelectionStats {
  words: number;
  characters: number;
}

interface SessionState {
  editor: Editor | null;
  result: AnalysisResult | null;
  /** An analysis is scheduled or running. */
  checking: boolean;
  engine: EngineStatus;
  activeIssue: string | null;
  category: Category | 'all';
  type: IssueType | null;
  tab: AssistantTab;
  dialog: DialogName | null;
  /** The part of Settings to show first. */
  settingsSection: string | null;
  toast: Toast | null;
  selection: SelectionStats | null;

  setEditor(editor: Editor | null): void;
  setResult(result: AnalysisResult | null): void;
  setChecking(checking: boolean): void;
  setEngine(engine: EngineStatus): void;
  setActiveIssue(id: string | null): void;
  setFilter(category: Category | 'all', type?: IssueType | null): void;
  setTab(tab: AssistantTab): void;
  openDialog(dialog: DialogName | null, section?: string): void;
  notify(message: string, kind?: Toast['kind']): void;
  dismissToast(): void;
  setSelection(selection: SelectionStats | null): void;
}

let toastId = 0;

export const useSession = create<SessionState>()((set) => ({
  editor: null,
  result: null,
  checking: false,
  engine: { started: false, grammarEngineReady: false },
  activeIssue: null,
  category: 'all',
  type: null,
  tab: 'review',
  dialog: null,
  settingsSection: null,
  toast: null,
  selection: null,

  setEditor: (editor) => set({ editor }),
  setResult: (result) =>
    set((s) => ({
      result,
      // Drop the active marker if that issue is gone.
      activeIssue: s.activeIssue && result?.issues.some((i) => i.id === s.activeIssue) ? s.activeIssue : null,
    })),
  setChecking: (checking) => set((s) => (s.checking === checking ? s : { checking })),
  setEngine: (engine) => set({ engine }),
  setActiveIssue: (id) => set((s) => (s.activeIssue === id ? s : { activeIssue: id })),
  setFilter: (category, type = null) => set({ category, type }),
  setTab: (tab) => set({ tab }),
  openDialog: (dialog, section) => set({ dialog, settingsSection: section ?? null }),
  notify: (message, kind = 'info') => set({ toast: { id: ++toastId, message, kind } }),
  dismissToast: () => set({ toast: null }),
  setSelection: (selection) =>
    set((s) =>
      s.selection?.words === selection?.words && s.selection?.characters === selection?.characters ? s : { selection },
    ),
}));
