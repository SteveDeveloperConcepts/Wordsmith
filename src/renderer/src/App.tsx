import type { Editor } from '@tiptap/react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AssistantPanel, type TabDefinition } from './assistant/AssistantPanel';
import { InsightsTab } from './assistant/InsightsTab';
import { GoalsButton, GoalsDialog } from './dialogs/GoalsDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { analysisClient } from './editor/analysisClient';
import { EditorPane } from './editor/EditorPane';
import { Toolbar } from './editor/Toolbar';
import { LibrarySidebar } from './library/LibrarySidebar';
import { formatDuration, formatNumber } from './lib/format';
import { useTheme } from './lib/useTheme';
import { useLibrary } from './state/library';
import { useSession } from './state/session';
import { useSettings } from './state/settings';

/** Below this width the sidebar floats over the workspace instead of squeezing the page. */
const SIDEBAR_OVERLAY_QUERY = '(max-width: 1120px)';

const ASSISTANT_TABS: TabDefinition[] = [{ id: 'insights', label: 'Insights', render: () => <InsightsTab /> }];

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function StatusBar() {
  const result = useSession((s) => s.result);
  const checking = useSession((s) => s.checking);
  const engine = useSession((s) => s.engine);
  const selection = useSession((s) => s.selection);
  const stats = result?.stats;

  const state = !engine.started
    ? { label: 'Starting the checker…', className: 'is-busy' }
    : checking
      ? { label: 'Checking…', className: 'is-busy' }
      : !engine.grammarEngineReady
        ? { label: 'Grammar engine unavailable', className: 'is-error' }
        : { label: 'All checked', className: '' };

  const showInsights = () => {
    useSettings.getState().update({ assistantOpen: true });
    useSession.getState().setTab('insights');
  };

  return (
    <footer className="statusbar">
      <button type="button" className="statusbar__button" title="Show insights" onClick={showInsights}>
        {selection ? (
          <span className="statusbar__item">
            <strong>{formatNumber(selection.words)}</strong> of {formatNumber(stats?.words ?? 0)} words selected ·{' '}
            <strong>{formatNumber(selection.characters)}</strong> characters
          </span>
        ) : (
          <>
            <span className="statusbar__item">
              <strong>{formatNumber(stats?.words ?? 0)}</strong> words
            </span>
            <span className="statusbar__item">
              <strong>{formatNumber(stats?.characters ?? 0)}</strong> characters
            </span>
            <span className="statusbar__item">
              <strong>{formatNumber(stats?.sentences ?? 0)}</strong> sentences
            </span>
            {stats && stats.words > 0 && (
              <span className="statusbar__item">{formatDuration(stats.readingTimeSec)} read</span>
            )}
          </>
        )}
      </button>
      <span className="statusbar__spacer" />
      <span className={`statusbar__state ${state.className}`}>{state.label}</span>
    </footer>
  );
}

function Toast() {
  const toast = useSession((s) => s.toast);
  const dismiss = useSession((s) => s.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, toast.kind === 'error' ? 7000 : 4000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  if (!toast) return null;
  return (
    <div className={`toast toast--${toast.kind}`} role="status" onClick={dismiss}>
      {toast.message}
    </div>
  );
}

export function App() {
  useTheme();
  const ready = useLibrary((s) => s.ready);
  const doc = useLibrary((s) => s.current);
  const assistantOpen = useSettings((s) => s.assistantOpen);
  const libraryOpen = useSettings((s) => s.libraryOpen);
  const update = useSettings((s) => s.update);
  const [editor, setEditor] = useState<Editor | null>(null);
  const overlay = useMediaQuery(SIDEBAR_OVERLAY_QUERY);

  useEffect(() => {
    void useLibrary.getState().init();
    analysisClient.start();
    useSession.getState().setEngine(analysisClient.status);
    return analysisClient.onStatus((status) => useSession.getState().setEngine(status));
  }, []);

  // Make sure the last edits reach disk if the window closes.
  useEffect(() => {
    const flush = () => void useLibrary.getState().flush();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // A sidebar floating over the page has done its job once a document is chosen.
  const docId = doc?.id;
  useEffect(() => {
    if (overlay && docId) useSettings.getState().update({ libraryOpen: false });
  }, [overlay, docId]);

  if (!ready || !doc) {
    return (
      <div className="loading">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="app">
      {libraryOpen && (
        <>
          {overlay && (
            <div className="scrim" aria-hidden onClick={() => update({ libraryOpen: false })} />
          )}
          <div className={overlay ? 'library-slot library-slot--overlay' : 'library-slot'}>
            <LibrarySidebar onImport={() => undefined} />
          </div>
        </>
      )}
      <main className="workspace">
        <header className="topbar">
          <div className="topbar__group">
            <button
              type="button"
              className={`icon-btn${libraryOpen ? ' is-active' : ''}`}
              title={libraryOpen ? 'Hide documents' : 'Show documents'}
              aria-label="Toggle the documents sidebar"
              aria-pressed={libraryOpen}
              onClick={() => update({ libraryOpen: !libraryOpen })}
            >
              <PanelLeft size={18} />
            </button>
          </div>
          <div className="topbar__group topbar__group--grow">{editor && <Toolbar editor={editor} />}</div>
          <div className="topbar__group">
            <button
              type="button"
              className={`icon-btn${assistantOpen ? ' is-active' : ''}`}
              title={assistantOpen ? 'Hide the assistant' : 'Show the assistant'}
              aria-label="Toggle the assistant panel"
              aria-pressed={assistantOpen}
              onClick={() => update({ assistantOpen: !assistantOpen })}
            >
              <PanelRight size={18} />
            </button>
          </div>
        </header>
        <EditorPane key={doc.id} doc={doc} onEditor={setEditor} />
        <StatusBar />
      </main>
      {assistantOpen && <AssistantPanel extraTabs={ASSISTANT_TABS} headerAction={<GoalsButton />} />}
      <GoalsDialog />
      <SettingsDialog />
      <Toast />
    </div>
  );
}
