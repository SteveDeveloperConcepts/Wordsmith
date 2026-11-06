/** The suggestion card that opens over an underline. */
import type { Fix } from '@engine/types';
import type { PlacedIssue } from './field';
import { placeCard, pointInRects, type Box } from './geometry';
import { shieldFromPage } from './overlay';
import { UNDERLINE_COLORS } from './styles';

export interface CardActions {
  /** Resolves to a note to show the writer, or null if the card can close. */
  applyFix(placed: PlacedIssue, fix: Fix): Promise<string | null>;
  dismiss(placed: PlacedIssue): void;
  addToDictionary(placed: PlacedIssue, word: string): Promise<string | null>;
}

const MAX_FIXES = 4;

function button(doc: Document, className: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = doc.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

export class Card {
  current: PlacedIssue | null = null;
  private readonly element: HTMLDivElement;

  constructor(
    private readonly doc: Document,
    private readonly parent: ShadowRoot,
    private readonly actions: CardActions,
  ) {
    this.element = doc.createElement('div');
    this.element.className = 'card';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Suggestion');
    shieldFromPage(this.element);
  }

  containsPoint(x: number, y: number): boolean {
    return this.current !== null && pointInRects([this.element.getBoundingClientRect()], x, y, 0) !== null;
  }

  show(placed: PlacedIssue, anchor: Box): void {
    this.current = placed;
    this.render(placed);
    this.parent.append(this.element);
    const view = this.doc.defaultView;
    if (!view) return;
    const { width, height } = this.element.getBoundingClientRect();
    const { left, top } = placeCard(anchor, { width, height }, { width: view.innerWidth, height: view.innerHeight });
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  hide(): void {
    this.current = null;
    this.element.remove();
  }

  private render(placed: PlacedIssue): void {
    const { doc } = this;
    const { issue } = placed;
    this.element.style.setProperty('--c', UNDERLINE_COLORS[issue.category]);

    const title = doc.createElement('div');
    title.className = 'card-title';
    const dot = doc.createElement('span');
    dot.className = 'card-dot';
    const label = doc.createElement('span');
    label.textContent = issue.title;
    title.append(dot, label);

    const message = doc.createElement('p');
    message.className = 'card-message';
    message.textContent = issue.message;

    const note = doc.createElement('p');
    note.className = 'card-note';
    note.hidden = true;
    const finish = (text: string | null) => {
      if (text === null) {
        this.hide();
      } else {
        note.textContent = text;
        note.hidden = false;
      }
    };

    const fixes = doc.createElement('div');
    fixes.className = 'card-fixes';
    fixes.hidden = issue.fixes.length === 0;
    for (const fix of issue.fixes.slice(0, MAX_FIXES)) {
      fixes.append(
        button(doc, 'card-fix', fix.label, () => {
          void this.actions.applyFix(placed, fix).then(finish);
        }),
      );
    }

    const links = doc.createElement('div');
    links.className = 'card-actions';
    links.append(
      button(doc, 'card-action', 'Dismiss', () => {
        this.actions.dismiss(placed);
        this.hide();
      }),
    );
    const { word } = issue;
    if (issue.type === 'spelling' && word) {
      links.append(
        button(doc, 'card-action', 'Add to dictionary', () => {
          void this.actions.addToDictionary(placed, word).then(finish);
        }),
      );
    }

    this.element.replaceChildren(title, message, fixes, links, note);
  }
}
