import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { useLayoutEffect, useRef } from 'react';
import type { Issue } from '@engine/types';
import { IssueDetail } from '../assistant/IssueCard';
import type { IssueActions } from './useIssueActions';

export interface PopoverTarget {
  issue: Issue;
  /** The line box of the flagged text that the pointer is on, in viewport coordinates. */
  rect: DOMRect;
}

interface Props {
  target: PopoverTarget;
  actions: IssueActions;
  onMouseEnter(): void;
  onMouseLeave(): void;
}

/** The suggestion card that floats next to underlined text. */
export function IssuePopover({ target, actions, onMouseEnter, onMouseLeave }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    const anchor = { getBoundingClientRect: () => target.rect };
    void computePosition(anchor, element, {
      placement: 'bottom-start',
      strategy: 'fixed',
      middleware: [offset(6), flip({ padding: 12 }), shift({ padding: 12 })],
    }).then(({ x, y }) => {
      if (cancelled) return;
      element.style.left = `${Math.round(x)}px`;
      element.style.top = `${Math.round(y)}px`;
      element.style.visibility = 'visible';
    });
    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <div
      ref={ref}
      className={`popover popover--${target.issue.category}`}
      role="dialog"
      aria-label="Suggestion"
      style={{ visibility: 'hidden' }}
      // Mouse events, not pointer events: pointerenter fires before the word's mouseout,
      // so the word would re-arm the close timer after the card had cancelled it.
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Keep the editor's selection and focus when a button here is pressed.
      onMouseDown={(event) => event.preventDefault()}
      // A click inside the card is not a click on the page behind it.
      onClick={(event) => event.stopPropagation()}
    >
      <IssueDetail issue={target.issue} actions={actions} compact />
    </div>
  );
}
