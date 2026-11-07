/**
 * Keeps installed copies current from GitHub releases. A newer version downloads in
 * the background, then installs on restart, or the next time Wordsmith quits.
 *
 * Installed copies find new versions through `publish` in electron-builder.yml. macOS
 * only installs updates signed with a Developer ID, which the Release workflow insists on.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateCheck, UpdateState } from '@shared/api';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface UpdaterHost {
  /** A new version has downloaded and is ready to install. */
  changed(state: UpdateState): void;
  /** The app is about to quit for an update, and nothing may hold it open. */
  beforeInstall(): void;
}

export interface Updater {
  /** The version waiting to install, if any. */
  state(): UpdateState | null;
  /** Look now, as when the writer asks. */
  check(): Promise<UpdateCheck>;
  /** Quit and install the version that is ready. */
  install(): void;
}

/** Check GitHub shortly after starting, then every few hours. */
export function setupUpdater(host: UpdaterHost): Updater {
  // A development run has no installer behind it, and only these two systems have one that updates.
  if (!app.isPackaged || (process.platform !== 'win32' && process.platform !== 'darwin')) {
    return { state: () => null, check: async () => ({ status: 'unavailable' }), install: () => undefined };
  }

  let ready: UpdateState | null = null;
  /** The version being downloaded. A download can outlast a check, and must not be started twice. */
  let downloading: string | null = null;

  // electron-updater sends a random id kept for each install, for staged rollouts.
  // Wordsmith stages nothing, and sends nothing that tells one person from another.
  autoUpdater.requestHeaders = { 'x-user-staging-id': '' };
  // Offline, or GitHub cannot be reached: the next check tries again.
  autoUpdater.on('error', () => undefined);
  autoUpdater.on('update-downloaded', (info) => {
    ready = { version: info.version };
    host.changed(ready);
  });

  const check = async (): Promise<UpdateCheck> => {
    if (ready) return { status: 'ready', version: ready.version };
    if (downloading) return { status: 'downloading', version: downloading };
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) return { status: 'latest' };
      const { version } = result.updateInfo;
      downloading = version;
      const finished = () => {
        downloading = null;
      };
      result.downloadPromise?.then(finished, finished);
      return { status: 'downloading', version };
    } catch {
      return { status: 'failed' };
    }
  };

  setTimeout(() => void check(), FIRST_CHECK_MS);
  setInterval(() => void check(), CHECK_EVERY_MS);

  return {
    state: () => ready,
    check,
    install() {
      if (!ready) return;
      host.beforeInstall();
      // Silent, then start the new version: the installer already knows where Wordsmith lives.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
