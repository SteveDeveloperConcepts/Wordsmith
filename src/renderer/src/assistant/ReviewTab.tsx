import { CheckCheck, CircleCheck, PenLine, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, type ReactNode } from 'react';
import {
  CATEGORIES,
  CATEGORY_HINT,
  CATEGORY_LABEL,
  ISSUE_TYPES,
  TYPE_LABEL,
  type Issue,
} from '@engine/types';
import { useIssueActions } from '../editor/useIssueActions';
import { MOD } from '../platform';
import { useLibrary } from '../state/library';
import { useSession } from '../state/session';
import { IssueCard } from './IssueCard';

interface Props {
  /** Renders the AI rewrite control for issues that have no mechanical fix. */
  renderExtra?(issue: Issue): ReactNode;
}

/** Corrections that are safe to apply in bulk: a definite error with a concrete replacement. */
export const bulkFixable = (issue: Issue) => issue.category === 'correctness' && issue.fixes.length > 0;

export function ReviewTab({ renderExtra }: Props) {
  const result = useSession((s) => s.result);
  const checking = useSession((s) => s.checking);
  const engine = useSession((s) => s.engine);
  const activeIssue = useSession((s) => s.activeIssue);
  const category = useSession((s) => s.category);
  const type = useSession((s) => s.type);
  const setFilter = useSession((s) => s.setFilter);
  const setActiveIssue = useSession((s) => s.setActiveIssue);
  const notify = useSession((s) => s.notify);
  const dismissedCount = useLibrary((s) => s.current?.dismissed.length ?? 0);
  const restoreDismissed = useLibrary((s) => s.restoreDismissed);
  const actions = useIssueActions();

  const issues = result?.issues ?? [];
  const inCategory = useMemo(
    () => (category === 'all' ? issues : issues.filter((i) => i.category === category)),
    [issues, category],
  );
  const visible = useMemo(() => (type ? inCategory.filter((i) => i.type === type) : inCategory), [inCategory, type]);
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of inCategory) counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
    return ISSUE_TYPES.filter((t) => counts.has(t)).map((t) => ({ type: t, count: counts.get(t) ?? 0 }));
  }, [inCategory]);

  // A type filter that no longer matches anything would hide everything: clear it.
  useEffect(() => {
    if (type && !inCategory.some((i) => i.type === type)) setFilter(category, null);
  }, [type, inCategory, category, setFilter]);

  // Bring the active card into view, e.g. after clicking an underline in the text.
  useEffect(() => {
    if (!activeIssue) return;
    document.querySelector(`[data-card="${CSS.escape(activeIssue)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIssue]);

  const bulk = visible.filter(bulkFixable).length;
  const acceptAll = () => {
    const ids = new Set(visible.filter(bulkFixable).map((i) => i.id));
    const applied = actions.acceptAll((issue) => ids.has(issue.id));
    if (applied > 0) notify(`Applied ${applied} correction${applied === 1 ? '' : 's'}. Press ${MOD}+Z to undo.`);
  };

  const words = result?.stats.words ?? 0;

  return (
    <div className="review">
      <div className="filters" role="tablist" aria-label="Suggestion categories">
        <button
          type="button"
          role="tab"
          aria-selected={category === 'all'}
          className={`filter${category === 'all' ? ' is-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All <span className="filter__count">{issues.length}</span>
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={category === c}
            className={`filter filter--${c}${category === c ? ' is-active' : ''}`}
            title={CATEGORY_HINT[c]}
            onClick={() => setFilter(c)}
          >
            <span className={`dot dot--${c}`} />
            {CATEGORY_LABEL[c]}
            <span className="filter__count">{result?.counts.byCategory[c] ?? 0}</span>
          </button>
        ))}
      </div>

      {types.length > 1 && (
        <div className="chips" aria-label="Filter by kind of issue">
          {types.map(({ type: t, count }) => (
            <button
              key={t}
              type="button"
              className={`chip${type === t ? ' is-active' : ''}`}
              aria-pressed={type === t}
              onClick={() => setFilter(category, type === t ? null : t)}
            >
              {TYPE_LABEL[t]} <span className="chip__count">{count}</span>
            </button>
          ))}
        </div>
      )}

      {engine.started && !engine.grammarEngineReady && (
        <div className="notice notice--warn">
          <TriangleAlert size={16} aria-hidden />
          <div>
            <strong>The grammar engine did not load.</strong> Style and punctuation checks are still running, but
            spelling and some grammar checks are unavailable.
            {engine.error ? <span className="notice__detail"> ({engine.error})</span> : null}
          </div>
        </div>
      )}

      {bulk >= 2 && (
        <button type="button" className="btn btn--outline review__bulk" onClick={acceptAll} title="Applies the first suggestion for each correction">
          <CheckCheck size={15} aria-hidden /> Accept {bulk} corrections
        </button>
      )}

      {visible.length > 0 ? (
        <ul className="cards">
          {visible.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              open={issue.id === activeIssue}
              actions={actions}
              onToggle={() => (issue.id === activeIssue ? setActiveIssue(null) : actions.select(issue))}
              extra={renderExtra?.(issue)}
            />
          ))}
        </ul>
      ) : (
        <div className="empty">
          {words === 0 ? (
            <>
              <PenLine size={28} aria-hidden />
              <h3>Ready when you are</h3>
              <p>Start typing or paste your text. Suggestions appear here as you write.</p>
            </>
          ) : !result || (checking && issues.length === 0 && !engine.started) ? (
            <>
              <div className="spinner" aria-hidden />
              <h3>Checking your text…</h3>
            </>
          ) : issues.length === 0 ? (
            <>
              <CircleCheck size={28} aria-hidden className="empty__ok" />
              <h3>No issues found</h3>
              <p>Nothing to fix here. Nicely done.</p>
            </>
          ) : (
            <>
              <CircleCheck size={28} aria-hidden className="empty__ok" />
              <h3>Nothing in this category</h3>
              <p>
                <button type="button" className="link" onClick={() => setFilter('all')}>
                  Show all {issues.length} suggestions
                </button>
              </p>
            </>
          )}
        </div>
      )}

      {dismissedCount > 0 && (
        <p className="review__dismissed">
          {dismissedCount} dismissed.{' '}
          <button type="button" className="link" onClick={restoreDismissed}>
            Restore
          </button>
        </p>
      )}
    </div>
  );
}
