import { useEffect, useState } from 'react';
import type { UpdateState } from '@shared/api';
import { runCommand } from './commands';
import { desktop } from './platform';

/** On a Mac, a copy that cannot replace itself is told so, and offered the fix. */
function MoveBanner() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    void desktop?.mustMoveToUpdate().then(setStuck);
  }, []);

  if (!stuck) return null;
  return (
    <div className="move-banner" role="status">
      <div className="update-banner__text">
        <strong>Move Wordsmith to Applications to keep it up to date</strong>
        <span>It is running from a place it cannot update itself in, such as the disk image.</span>
      </div>
      <button type="button" className="btn btn--ghost btn--small" onClick={() => setStuck(false)}>
        Not now
      </button>
      <button type="button" className="btn btn--primary btn--small" onClick={() => void desktop?.moveToApplications()}>
        Move to Applications
      </button>
    </div>
  );
}

/** A new version has downloaded. It installs on restart, or the next time Wordsmith quits. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [later, setLater] = useState<string | null>(null);

  // The update may have arrived before this window loaded, so ask as well as listen.
  useEffect(() => {
    void desktop?.updateState().then((state) => setUpdate((current) => current ?? state));
    return desktop?.onUpdate(setUpdate);
  }, []);

  if (!update || update.version === later) return <MoveBanner />;

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__text">
        <strong>Wordsmith {update.version} is ready to install</strong>
        <span>It installs the next time you quit Wordsmith. Restart now to start using it.</span>
      </div>
      <button type="button" className="btn btn--ghost btn--small" onClick={() => setLater(update.version)}>
        Later
      </button>
      <button type="button" className="btn btn--primary btn--small" onClick={() => runCommand('install-update')}>
        Restart now
      </button>
    </div>
  );
}
