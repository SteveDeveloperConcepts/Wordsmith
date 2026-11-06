/** The small mark in the corner of the active field: the suggestion count, and the way to turn a site off. */
import { placeBadge, placeCard, type Box } from './geometry';
import { shieldFromPage } from './overlay';

export class Badge {
  private readonly element: HTMLButtonElement;
  private readonly menu: HTMLDivElement;
  private readonly menuCount: HTMLDivElement;
  private readonly menuNote: HTMLParagraphElement;

  constructor(
    private readonly doc: Document,
    private readonly parent: ShadowRoot,
    site: string,
    turnOff: () => void,
  ) {
    this.element = doc.createElement('button');
    this.element.type = 'button';
    this.element.className = 'badge';
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', () => this.toggleMenu());

    this.menu = doc.createElement('div');
    this.menu.className = 'menu';
    this.menu.hidden = true;
    this.menuCount = doc.createElement('div');
    this.menuCount.className = 'menu-count';
    this.menuNote = doc.createElement('p');
    this.menuNote.className = 'menu-note';
    const off = doc.createElement('button');
    off.type = 'button';
    off.className = 'menu-off';
    off.textContent = `Turn off on ${site}`;
    off.addEventListener('click', turnOff);
    this.menu.append(this.menuCount, this.menuNote, off);

    shieldFromPage(this.element);
    shieldFromPage(this.menu);
  }

  update(count: number, notice: string | null): void {
    const summary = count === 1 ? '1 suggestion' : count === 0 ? 'No suggestions' : `${count} suggestions`;
    this.element.textContent = count > 0 ? `W ${count}` : 'W';
    this.element.setAttribute('aria-label', `Wordsmith: ${summary.toLowerCase()}`);
    this.menuCount.textContent = summary;
    this.menuNote.textContent = notice;
    this.menuNote.hidden = notice === null;
  }

  /** Put the badge on the visible part of the field, or take it away if there is none. */
  place(visible: Box | null, multiline: boolean): void {
    if (!visible) {
      this.hide();
      return;
    }
    if (!this.element.isConnected) this.parent.append(this.element, this.menu);
    const { width, height } = this.element.getBoundingClientRect();
    const { left, top } = placeBadge(visible, { width, height }, multiline);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
    this.placeMenu();
  }

  hide(): void {
    this.closeMenu();
    this.element.remove();
    this.menu.remove();
  }

  closeMenu(): void {
    this.setMenuOpen(false);
  }

  private toggleMenu(): void {
    this.setMenuOpen(Boolean(this.menu.hidden));
    this.placeMenu();
  }

  private setMenuOpen(open: boolean): void {
    this.menu.hidden = !open;
    this.element.setAttribute('aria-expanded', String(open));
  }

  private placeMenu(): void {
    const view = this.doc.defaultView;
    if (this.menu.hidden || !view) return;
    const { width, height } = this.menu.getBoundingClientRect();
    const anchor = this.element.getBoundingClientRect();
    const { left, top } = placeCard(anchor, { width, height }, { width: view.innerWidth, height: view.innerHeight });
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
  }
}
