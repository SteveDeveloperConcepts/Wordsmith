/// <reference types="chrome" />
/**
 * Content script entry point. It runs in each frame of a permitted site and starts
 * or stops the controller as the settings change.
 */
import { isSiteOn, loadSettings, onSettingsChanged } from '../shared/settings';
import { Controller } from './controller';

declare global {
  interface Window {
    wordsmithLoaded?: boolean;
  }
}

/** The tab's site, even from inside a frame, because that is what the writer turned on or off. */
function siteHostname(): string {
  const { ancestorOrigins, hostname } = location;
  const top = ancestorOrigins[ancestorOrigins.length - 1];
  // A sandboxed page's origin reads as the string "null".
  return top?.startsWith('http') ? new URL(top).hostname : hostname;
}

function main(): void {
  const site = siteHostname();
  let controller: Controller | null = null;

  const stop = () => {
    controller?.stop();
    controller = null;
  };

  const update = async () => {
    const settings = await loadSettings();
    if (!isSiteOn(settings, site)) {
      stop();
    } else if (controller) {
      controller.settingsChanged();
    } else {
      controller = new Controller(site, stop);
      controller.start();
    }
  };

  void update();
  onSettingsChanged(() => void update());
}

// A newly granted site injects this script into pages that may already have it.
if (!window.wordsmithLoaded) {
  window.wordsmithLoaded = true;
  main();
}
