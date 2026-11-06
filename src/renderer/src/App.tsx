import type { Editor } from '@tiptap/react';
import { PanelRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AssistantPanel } from './assistant/AssistantPanel';
import { analysisClient } from './editor/analysisClient';
import { EditorPane } from './editor/EditorPane';
import { Toolbar } from './editor/Toolbar';
import { formatDuration, formatNumber } from './lib/format';
import { desktop } from './platform';
import { useLibrary } from './state/library';
import { useSession } from './state/session';
import { resolveTheme, useSettings } from './state/settings';

/** Applies the chosen theme to the document, following the system setting when asked to. */
function useTheme(): void {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    void desktop?.setTheme(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
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

  return (
    <footer className="statusbar">
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
  const update = useSettings((s) => s.update);
  const [editor, setEditor] = useState<Editor | null>(null);

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

  if (!ready || !doc) {
    return (
      <div className="loading">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="app">
      <main className="workspace">
        <header className="topbar">
          <div className="topbar__group">{editor && <Toolbar editor={editor} />}</div>
          <span className="topbar__spacer" />
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
      {assistantOpen && <AssistantPanel />}
      <Toast />
    </div>
  );
}
