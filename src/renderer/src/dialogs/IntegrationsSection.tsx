import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { DEFAULT_ANYWHERE_SHORTCUT, type AnywhereSettings, type AnywhereStatus, type LiveStatus } from '@shared/api';
import { acceleratorFor, shortcutLabel } from '../lib/shortcuts';
import { desktop, isMac } from '../platform';
import { Group, OutLink, Setting, Switch } from './settingsParts';

const ADD_IN_GUIDE = 'https://github.com/SteveDeveloperConcepts/Wordsmith/blob/main/src/addin/INSTALL.md';
const EXTENSION_GUIDE = 'https://github.com/SteveDeveloperConcepts/Wordsmith/blob/main/src/extension/README.md';

interface RecorderProps {
  value: string;
  onChange(shortcut: string): void;
}

/** A button that listens for the next key combination. */
function ShortcutRecorder({ value, onChange }: RecorderProps) {
  const [recording, setRecording] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setRecording(false);
      return;
    }
    const accelerator = acceleratorFor(event);
    if (!accelerator) return;
    setRecording(false);
    onChange(accelerator);
  };

  return (
    <button
      ref={button}
      type="button"
      className={`btn btn--outline shortcut${recording ? ' is-recording' : ''}`}
      aria-label={recording ? 'Press the new shortcut, or Esc to cancel' : `Shortcut: ${shortcutLabel(value)}. Press to change.`}
      onClick={() => setRecording(!recording)}
      onBlur={() => setRecording(false)}
      onKeyDown={onKeyDown}
    >
      {recording ? 'Press keys…' : shortcutLabel(value)}
    </button>
  );
}

function CheckAnywhereSettings() {
  const [status, setStatus] = useState<AnywhereStatus | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let current = true;
    void desktop?.anywhereStatus().then((next) => {
      if (current) setStatus(next);
    });
    return () => {
      current = false;
    };
  }, []);

  if (!desktop) {
    return (
      <p className="settings-note">
        Check Anywhere is part of the desktop app. It checks the text you select in any program, with one shortcut.
      </p>
    );
  }
  if (!status) return null;

  const change = async (patch: Partial<AnywhereSettings>) => {
    setProblem('');
    const next = await desktop?.setAnywhere(patch);
    if (!next) return;
    setStatus(next);
    if (next.shortcutRejected || (next.enabled && !next.activeShortcut)) {
      setProblem('Another app is already using that shortcut. Try a different one.');
    }
  };

  if (!status.supported) {
    return <p className="settings-note">Check Anywhere is not available on this system.</p>;
  }

  return (
    <div className="settings-rows">
      <Switch
        label="Check text in any app"
        hint="Select text anywhere, press the shortcut, and fix it in a small window. Corrections go back where the text came from."
        checked={status.enabled}
        onChange={(enabled) => void change({ enabled })}
      />
      <Setting label="Shortcut" hint={status.enabled ? 'Works from any app' : 'Turn on Check Anywhere to use this'}>
        <div className="settings-inline">
          <ShortcutRecorder value={status.shortcut} onChange={(shortcut) => void change({ shortcut })} />
          {status.shortcut !== DEFAULT_ANYWHERE_SHORTCUT && (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => void change({ shortcut: DEFAULT_ANYWHERE_SHORTCUT })}
            >
              Reset
            </button>
          )}
        </div>
      </Setting>
      {problem && (
        <p className="settings-note settings-note--error" role="alert">
          <TriangleAlert size={15} aria-hidden /> {problem}
        </p>
      )}
      <Switch
        label="Start Wordsmith when you sign in"
        hint="Keeps the shortcut ready without opening a window"
        checked={status.launchAtLogin}
        onChange={(launchAtLogin) => void change({ launchAtLogin })}
      />
      {isMac && (
        <Setting
          label="Accessibility permission"
          hint="macOS asks for this before an app can copy and paste in other apps"
        >
          {status.canControlApps ? (
            <span className="settings-note">
              <CircleCheck size={15} aria-hidden className="settings-key__ok" /> Granted
            </span>
          ) : (
            <button type="button" className="btn btn--outline btn--small" onClick={() => void desktop?.requestAppControl()}>
              Grant access
            </button>
          )}
        </Setting>
      )}
    </div>
  );
}

/** Underlines as you type in classic Outlook and Word on Windows: an experiment, off by default. */
function LiveSettings() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  useEffect(() => {
    let current = true;
    void desktop?.liveStatus().then((next) => {
      if (current) setStatus(next);
    });
    return () => {
      current = false;
    };
  }, []);
  if (!desktop || !status?.supported) return null;
  return (
    <Group title="Outlook and Word on this PC (experimental)">
      <div className="settings-rows">
        <Switch
          label="Underline as you type"
          hint="Draws Wordsmith's underlines over the message you are writing in classic Outlook, or the page in Word. Rest the pointer on one for the fix."
          checked={status.enabled}
          onChange={(enabled) => void desktop?.setLive({ enabled }).then((next) => next && setStatus(next))}
        />
      </div>
    </Group>
  );
}

/** How Wordsmith reaches text outside its own window. */
export function IntegrationsSection() {
  return (
    <>
      <Group title="Check Anywhere">
        <CheckAnywhereSettings />
      </Group>

      <LiveSettings />

      <Group title="Word, Outlook, PowerPoint, and Excel">
        <div className="settings-prose">
          <p>The Office add-in puts Wordsmith in a panel beside your document or email draft.</p>
          <p>
            In Outlook it needs a Microsoft 365 or Outlook.com mailbox. Microsoft does not run add-ins on Gmail or Yahoo
            accounts, so use Check Anywhere for those.
          </p>
          <p>
            <OutLink href={ADD_IN_GUIDE}>How to install the add-in</OutLink>
          </p>
        </div>
      </Group>

      <Group title="Outlook on the web, Gmail, and other sites">
        <div className="settings-prose">
          <p>The browser extension underlines mistakes as you type in Chrome and Edge.</p>
          <p>
            <OutLink href={EXTENSION_GUIDE}>How to install the extension</OutLink>
          </p>
        </div>
      </Group>
    </>
  );
}
