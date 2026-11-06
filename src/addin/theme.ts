/// <reference types="office-js" />
/** Keeps the pane in step with Office's theme, or the system's where Office has none to give. */

function officeBackground(): string | null {
  if (typeof Office === 'undefined') return null;
  try {
    return Office.context?.officeTheme?.bodyBackgroundColor ?? null;
  } catch {
    return null;
  }
}

/** Compares the background rather than asking for isDarkTheme, which Outlook does not support. */
function isDark(color: string): boolean | null {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(color);
  if (!match) return null;
  const [red, green, blue] = match.slice(1).map((channel) => parseInt(channel, 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 128;
}

const systemTheme = () => window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(): void {
  const background = officeBackground();
  const dark = (background ? isDark(background) : null) ?? systemTheme().matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function followTheme(): void {
  applyTheme();
  systemTheme().addEventListener('change', applyTheme);
  // Only Outlook has a theme event, and changing the theme anywhere else means leaving the pane.
  window.addEventListener('focus', applyTheme);
  if (typeof Office !== 'undefined') Office.context?.mailbox?.addHandlerAsync?.(Office.EventType.OfficeThemeChanged, applyTheme);
}
