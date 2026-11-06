/** Which sites the extension runs on, and how a page's address maps to a site. */

/** Webmail the extension checks from install. Every other site is granted by the user, one at a time. */
export const DEFAULT_SITE_MATCHES = [
  'https://outlook.office.com/*',
  'https://outlook.office365.com/*',
  'https://outlook.live.com/*',
  'https://outlook.cloud.microsoft/*',
  'https://mail.google.com/*',
];

const WEBMAIL_HOSTS = new Set(DEFAULT_SITE_MATCHES.map((match) => new URL(match.slice(0, -1)).hostname));

export const isWebmailHost = (hostname: string): boolean => WEBMAIL_HOSTS.has(hostname);

const WORD_HOST = /^word\.cloud\.microsoft$|\.officeapps\.live\.com$|\.online\.office\.com$/;

/** The match pattern that grants one site, or null for pages that cannot be granted. */
export function sitePattern(url: URL): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * Editors that draw their own text, so nothing in the page can carry an underline.
 * The popup says so plainly rather than offering a switch that would do nothing.
 */
export function unsupportedSurface(url: URL): string | null {
  if (url.hostname === 'docs.google.com' && url.pathname.startsWith('/document/')) {
    return 'Google Docs draws its text on a canvas, so underlines cannot appear here.';
  }
  if (WORD_HOST.test(url.hostname)) {
    return 'Word for the web uses its own editing surface, so underlines cannot appear here.';
  }
  return null;
}
