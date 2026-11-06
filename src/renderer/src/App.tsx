import type { Editor } from '@tiptap/react';
import { PanelLeft, PanelRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AiTab } from './assistant/AiTab';
import { AssistantPanel, type TabDefinition } from './assistant/AssistantPanel';
import { InsightsTab } from './assistant/InsightsTab';
import { IssueRewrite } from './assistant/IssueRewrite';
import { importFiles, listenForCommands, runCommand } from './commands';
import { GoalsButton, GoalsDialog } from './dialogs/GoalsDialog';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { analysisClient } from './editor/analysisClient';
import { EditorPane } from './editor/EditorPane';
import { Toolbar } from './editor/Toolbar';
import { LibrarySidebar } from './library/LibrarySidebar';
import { formatDuration, formatNumber } from './lib/format';
import { useTheme } from './lib/useTheme';
import { readFiles } from './platform';
import { useLibrary } from './state/library';
import { useSession } from './state/session';
import { useSettings } from './state/settings';
import { TopbarActions } from './TopbarActions';

/** Below this width the sidebar floats over the workspace instead of squeezing the page. */
const SIDEBAR_OVERLAY_QUERY = '(max-width: 1120px)';

const ASSISTANT_TABS: TabDefinition[] = [
  { id: 'insights', label: 'Insights', render: () => <InsightsTab /> },
  { id: 'ai', label: 'AI', render: () => <AiTab /> },
];

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

/** Dropped files become documents. Without this, a drop would navigate the window away. */
function useFileDrop(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // Enter and leave fire for every element crossed, so only the balance says when it has really left.
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      void readFiles(files).then(importFiles);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    // Capturing, so the drop never reaches the editor, which would paste a file name.
    window.addEventListener('drop', onDrop, true);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop, true);
    };
  }, []);
  return dragging;
}

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
  const dragging = useFileDrop();

  useEffect(() => {
    void useLibrary.getState().init();
    analysisClient.start();
    useSession.getState().setEngine(analysisClient.status);
    return analysisClient.onStatus((status) => useSession.getState().setEngine(status));
  }, []);

  // Files and menu actions can only be acted on once the library has loaded.
  useEffect(() => {
    if (ready) return listenForCommands();
  }, [ready]);

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

  // A sidebar floating over the page has done its job once a document is chosen. This
  // follows the document only: printing briefly narrows the page, which is no reason to close it.
  const docId = doc?.id;
  const overlaid = useRef(overlay);
  overlaid.current = overlay;
  useEffect(() => {
    if (overlaid.current && docId) useSettings.getState().update({ libraryOpen: false });
  }, [docId]);

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
            <LibrarySidebar onImport={() => runCommand('import')} />
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
            <TopbarActions />
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
      {assistantOpen && (
        <AssistantPanel
          extraTabs={ASSISTANT_TABS}
          headerAction={<GoalsButton />}
          renderIssueExtra={(issue) => <IssueRewrite issue={issue} />}
        />
      )}
      <GoalsDialog />
      <SettingsDialog />
      <Toast />
      {dragging && <div className="drop-hint">Drop files to open them as documents</div>}
    </div>
  );
}
