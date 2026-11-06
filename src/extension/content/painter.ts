/** Draws underlines through the CSS Custom Highlight API, which leaves the page's DOM alone. */
import { CATEGORIES } from '@engine/types';
import type { PlacedIssue } from './field';
import { highlightName, SENTENCE_HIGHLIGHT } from './styles';

/** Most serious first. Where marks cover the same text, the earlier one shows on top. */
const NAMES = [...CATEGORIES.map(highlightName), SENTENCE_HIGHLIGHT];

export class Painter {
  private readonly highlights = new Map<string, Highlight>();

  constructor() {
    NAMES.forEach((name, index) => {
      const highlight = new Highlight();
      highlight.priority = NAMES.length - index;
      this.highlights.set(name, highlight);
      CSS.highlights.set(name, highlight);
    });
    // Tells assistive technology what the underline means.
    const correctness = this.highlights.get(highlightName('correctness'));
    if (correctness) correctness.type = 'grammar-error';
  }

  paint(placed: PlacedIssue[]): void {
    for (const highlight of this.highlights.values()) highlight.clear();
    for (const { issue, range } of placed) {
      this.highlights.get(issue.sentenceLevel ? SENTENCE_HIGHLIGHT : highlightName(issue.category))?.add(range);
    }
  }

  remove(): void {
    for (const name of NAMES) CSS.highlights.delete(name);
    this.highlights.clear();
  }
}
