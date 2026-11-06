/**
 * Everything the extension draws besides underlines lives in one shadow root under
 * <html>: outside the editor, so the page's editor never sees it, and sealed off
 * from the page's styles.
 */
import { parentAcrossShadow } from './field';
import { HIGHLIGHT_CSS, OVERLAY_CSS } from './styles';

const sheetOf = (css: string) => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
};

export class Overlay {
  readonly root: ShadowRoot;
  private readonly host: HTMLElement;
  private readonly highlightSheet = sheetOf(HIGHLIGHT_CSS);
  private readonly styledRoots = new Set<Document | ShadowRoot>();

  constructor(private readonly doc: Document) {
    this.host = doc.createElement('wordsmith-overlay');
    Object.assign(this.host.style, { all: 'initial', position: 'fixed', zIndex: '2147483647', pointerEvents: 'none' });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.adoptedStyleSheets = [sheetOf(OVERLAY_CSS), this.highlightSheet];
  }

  /** Some pages rebuild the document's children, so this runs each time a field becomes active. */
  attach(): void {
    if (!this.host.isConnected) this.doc.documentElement.append(this.host);
  }

  /** ::highlight rules only reach text in their own tree, so a field in a shadow root needs them there too. */
  styleTree(root: Node): void {
    const tree = root as Document | ShadowRoot;
    if (!tree.adoptedStyleSheets.includes(this.highlightSheet)) {
      tree.adoptedStyleSheets = [...tree.adoptedStyleSheets, this.highlightSheet];
    }
    this.styledRoots.add(tree);
  }

  setTheme(dark: boolean): void {
    this.host.dataset.theme = dark ? 'dark' : 'light';
  }

  remove(): void {
    for (const tree of this.styledRoots) {
      tree.adoptedStyleSheets = tree.adoptedStyleSheets.filter((sheet) => sheet !== this.highlightSheet);
    }
    this.styledRoots.clear();
    this.host.remove();
  }
}

/**
 * A press on the extension's own controls must not take focus or the selection from
 * the editor, and the page should not take it for a click outside the compose window.
 */
export function shieldFromPage(element: HTMLElement): void {
  element.addEventListener('mousedown', (event) => event.preventDefault());
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    element.addEventListener(type, (event) => event.stopPropagation());
  }
}

/** Whether a field sits on a dark background. A canvas reads every color syntax a page can use, such as oklch(). */
export function isOnDarkBackground(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  const canvas = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  if (!view || !canvas) return false;
  for (let el: Element | null = element; el; el = parentAcrossShadow(el)) {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = view.getComputedStyle(el).backgroundColor;
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = canvas.getImageData(0, 0, 1, 1).data;
    if (alpha >= 128) return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return false;
}
