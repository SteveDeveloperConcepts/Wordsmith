import { CircleCheck, RefreshCw, Settings as SettingsIcon, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisResult, Fix, Issue } from '@engine/types';
import { IssueCard } from '@renderer/assistant/IssueCard';
import { ScoreRing, scoreLabel } from '@renderer/assistant/ScoreRing';
import { analysisClient } from '@renderer/editor/analysisClient';
import type { IssueActions } from '@renderer/editor/useIssueActions';
import { engineSettings, useSettings } from '@renderer/state/settings';
import { Stop, type Host, type Outcome, type Snapshot } from './hosts/types';
import { PaneSettings } from './PaneSettings';

const SLOWEST_POLL_MS = 15_000;

/** A big document can take a while to read. Looking less often keeps Office responsive. */
function nextPoll(pollMs: number, elapsedMs: number): number {
  return Math.min(SLOWEST_POLL_MS, Math.max(pollMs, elapsedMs * 20));
}

function countLabel(total: number): string {
  if (total === 0) return 'No suggestions';
  return total === 1 ? '1 suggestion' : `${total} suggestions`;
}

/** For a draft that can't be rewritten, the card has to say what to change by hand. */
function handFix(issue: Issue): string {
  const fixes = issue.fixes.map((fix) => fix.label).join(', or ');
  return issue.fixes.every((fix) => fix.label === 'Remove') ? `Remove “${issue.text}”` : `Change “${issue.text}” to ${fixes}`;
}

export function App({ host }: { host: Host }) {
  const [view, setView] = useState<'suggestions' | 'settings'>('suggestions');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState('');
  const [checking, setChecking] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [closedNotices, setClosedNotices] = useState<ReadonlySet<string>>(new Set());
  const [engine, setEngine] = useState(analysisClient.status);

  const dismissed = useRef(new Set<string>());
  const lastPrint = useRef<string | null>(null);
  const hasChecked = useRef(false);
  const changing = useRef(false);
  const configured = useRef('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** Reads and writes take turns: Office has no transactions, and a write must not land mid-read. */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(task, task);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  const check = useCallback(
    () =>
      enqueue(async () => {
        setChecking(true);
        try {
          // Taken before the read, so a change made during the read still shows up as a change.
          if (host.live) lastPrint.current = await host.fingerprint();
          const next = await host.read();
          const settings = useSettings.getState();
          const engineConfig = engineSettings(settings, host.goals(settings.defaultGoals));
          // Configuring clears the engine's per-paragraph cache, which is what keeps a re-check cheap.
          if (JSON.stringify(engineConfig) !== configured.current) {
            configured.current = JSON.stringify(engineConfig);
            analysisClient.configure(engineConfig);
          }
          const analysis = await analysisClient.analyze({
            blocks: next.blocks,
            dismissed: [...dismissed.current],
            caretBlock: next.caretBlock,
          });
          setSnapshot(next);
          if (analysis) setResult(analysis);
          else lastPrint.current = null;
          setProblem('');
          hasChecked.current = true;
        } catch (err) {
          // The text was never checked, so the next look has to try again even if nothing changed.
          lastPrint.current = null;
          setProblem(err instanceof Stop ? err.message : `Could not read from ${host.name}. Wordsmith will keep trying.`);
        } finally {
          setChecking(false);
          setCanUndo(host.canUndo?.() ?? false);
        }
      }),
    [enqueue, host],
  );

  const report = useCallback(
    async (outcome: Outcome) => {
      if (outcome.ok) return;
      setMessage(outcome.message);
      if (outcome.kind === 'stale') await check();
    },
    [check],
  );

  /**
   * Runs a change to the document and the re-check after it as one step. Until that
   * re-check lands the old card is still on screen, and a second click on it would
   * reach the host with offsets the first click just moved.
   */
  const change = useCallback(
    (task: () => Promise<Outcome>, done: string, after?: () => void) => {
      if (changing.current) return;
      changing.current = true;
      setMessage('');
      void enqueue(task)
        .then(async (outcome) => {
          await report(outcome);
          if (!outcome.ok) return;
          after?.();
          setMessage(done);
          await check();
        })
        .finally(() => {
          changing.current = false;
        });
    },
    [check, enqueue, report],
  );

  const actions = useMemo<IssueActions>(
    () => ({
      accept(issue: Issue, fix: Fix) {
        change(() => host.apply(issue, fix), 'Fix applied.', () => setOpenId(null));
      },
      dismiss(issue: Issue) {
        dismissed.current.add(issue.id);
        setOpenId(null);
        setResult((current) =>
          current && { ...current, issues: current.issues.filter((other) => other.id !== issue.id) },
        );
        void host.saveDismissed([...dismissed.current]).catch(() => undefined);
        // Picks up the score. A selection may have moved on, and this was not a request to check it.
        if (host.live) void check();
      },
      addToDictionary(issue: Issue) {
        if (!issue.word) return;
        useSettings.getState().addWord(issue.word);
        setMessage(`Added “${issue.word}” to your dictionary.`);
      },
      disableRule(issue: Issue) {
        useSettings.getState().disableRule(issue.ruleId);
        setMessage('That check is now off. You can turn it back on in Settings.');
      },
      // The card never calls these two. The editor's actions need them, and the type is shared.
      select() {},
      acceptAll: () => 0,
    }),
    [change, check, host],
  );

  const toggle = (issue: Issue) => {
    // The list is about to change under the pointer, so this click was probably not meant for this card.
    if (changing.current) return;
    const opening = openId !== issue.id;
    setOpenId(opening ? issue.id : null);
    if (!opening || !host.canSelect) return;
    void enqueue(() => host.select(issue)).then((outcome) => {
      if (outcome.ok) return;
      // A host words its failures for fixes, and selecting was never going to change anything.
      void report({ ok: false, kind: 'stale', message: `Could not find this text in ${host.name}. Checking again.` });
    });
  };

  const undo = () => {
    if (host.undo) change(host.undo.bind(host), 'Fix undone.');
  };

  useEffect(() => analysisClient.onStatus(setEngine), []);

  // Runs once per host: loads what was dismissed, then takes the first look.
  useEffect(() => {
    let cancelled = false;
    analysisClient.start();
    void host.loadDismissed().then((ids) => {
      if (cancelled) return;
      dismissed.current = new Set(ids);
      if (host.live) void check();
    });
    return () => {
      cancelled = true;
    };
  }, [check, host]);

  useEffect(
    () =>
      host.onItemChange?.(() => {
        setOpenId(null);
        setMessage('');
        setResult(null);
        void host.loadDismissed().then((ids) => {
          dismissed.current = new Set(ids);
          void check();
        });
      }),
    [check, host],
  );

  useEffect(() => {
    if (!host.live) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      const started = performance.now();
      await enqueue(async () => {
        try {
          const print = await host.fingerprint();
          setProblem('');
          if (print !== lastPrint.current) void check();
        } catch {
          setProblem(`Could not read from ${host.name}. Wordsmith will keep trying.`);
        }
      });
      // A hidden pane has no one to show results to, and each look costs Office some time.
      const wait = document.hidden ? SLOWEST_POLL_MS : nextPoll(host.pollMs, performance.now() - started);
      if (!stopped) timer = setTimeout(tick, wait);
    };
    timer = setTimeout(tick, host.pollMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [check, enqueue, host]);

  // Settings change what the engine reports, so the current text needs a fresh look.
  const settingsKey = useSettings((s) =>
    JSON.stringify([s.dialect, s.checks, s.options, s.disabledRules, s.dictionary, s.defaultGoals]),
  );
  const appliedKey = useRef(settingsKey);
  useEffect(() => {
    if (appliedKey.current === settingsKey) return;
    appliedKey.current = settingsKey;
    if (hasChecked.current) void check();
  }, [check, settingsKey]);

  const issues = result?.issues ?? [];
  const readOnly = snapshot?.readOnly ?? false;
  const notices = (snapshot?.notices ?? []).filter((notice) => !closedNotices.has(notice.id));
  const engineFailed = engine.started && !engine.grammarEngineReady;
  const waiting = !result && !snapshot?.empty && !problem && !engineFailed && (checking || host.live);

  return (
    <div className="pane">
      <header className="pane__header">
        <ScoreRing score={result?.score ?? null} size={46} />
        <div className="pane__summary">
          <div className="pane__status">{result ? scoreLabel(result.score) : 'Nothing checked yet'}</div>
          <div className="pane__count">{result ? countLabel(issues.length) : ' '}</div>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="Settings"
          aria-pressed={view === 'settings'}
          title="Settings"
          onClick={() => setView(view === 'settings' ? 'suggestions' : 'settings')}
        >
          <SettingsIcon size={17} aria-hidden />
        </button>
      </header>

      {view === 'settings' ? (
        <PaneSettings onClose={() => setView('suggestions')} />
      ) : (
        <>
          <div className="pane__actions">
            <button
              type="button"
              className={`btn ${host.live ? 'btn--outline' : 'btn--primary'} btn--small`}
              disabled={checking}
              onClick={() => {
                setMessage('');
                void check();
              }}
            >
              <RefreshCw size={14} aria-hidden /> {host.live ? 'Recheck' : 'Check selection'}
            </button>
            {host.undo && (
              <button type="button" className="btn btn--outline btn--small" disabled={!canUndo} onClick={undo}>
                <Undo2 size={14} aria-hidden /> Undo
              </button>
            )}
          </div>

          <div className="pane__status-line" role="status" aria-live="polite">
            {message}
          </div>
          {problem && (
            <div className="pane-note pane-note--warn" role="alert">
              {problem}
            </div>
          )}
          {engineFailed && (
            <div className="pane-note pane-note--warn">
              {result
                ? 'The grammar engine did not load, so only the built-in checks are running.'
                : 'The checker could not start, so nothing has been checked.'}
            </div>
          )}

          <main className="pane__body">
            {notices.map((notice) => (
              <div key={notice.id} className={`pane-note pane-note--${notice.tone}`}>
                <span>{notice.text}</span>
                <button
                  type="button"
                  className="pane-note__close"
                  aria-label="Close this note"
                  onClick={() => setClosedNotices(new Set(closedNotices).add(notice.id))}
                >
                  <X size={13} aria-hidden />
                </button>
              </div>
            ))}

            {waiting && (
              <div className="empty">
                <div className="spinner" />
                <p>Checking your text.</p>
              </div>
            )}
            {snapshot?.empty && (
              <div className="empty">
                <p>{snapshot.empty}</p>
              </div>
            )}
            {!snapshot && !host.live && !checking && (
              <div className="empty">
                <p>Select some text, then choose Check selection.</p>
              </div>
            )}
            {result && snapshot && !snapshot.empty && issues.length === 0 && (
              <div className="empty">
                <CircleCheck size={22} className="empty__ok" aria-hidden />
                <p>No suggestions right now.</p>
              </div>
            )}

            {issues.length > 0 && (
              <ul className="cards">
                {issues.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={readOnly ? { ...issue, fixes: [] } : issue}
                    open={openId === issue.id}
                    actions={actions}
                    onToggle={() => toggle(issue)}
                    extra={
                      readOnly && issue.fixes.length > 0 ? <p className="pane__suggested">{handFix(issue)}</p> : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </main>
        </>
      )}

      <footer className="pane__privacy">Text is checked in this pane and is not sent anywhere.</footer>
    </div>
  );
}
