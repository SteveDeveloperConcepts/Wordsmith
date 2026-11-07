import type { Editor } from '@tiptap/react';
import { CheckCheck, CircleCheck, Copy, FileText, Replace, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Goals } from '@engine/types';
import type { QuickCapture } from '@shared/api';
import { bulkFixable } from '../assistant/ReviewTab';
import { analysisClient } from '../editor/analysisClient';
import { EditorPane } from '../editor/EditorPane';
import { useIssueActions } from '../editor/useIssueActions';
import { plural } from '../lib/format';
import { shortcutLabel } from '../lib/shortcuts';
import { useTheme } from '../lib/useTheme';
import { copyText, desktop, MOD } from '../platform';
import { useLibrary } from '../state/library';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { openCapture, paragraphsToContent, type QuickDocument } from './source';
import '../styles/quick.css';

/** Apps where the text is almost certainly an email, so email checks apply. */
const EMAIL_APPS = new Set(['Outlook', 'Mail', 'Thunderbird', 'Mailspring']);

const goalsFor = (source: string | null): Goals => {
  const goals = useSettings.getState().defaultGoals;
  return source && EMAIL_APPS.has(source) ? { ...goals, domain: 'email' } : goals;
};

function editedParagraphs(editor: Editor): string[] {
  const paragraphs: string[] = [];
  editor.state.doc.forEach((node) => {
    paragraphs.push(
      node.textBetween(0, node.content.size, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : '')),
    );
  });
  return paragraphs;
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="quick__message">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function Header({ capture }: { capture: QuickCapture | null }) {
  const title = capture?.source ? `Checking text from ${capture.source}` : 'Checking your text';
  return (
    <header className="quick__header">
      <span className="quick__title">{title}</span>
      <button
        type="button"
        className="icon-btn quick__close"
        title="Close (Esc)"
        aria-label="Close"
        onClick={() => void desktop?.quickClose()}
      >
        <X size={16} aria-hidden />
      </button>
    </header>
  );
}

function useShortcut(): string {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.anywhereStatus().then((status) => setShortcut(status.activeShortcut));
  }, []);
  return shortcut ? shortcutLabel(shortcut) : 'the shortcut';
}

function NothingSelected({ capture }: { capture: QuickCapture }) {
  const shortcut = useShortcut();
  const app = capture.source ?? 'that app';
  return (
    <Message title={`Nothing is selected in ${app}`}>
      <p>Select some text and press {shortcut} again, or check everything in the field you were typing in.</p>
      <div className="quick__choices">
        <button type="button" className="btn btn--primary" onClick={() => void desktop?.quickCheckAll()}>
          Check the whole field
        </button>
        <button type="button" className="btn btn--outline" onClick={() => void desktop?.quickUseClipboard()}>
          Check the clipboard
        </button>
      </div>
    </Message>
  );
}

function NeedsPermission() {
  return (
    <Message title="Wordsmith needs permission to read your selection">
      <p>
        In System Settings, open Privacy &amp; Security, then Accessibility, and turn on Wordsmith. Your text is checked
        on this Mac and is not sent anywhere.
      </p>
      <div className="quick__choices">
        <button type="button" className="btn btn--primary" onClick={() => void desktop?.requestAppControl()}>
          Open System Settings
        </button>
        <button type="button" className="btn btn--outline" onClick={() => void desktop?.quickUseClipboard()}>
          Check the clipboard
        </button>
      </div>
    </Message>
  );
}

function Empty() {
  return (
    <Message title="No text to check">
      <p>Copy some text, or select it in another app, and try again.</p>
    </Message>
  );
}

const FAILURE: Record<'window-gone' | 'selection-changed' | 'paste-failed', (app: string) => string> = {
  'window-gone': (app) => `Could not get back to ${app}. Copy the corrected text and paste it yourself.`,
  'paste-failed': (app) => `${app} did not take the corrected text. Copy it and paste it yourself.`,
  'selection-changed': (app) =>
    `The selection in ${app} changed, so nothing was replaced. Select the same text again and choose Replace, or copy the corrected text.`,
};

interface CheckerProps {
  capture: QuickCapture;
  document: QuickDocument;
}

function Checker({ capture, document }: CheckerProps) {
  const doc = useLibrary((s) => s.current);
  const result = useSession((s) => s.result);
  const checking = useSession((s) => s.checking);
  const actions = useIssueActions();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [problem, setProblem] = useState('');
  const [working, setWorking] = useState(false);
  const canReplace = capture.state === 'selection';
  const app = capture.source ?? 'the app';

  const issues = result?.issues ?? [];
  const fixable = issues.filter(bulkFixable);

  const finish = useCallback(() => (editor ? document.finish(editedParagraphs(editor)) : null), [editor, document]);

  const replace = useCallback(async () => {
    const output = finish();
    if (!output || !desktop || working) return;
    setProblem('');
    setWorking(true);
    const outcome = await desktop.quickReplace(output);
    setWorking(false);
    if (!outcome.ok) setProblem(FAILURE[outcome.reason](app));
  }, [app, finish, working]);

  const copy = async () => {
    const output = finish();
    if (!output) return;
    await copyText(output.text);
    useSession.getState().notify('Copied the corrected text.');
  };

  const fixAll = () => {
    const ids = new Set(fixable.map((issue) => issue.id));
    actions.acceptAll((issue) => ids.has(issue.id));
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canReplace) {
        event.preventDefault();
        void replace();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canReplace, replace]);

  if (!doc) return null;

  return (
    <>
      <EditorPane key={doc.id} doc={doc} onEditor={setEditor} compact />
      {problem && (
        <p className="quick__problem" role="alert">
          {problem}
        </p>
      )}
      <footer className="quick__footer">
        <span className="quick__count" role="status">
          {checking ? (
            'Checking…'
          ) : issues.length === 0 ? (
            <>
              <CircleCheck size={15} aria-hidden /> No suggestions
            </>
          ) : (
            plural(issues.length, 'suggestion')
          )}
        </span>
        {fixable.length >= 2 && (
          <button type="button" className="btn btn--ghost btn--small" onClick={fixAll}>
            <CheckCheck size={15} aria-hidden /> Fix {fixable.length}
          </button>
        )}
        <span className="quick__spacer" />
        <button
          type="button"
          className="icon-btn"
          title="Open as a document in Wordsmith"
          aria-label="Open as a document in Wordsmith"
          onClick={() => {
            const output = finish();
            if (output) void desktop?.quickOpenInApp(output.text);
          }}
        >
          <FileText size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={canReplace ? 'btn btn--outline btn--small' : 'btn btn--primary btn--small'}
          onClick={() => void copy()}
        >
          <Copy size={14} aria-hidden /> Copy
        </button>
        {canReplace && (
          <button
            type="button"
            className="btn btn--primary btn--small"
            title={`Replace the selection in ${app} (${MOD}+Enter)`}
            disabled={working}
            onClick={() => void replace()}
          >
            <Replace size={14} aria-hidden /> Replace in {app}
          </button>
        )}
      </footer>
    </>
  );
}

/** The small floating window of Check Anywhere. It shows one piece of text at a time. */
export function QuickApp() {
  useTheme();
  const [capture, setCapture] = useState<QuickCapture | null>(null);
  const lastCapture = useRef(0);
  const toast = useSession((s) => s.toast);
  const dismissToast = useSession((s) => s.dismissToast);

  useEffect(() => {
    // The engine starts with the first check, not here: this window is built at every
    // launch, and the engine takes about 200 MB that many sessions would never use.
    useSession.getState().setEngine(analysisClient.status);
    const stopStatus = analysisClient.onStatus((status) => useSession.getState().setEngine(status));
    const stopCaptures = desktop?.onQuickCapture((next) => {
      if (next.id <= lastCapture.current) return;
      lastCapture.current = next.id;
      setCapture(next);
    });
    desktop?.quickReady();
    return () => {
      stopStatus();
      stopCaptures?.();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissToast, 2500);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  const document = useMemo(() => {
    if (!capture || !capture.text.trim()) return null;
    if (capture.state !== 'selection' && capture.state !== 'clipboard') return null;
    return openCapture(capture);
  }, [capture]);

  // A new capture gets a fresh editor, so that nothing carries over from the last one.
  useEffect(() => {
    if (!capture || !document) return;
    useLibrary.getState().openScratch({
      content: paragraphsToContent(document.paragraphs),
      goals: goalsFor(capture.source),
    });
  }, [capture, document]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc closes the suggestion card first, if one is open.
      if (event.key === 'Escape' && !window.document.querySelector('.popover')) void desktop?.quickClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  let body: ReactNode = null;
  if (capture?.state === 'nothing-selected') body = <NothingSelected capture={capture} />;
  else if (capture?.state === 'needs-permission') body = <NeedsPermission />;
  else if (capture && document) body = <Checker key={capture.id} capture={capture} document={document} />;
  else if (capture) body = <Empty />;

  return (
    <div className="quick">
      <Header capture={capture} />
      {body}
      {toast && (
        <div className="toast" role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
