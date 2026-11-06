/// <reference types="office-js" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useSettings } from '@renderer/state/settings';
import { App } from './App';
import { createHost } from './hosts';
import { NoOffice } from './NoOffice';
import { applyTheme, followTheme } from './theme';
import './pane.css';

/** Outside Office the library answers at once. Inside, it can take a while on a slow machine. */
const READY_TIMEOUT_MS = 15_000;

async function waitForOffice(): Promise<Office.HostType | null> {
  if (typeof Office === 'undefined') return null;
  const ready = Office.onReady().then((info) => info.host ?? null);
  const late = new Promise<null>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS, null));
  return Promise.race([ready, late]);
}

/** Microsoft asks add-ins to keep private data under this key where the browser partitions storage. */
async function usePartitionedStorage(): Promise<void> {
  const partition = Office.context.partitionKey;
  if (!partition) return;
  useSettings.persist.setOptions({ name: `${partition}wordsmith.settings` });
  await useSettings.persist.rehydrate();
}

async function start(): Promise<void> {
  const root = createRoot(document.getElementById('root') as HTMLElement);
  applyTheme();
  root.render(<p className="pane__starting">Starting Wordsmith.</p>);
  const type = await waitForOffice();
  followTheme();

  const host = type ? createHost(type) : null;
  if (!host) {
    root.render(<NoOffice />);
    return;
  }
  await usePartitionedStorage();
  root.render(
    <StrictMode>
      <App host={host} />
    </StrictMode>,
  );
}

void start();
