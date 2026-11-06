import { Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Issue } from '@engine/types';
import { AiError, type AiErrorInfo } from '@shared/ai-types';
import { runAi, useAiReady } from '../ai/client';
import { replaceSentence, sentenceText } from '../editor/issues';
import { MOD } from '../platform';
import { sentenceRequest } from '../state/ai';
import { useSession } from '../state/session';
import { AiErrorNotice, Progress } from './AiTab';
import '../styles/ai.css';

interface Rewrite {
  status: 'idle' | 'running' | 'done' | 'failed';
  output: string;
  error: AiErrorInfo | null;
  /** Why the rewrite could not be used. */
  note: string | null;
}

const IDLE: Rewrite = { status: 'idle', output: '', error: null, note: null };

const SENTENCE_CHANGED = 'This sentence has changed, so the rewrite was not applied. Discard it and try again.';

/** Offers an AI rewrite of the flagged sentence, for issues with no mechanical fix. */
export function IssueRewrite({ issue }: { issue: Issue }) {
  const ready = useAiReady();
  const [rewrite, setRewrite] = useState(IDLE);
  const controller = useRef<AbortController | null>(null);
  const sentence = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const offer = useRef<HTMLButtonElement>(null);

  // The result only has a place in this card, so closing the card ends the request.
  useEffect(() => () => controller.current?.abort(), []);

  // The card has grown, and what to do next may be below the edge of the panel.
  useEffect(() => {
    root.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [rewrite.status]);

  if (!ready || !issue.rewriteHint || issue.fixes.length > 0) return null;

  const start = () => {
    const { editor } = useSession.getState();
    const request = editor ? sentenceRequest(editor.state, issue) : null;
    if (!editor || !request) {
      setRewrite({ ...IDLE, status: 'failed', note: SENTENCE_CHANGED });
      return;
    }

    sentence.current = sentenceText(editor.state, issue.id);
    controller.current?.abort();
    const { signal } = (controller.current = new AbortController());
    setRewrite({ ...IDLE, status: 'running' });

    runAi(request, {
      signal,
      onText: (delta) => {
        if (!signal.aborted) setRewrite((r) => ({ ...r, output: r.output + delta }));
      },
    })
      .then((result) => {
        if (signal.aborted) return;
        const text = result.kind === 'text' ? result.text : '';
        if (!text) throw new AiError('unknown', 'The reply came back empty. Try again.');
        setRewrite({ ...IDLE, status: 'done', output: text });
      })
      .catch((err: AiError) => {
        if (!signal.aborted) setRewrite({ ...IDLE, status: 'failed', error: err.toInfo() });
      });
  };

  const discard = () => {
    controller.current?.abort();
    flushSync(() => setRewrite(IDLE));
    // The button that had the keyboard is gone, so hand it to the one that took its place.
    offer.current?.focus();
  };

  const accept = () => {
    const session = useSession.getState();
    const view = session.editor?.view;
    if (!view) return;
    // A sentence stays in its paragraph, however the reply was laid out.
    const text = rewrite.output.replace(/\s*\n\s*/g, ' ');
    const expected = sentence.current;
    if (expected === null || !replaceSentence(view, issue.id, expected, text)) {
      setRewrite((r) => ({ ...r, note: SENTENCE_CHANGED }));
      return;
    }
    session.setActiveIssue(null);
    session.notify(`Replaced. Press ${MOD}+Z to undo.`);
    view.focus();
  };

  if (rewrite.status === 'idle') {
    return (
      <button ref={offer} type="button" className="btn btn--outline btn--small ai-issue__offer" onClick={start}>
        <Sparkles size={14} aria-hidden /> Rewrite with AI
      </button>
    );
  }

  return (
    <div ref={root} className="ai-issue">
      <p className="ai-sr" role="status">
        {rewrite.status === 'running' ? 'Rewriting' : rewrite.status === 'done' ? 'Rewrite ready' : ''}
      </p>
      {rewrite.output && rewrite.status !== 'failed' && (
        <div className="ai-preview" tabIndex={0} role="group" aria-label="Rewritten sentence">
          <p className="ai-plain">{rewrite.output}</p>
        </div>
      )}
      {rewrite.error && <AiErrorNotice error={rewrite.error} onRetry={start} />}
      {rewrite.note && (
        <p className="ai-card__note" role="alert">
          {rewrite.note}
        </p>
      )}
      {rewrite.status === 'running' ? (
        <Progress label="Rewriting…" onCancel={discard} />
      ) : (
        <div className="ai-actions">
          {rewrite.status === 'done' && (
            <button type="button" className="btn btn--primary btn--small" onClick={accept}>
              Accept
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--small" onClick={discard}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
