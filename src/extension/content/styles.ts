/** Stylesheets for the underlines and for everything inside the overlay. */
import type { Category } from '@engine/types';

/**
 * The extension cannot know a page's theme, so these sit in the middle of the
 * brightness range: at least 3:1 against white and against the dark grey of dark
 * mail themes. The app's category colors are the starting point, lightened a little.
 */
export const UNDERLINE_COLORS: Record<Category, string> = {
  correctness: '#e04a50',
  clarity: '#2f7df0',
  engagement: '#1a9a5e',
  delivery: '#9366f0',
};

/** The line style differs too, so categories can be told apart without color. */
const UNDERLINE_STYLES: Record<Category, string> = {
  correctness: 'wavy',
  clarity: 'solid',
  engagement: 'dotted',
  delivery: 'dashed',
};

export const highlightName = (category: Category): string => `wordsmith-${category}`;

/**
 * A whole flagged sentence gets a lighter line of its own, as in the app, so that a
 * long sentence does not read as a heavy block and word-level marks inside it stand out.
 */
export const SENTENCE_HIGHLIGHT = 'wordsmith-sentence';

const categories = Object.keys(UNDERLINE_COLORS) as Category[];

/** Unbroken under g, y, and p, so a word reads as one mark, the way the browser's own squiggle does. */
const underline = (name: string, style: string, color: string, thickness: string, offset: string) =>
  `::highlight(${name}) {
  text-decoration: underline ${style} ${color} ${thickness};
  text-decoration-skip-ink: none;
  text-underline-offset: ${offset};
}`;

export const HIGHLIGHT_CSS = [
  ...categories.map((category) =>
    underline(highlightName(category), UNDERLINE_STYLES[category], UNDERLINE_COLORS[category], '1.5px', '2px'),
  ),
  underline(SENTENCE_HIGHLIGHT, 'dotted', UNDERLINE_COLORS.clarity, '1px', '3px'),
].join('\n');

export const OVERLAY_CSS = `
:host {
  --surface: #ffffff;
  --surface-2: #faf9f6;
  --border: #e6e3dc;
  --text: #1b1d21;
  --text-2: #555a63;
  --shadow: 0 12px 32px rgba(27, 29, 33, 0.14), 0 2px 8px rgba(27, 29, 33, 0.08);
  --mark: #14533a;
}
:host([data-theme='dark']) {
  --surface: #1a1d21;
  --surface-2: #282d34;
  --border: #3a4049;
  --text: #e9ebee;
  --text-2: #a7adb7;
  --shadow: 0 14px 36px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button {
  font: inherit;
  color: inherit;
  border: none;
  background: none;
  cursor: pointer;
}

.mirror {
  position: fixed;
  margin: 0;
  border: 0;
  overflow: hidden;
  color: transparent;
  background: transparent;
  pointer-events: none;
  user-select: none;
}

/* Set here and not on :host, because the host's inline "all: initial" wins over :host rules. */
.card,
.menu,
.badge {
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  color: var(--text);
}
.card,
.menu {
  position: fixed;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  pointer-events: auto;
}
.card {
  width: 300px;
  padding: 12px 14px;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.card-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c);
}
.card-message {
  margin: 6px 0 0;
  color: var(--text-2);
}
.card-fixes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.card-fix {
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 6px;
  background: var(--c);
  color: #ffffff;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.card-fix:hover { filter: brightness(1.08); }
.card-actions {
  display: flex;
  gap: 4px;
  margin: 8px 0 0 -8px;
}
.card-action {
  padding: 3px 8px;
  border-radius: 6px;
  color: var(--text-2);
}
.card-action:hover { background: var(--surface-2); color: var(--text); }
.card-note {
  margin: 8px 0 0;
  color: var(--text-2);
}

.badge {
  position: fixed;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  min-width: 22px;
  padding: 0 7px;
  border-radius: 11px;
  background: var(--mark);
  color: #ffffff;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  pointer-events: auto;
}
.menu {
  width: 220px;
  padding: 10px 12px;
}
.menu-count { font-weight: 600; }
.menu-note {
  margin: 4px 0 0;
  color: var(--text-2);
}
.menu-off {
  display: block;
  width: calc(100% + 8px);
  margin: 6px -4px 0;
  padding: 4px;
  border-radius: 6px;
  text-align: left;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
.menu-off:hover { background: var(--surface-2); color: var(--text); }
`;
