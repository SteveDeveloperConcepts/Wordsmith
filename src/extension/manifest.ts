/** The manifest as shipped. The build stamps in the version from package.json. */
import { DEFAULT_SITE_MATCHES } from './shared/sites';

export const ICON_SIZES = [16, 32, 48, 128] as const;

export const OFFSCREEN_PAGE = 'offscreen/offscreen.html';
export const CONTENT_SCRIPT = 'content.js';

const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]));

export function buildManifest(version: string) {
  return {
    manifest_version: 3,
    name: 'Wordsmith',
    version,
    description: 'Private grammar and spelling suggestions in webmail. Your text stays on this computer.',
    // chrome.runtime.getContexts, which finds the offscreen document, arrived in 116.
    minimum_chrome_version: '116',
    icons,
    action: { default_title: 'Wordsmith', default_popup: 'popup/popup.html', default_icon: icons },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['storage', 'offscreen', 'scripting', 'activeTab'],
    host_permissions: DEFAULT_SITE_MATCHES,
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    content_scripts: [
      {
        matches: DEFAULT_SITE_MATCHES,
        js: [CONTENT_SCRIPT],
        run_at: 'document_idle',
        // No public source pins compose bodies to the top document, so frames are covered too.
        all_frames: true,
        match_about_blank: true,
        match_origin_as_fallback: true,
      },
    ],
    content_security_policy: {
      // connect-src makes "text never leaves the machine" something the browser enforces,
      // on top of there being no network code: extension pages can only reach their own files.
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self';",
    },
  };
}
