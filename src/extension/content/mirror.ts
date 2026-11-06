/**
 * Textareas and inputs keep their text out of the DOM, so ranges cannot reach it
 * and nothing can be underlined in place. The mirror is a transparent copy laid
 * exactly over the field, with the underlines drawn on the copy's text.
 */
import { clipPath, intersect, isScaled, mirrorBox, type Box, type FieldMetrics } from './geometry';
import { parentAcrossShadow, type FormField } from './field';

/** Everything that affects where a line wraps or a glyph lands. */
const COPIED_PROPERTIES = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-stretch',
  'font-variant',
  'font-kerning',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-align',
  'text-indent',
  'text-transform',
  'text-rendering',
  'tab-size',
  'direction',
  'overflow-wrap',
  'word-break',
  'hyphens',
] as const;

/** The part of an element that can be seen, allowing for the window and any scrolled panes around it. */
export function visibleBox(element: HTMLElement): Box | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  let visible: Box | null = element.getBoundingClientRect();
  visible = intersect(visible, { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight });
  for (let el = parentAcrossShadow(element); el && visible; el = parentAcrossShadow(el)) {
    if (el === element.ownerDocument.documentElement || el === element.ownerDocument.body) break;
    if (view.getComputedStyle(el).overflow === 'visible') continue;
    visible = intersect(visible, el.getBoundingClientRect());
  }
  return visible;
}

export class Mirror {
  private readonly element: HTMLDivElement;
  private readonly text: Text;

  constructor(
    private readonly field: FormField,
    private readonly parent: ShadowRoot,
  ) {
    const doc = field.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'mirror';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.hidden = true;
    this.text = doc.createTextNode('');
    // Holds open the last line when the value ends in a line break, so the two scroll the same distance.
    this.element.append(this.text, doc.createTextNode('​'));
  }

  /** Changes only what changed, so live ranges over the rest of the text stay in place. */
  setValue(value: string): void {
    const old = this.text.data;
    if (old === value) return;
    let prefix = 0;
    const limit = Math.min(old.length, value.length);
    while (prefix < limit && old[prefix] === value[prefix]) prefix++;
    let suffix = 0;
    while (suffix < limit - prefix && old[old.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
    this.text.replaceData(prefix, old.length - prefix - suffix, value.slice(prefix, value.length - suffix));
  }

  range(from: number, to: number): Range {
    const range = this.field.ownerDocument.createRange();
    range.setStart(this.text, from);
    range.setEnd(this.text, to);
    return range;
  }

  layout(): void {
    const { field, element } = this;
    if (!element.isConnected) this.parent.append(element);
    const view = field.ownerDocument.defaultView;
    if (!view) return;

    const style = view.getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    const metrics: FieldMetrics = {
      rect,
      borderLeft: parseFloat(style.borderLeftWidth),
      borderRight: parseFloat(style.borderRightWidth),
      borderTop: parseFloat(style.borderTopWidth),
      borderBottom: parseFloat(style.borderBottomWidth),
      clientLeft: field.clientLeft,
      clientTop: field.clientTop,
      clientWidth: field.clientWidth,
      clientHeight: field.clientHeight,
      offsetWidth: field.offsetWidth,
      offsetHeight: field.offsetHeight,
      paddingTop: parseFloat(style.paddingTop),
      paddingBottom: parseFloat(style.paddingBottom),
      multiline: field.localName === 'textarea',
    };
    const visible = visibleBox(field);
    element.hidden = !visible || isScaled(metrics);
    if (element.hidden || !visible) return;

    for (const property of COPIED_PROPERTIES) element.style.setProperty(property, style.getPropertyValue(property));
    const box = mirrorBox(metrics);
    element.style.left = `${box.left}px`;
    element.style.top = `${box.top}px`;
    element.style.width = `${box.width}px`;
    element.style.height = `${box.height}px`;
    element.style.whiteSpace = metrics.multiline ? style.whiteSpace : 'pre';
    if (box.lineHeight !== null) element.style.lineHeight = `${box.lineHeight}px`;
    element.style.clipPath = clipPath(box, visible);
    element.scrollTop = field.scrollTop;
    element.scrollLeft = field.scrollLeft;
  }

  hide(): void {
    this.element.remove();
  }
}
