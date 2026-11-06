import { useMemo } from 'react';
import type { Fix, Issue } from '@engine/types';
import { useLibrary } from '../state/library';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { applyAllFixes, applyFix, removeIssue, scrollIssueIntoView } from './issues';

/** Everything a suggestion card can do. */
export function useIssueActions() {
  return useMemo(() => {
    const view = () => useSession.getState().editor?.view ?? null;
    const session = () => useSession.getState();

    return {
      /** Apply a fix to the document. */
      accept(issue: Issue, fix: Fix): void {
        const v = view();
        if (!v) return;
        if (!applyFix(v, issue.id, fix)) {
          session().notify('That text has changed, so this suggestion no longer applies.');
        }
        session().setActiveIssue(null);
      },

      /** Hide this suggestion for good in this document. */
      dismiss(issue: Issue): void {
        const v = view();
        if (v) removeIssue(v, issue.id);
        useLibrary.getState().dismiss(issue.id);
        session().setActiveIssue(null);
      },

      addToDictionary(issue: Issue): void {
        if (!issue.word) return;
        useSettings.getState().addWord(issue.word);
        session().notify(`Added “${issue.word}” to your dictionary.`);
        session().setActiveIssue(null);
      },

      disableRule(issue: Issue): void {
        useSettings.getState().disableRule(issue.ruleId);
        session().notify('That check is now off. You can turn it back on in Settings.');
        session().setActiveIssue(null);
      },

      /** Focus an issue: highlight it in the text and open its card. */
      select(issue: Issue, scroll = true): void {
        session().setActiveIssue(issue.id);
        const v = view();
        if (v && scroll) scrollIssueIntoView(v, issue.id);
      },

      /** Accept the first suggestion for every issue that passes `accept`. */
      acceptAll(accept: (issue: Issue) => boolean): number {
        const v = view();
        if (!v) return 0;
        const count = applyAllFixes(v, accept);
        session().setActiveIssue(null);
        return count;
      },
    };
  }, []);
}

export type IssueActions = ReturnType<typeof useIssueActions>;
