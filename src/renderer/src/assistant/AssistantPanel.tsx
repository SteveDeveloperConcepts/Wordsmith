import type { ReactNode } from 'react';
import { plural } from '../lib/format';
import { useSession, type AssistantTab } from '../state/session';
import { ReviewTab } from './ReviewTab';
import { ScoreRing, scoreLabel } from './ScoreRing';

export interface TabDefinition {
  id: AssistantTab;
  label: string;
  render(): ReactNode;
}

interface Props {
  /** Tabs after "Review". */
  extraTabs?: TabDefinition[];
  /** Controls shown at the right of the header (the goals button). */
  headerAction?: ReactNode;
  /** AI rewrite control for issues with no mechanical fix. */
  renderIssueExtra?: Parameters<typeof ReviewTab>[0]['renderExtra'];
}

/** The right-hand panel: overall score, then tabs for suggestions and more. */
export function AssistantPanel({ extraTabs = [], headerAction, renderIssueExtra }: Props) {
  const result = useSession((s) => s.result);
  const tab = useSession((s) => s.tab);
  const setTab = useSession((s) => s.setTab);

  const score = result?.score ?? null;
  const total = result?.counts.total ?? 0;
  const tabs: TabDefinition[] = [
    { id: 'review', label: 'Review', render: () => <ReviewTab renderExtra={renderIssueExtra} /> },
    ...extraTabs,
  ];
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <aside className="assistant" aria-label="Writing assistant">
      <div className="assistant__header">
        <ScoreRing score={score} />
        <div className="assistant__summary">
          <div className="assistant__label">Overall score</div>
          <div className="assistant__status">{scoreLabel(score)}</div>
        </div>
        {headerAction}
      </div>

      {tabs.length > 1 && (
        <div className="assistant__tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === active.id}
              className={`tab${t.id === active.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'review' && total > 0 && (
                <span className="tab__badge" aria-label={plural(total, 'suggestion')}>
                  {total}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="assistant__body" role="tabpanel">
        {active.render()}
      </div>
    </aside>
  );
}
