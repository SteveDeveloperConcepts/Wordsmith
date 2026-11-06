import { ArrowRight, BookPlus, EyeOff, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { TYPE_LABEL, type Fix, type Issue } from '@engine/types';
import type { IssueActions } from '../editor/useIssueActions';

interface IssueDetailProps {
  issue: Issue;
  actions: IssueActions;
  /** Extra controls under the explanation (the AI rewrite, when available). */
  extra?: ReactNode;
  /** The popover variant leaves out the rule switch to stay small. */
  compact?: boolean;
}

/** How the flagged text is shown: long sentences are clipped in the middle. */
function clip(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const half = Math.floor((max - 1) / 2);
  return `${clean.slice(0, half).trimEnd()} … ${clean.slice(-half).trimStart()}`;
}

function fixLabel(fix: Fix): string {
  return fix.label === 'Remove' ? 'Remove' : clip(fix.label, 60);
}

/** The explanation, suggested fixes, and actions for one issue. */
export function IssueDetail({ issue, actions, extra, compact = false }: IssueDetailProps) {
  const removalOnly = issue.fixes.length > 0 && issue.fixes.every((f) => f.label === 'Remove');
  return (
    <div className="issue">
      <div className="issue__type">
        <span className={`dot dot--${issue.category}`} />
        {TYPE_LABEL[issue.type]}
      </div>
      <div className="issue__title">{issue.title}</div>

      {issue.fixes.length > 0 && (
        <div className="issue__change">
          <span className={`issue__old${removalOnly ? ' issue__old--strike' : ''}`}>{clip(issue.text, 70)}</span>
          {!removalOnly && <ArrowRight size={14} className="issue__arrow" aria-hidden />}
          <div className="issue__fixes">
            {issue.fixes.map((fix, index) => (
              <button
                key={`${fix.label}-${index}`}
                type="button"
                className={`fix fix--${issue.category}${index === 0 ? ' fix--primary' : ''}`}
                onClick={() => actions.accept(issue, fix)}
                title={`Apply: ${fix.label}`}
              >
                {fixLabel(fix)}
              </button>
            ))}
          </div>
        </div>
      )}
      {issue.fixes.length === 0 && issue.sentenceLevel && <blockquote className="issue__quote">{clip(issue.text, 160)}</blockquote>}

      <p className="issue__message">{issue.message}</p>
      {extra}

      <div className="issue__actions">
        <button type="button" className="btn btn--quiet" onClick={() => actions.dismiss(issue)}>
          <X size={14} aria-hidden /> Dismiss
        </button>
        {issue.word && (
          <button type="button" className="btn btn--quiet" onClick={() => actions.addToDictionary(issue)}>
            <BookPlus size={14} aria-hidden /> Add to dictionary
          </button>
        )}
        {!compact && (
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => actions.disableRule(issue)}
            title="Stop checking for this kind of issue"
          >
            <EyeOff size={14} aria-hidden /> Turn off
          </button>
        )}
      </div>
    </div>
  );
}

interface IssueCardProps {
  issue: Issue;
  open: boolean;
  actions: IssueActions;
  onToggle(): void;
  extra?: ReactNode;
}

/** A row in the Assistant panel: a one-line summary that opens into the detail. */
export function IssueCard({ issue, open, actions, onToggle, extra }: IssueCardProps) {
  return (
    <li className={`card card--${issue.category}${open ? ' is-open' : ''}`} data-card={issue.id}>
      {open ? (
        <>
          <button type="button" className="card__close" onClick={onToggle} aria-label="Collapse suggestion">
            <X size={14} />
          </button>
          <IssueDetail issue={issue} actions={actions} extra={extra} />
        </>
      ) : (
        <button type="button" className="card__summary" onClick={onToggle}>
          <span className={`dot dot--${issue.category}`} />
          <span className="card__text">{clip(issue.text, 40)}</span>
          <span className="card__title">{issue.title}</span>
        </button>
      )}
    </li>
  );
}
