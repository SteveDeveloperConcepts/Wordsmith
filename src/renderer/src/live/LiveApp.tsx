/**
 * The live overlay's page: a transparent window laid over the message body in Outlook or the
 * page in Word. The main process reads the text from there and sends it here; this page checks
 * it with the usual engine, asks where each flagged word is on screen, draws an underline
 * there, and opens a card with the fixes when the pointer rests on one. A fix goes back
 * through the main process, which selects the words in the app and pastes over them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Fix, Goals } from '@engine/types';
import type { LivePlacement, LiveRange, LiveRect, LiveText } from '@shared/api';
import { analysisClient } from '../editor/analysisClient';
import { useTheme } from '../lib/useTheme';
import { desktop } from '../platform';
import { engineSettings, useSettings } from '../state/settings';
import '../styles/live.css';
import { applyEdit, fingerprint, paragraphEnd, squeeze, toBlocks, type Placed } from './text';

/** Long enough not to check half-typed words, short enough to feel live. */
const TYPING_DELAY_MS = 400;
/** Pointers cross underlines on the way elsewhere; only a pause should open a card. */
const OPEN_DELAY_MS = 120;
/** Time to get from the underline to the card. */
const CLOSE_DELAY_MS = 250;
/** An underline sits just below the text's box. */
const HOVER_SLOP = 3;
const MAX_FIXES = 4;
const CARD_WIDTH = 300;
const CARD_GAP = 6;
const EDGE = 8;

/** Set when Wordsmith runs with WORDSMITH_LIVE_DEBUG=1: the overlay then logs what it measures and draws. */
const debug: (message: string) => void = new URLSearchParams(window.location.search).has('debug')
  ? (message) => console.log(message)
  : () => undefined;

const goalsFor = (app: string): Goals => {
  const goals = useSettings.getState().defaultGoals;
  return app === 'Outlook' ? { ...goals, domain: 'email' } : goals;
};

function configureEngine(app: string): void {
  analysisClient.configure(engineSettings(useSettings.getState(), goalsFor(app)));
}

const inRect = (rect: LiveRect, x: number, y: number) =>
  x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height + HOVER_SLOP;

function hit(placed: Placed[], x: number, y: number): Placed | null {
  return placed.find((p) => p.rects.some((rect) => inRect(rect, x, y))) ?? null;
}

/** Below the flagged text if there is room, otherwise above it, and inside the overlay. */
function placeCard(anchor: LiveRect, height: number): { left: number; top: number } {
  const below = anchor.y + anchor.height + CARD_GAP;
  const above = anchor.y - height - CARD_GAP;
  const top = below + height <= window.innerHeight - EDGE || above < EDGE ? below : above;
  return {
    left: Math.max(Math.min(anchor.x, window.innerWidth - CARD_WIDTH - EDGE), EDGE),
    top: Math.max(Math.min(top, window.innerHeight - height - EDGE), EDGE),
  };
}

interface CardProps {
  placed: Placed;
  note: string | null;
  onFix(placed: Placed, fix: Fix): void;
  onDismiss(placed: Placed): void;
  onAddWord(placed: Placed, word: string): void;
}

function Card({ placed, note, onFix, onDismiss, onAddWord }: CardProps) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: EDGE, top: EDGE });
  const anchor = placed.rects[0];
  const [ax, ay, aw, ah] = anchor ? [anchor.x, anchor.y, anchor.width, anchor.height] : [0, 0, 0, 0];
  useEffect(() => {
    if (!element.current || aw === 0) return;
    setPosition(placeCard({ x: ax, y: ay, width: aw, height: ah }, element.current.getBoundingClientRect().height));
  }, [ax, ay, aw, ah, note]);
  const { issue } = placed;
  return (
    <div ref={element} className={`live-card live-card--${issue.category}`} role="dialog" aria-label="Suggestion" style={position}>
      <div className="live-card__title">
        <span className="live-card__dot" />
        <span>{issue.title}</span>
      </div>
      <p className="live-card__message">{issue.message}</p>
      {issue.fixes.length > 0 && (
        <div className="live-card__fixes">
          {issue.fixes.slice(0, MAX_FIXES).map((fix) => (
            <button
              key={`${fix.from}-${fix.to}-${fix.text}`}
              type="button"
              className="live-card__fix"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onFix(placed, fix)}
            >
              {fix.label}
            </button>
          ))}
        </div>
      )}
      <div className="live-card__actions">
        <button type="button" className="live-card__action" onClick={() => onDismiss(placed)}>
          Dismiss
        </button>
        {issue.type === 'spelling' && issue.word && (
          <button type="button" className="live-card__action" onClick={() => onAddWord(placed, issue.word!)}>
            Add to dictionary
          </button>
        )}
      </div>
      {note && <p className="live-card__note">{note}</p>}
    </div>
  );
}

export function LiveApp() {
  useTheme();
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [open, setOpen] = useState<Placed | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const current = useRef<LiveText | null>(null);
  const dismissed = useRef(new Set<string>());
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const placedRef = useRef<Placed[]>([]);
  const openRef = useRef<Placed | null>(null);
  const overCard = useRef(false);
  const interactive = useRef(false);
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  const checks = useRef(0);

  const setInteractive = useCallback((on: boolean, why: string) => {
    if (interactive.current === on) return;
    interactive.current = on;
    debug(`[live] takes clicks ${on} (${why})`);
    void desktop?.liveInteractive(on);
  }, []);

  const pointer = useRef<{ x: number; y: number } | null>(null);

  /**
   * The overlay takes clicks only while the pointer is on an underline or on the card, and
   * everywhere else lets them through to the app. Worked out from where the pointer is, so
   * that redrawing the underlines can never take the card's buttons away from under it.
   */
  const updateInteractive = useCallback(
    (why: string) => {
      const at = pointer.current;
      const onMark = at !== null && hit(placedRef.current, at.x, at.y) !== null;
      const card = document.querySelector('.live-card')?.getBoundingClientRect();
      const onCard =
        overCard.current || (at !== null && card !== undefined && at.x >= card.left && at.x <= card.right && at.y >= card.top && at.y <= card.bottom);
      setInteractive(onMark || onCard, why);
    },
    [setInteractive],
  );

  const show = useCallback(
    (next: Placed[]) => {
      placedRef.current = next;
      setPlaced(next);
      const was = openRef.current;
      if (was) {
        const still = next.find((p) => p.issue.id === was.issue.id) ?? null;
        openRef.current = still;
        setOpen(still);
        if (!still) {
          // The card unmounts without a mouseleave, so it no longer holds the pointer.
          overCard.current = false;
          setNote(null);
        }
      }
      updateInteractive('underlines redrawn');
    },
    [updateInteractive],
  );

  /**
   * Ask where the flagged words are now, and drop any whose text has changed under them. A
   * request made while one is under way runs once more afterwards, so the last scroll position
   * is never missed.
   */
  const refreshRects = useCallback(async () => {
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    try {
      do {
        refreshAgain.current = false;
        const before = placedRef.current;
        if (before.length === 0) {
          show([]);
          break;
        }
        const text = current.current?.text;
        if (text === undefined) break;
        const ranges: LiveRange[] = before.map((p) => [p.start, p.end]);
        const measured = await desktop?.liveRects(ranges, fingerprint(text));
        // A check finished meanwhile and placed everything afresh.
        if (!measured || placedRef.current !== before) continue;
        // The writer typed while this was measured. The update on its way moves the underlines
        // with the edit and measures them again, so nothing is dropped for a passing mismatch.
        if (measured.stale) break;
        const next: Placed[] = [];
        const lost: string[] = [];
        measured.placements.forEach((placement: LivePlacement, index) => {
          const p = before[index];
          if (p && squeeze(placement.text) === squeeze(p.issue.text)) next.push({ ...p, rects: placement.rects });
          else if (p) lost.push(`"${p.issue.text}" at ${p.start}-${p.end} reads "${placement.text}"`);
        });
        if (lost.length) debug(`[live] refresh dropped ${lost.length}: ${lost.slice(0, 3).join('; ')}`);
        show(next);
      } while (refreshAgain.current);
    } finally {
      refreshing.current = false;
    }
  }, [show]);

  const check = useCallback(async () => {
    const update = current.current;
    if (!update) return;
    const started = performance.now();
    const { blocks, starts } = toBlocks(update.text);
    const result = await analysisClient.analyze({ blocks, dismissed: [...dismissed.current] });
    if (!result || current.current !== update) return;
    const found: Placed[] = result.issues
      .filter((issue) => !issue.sentenceLevel)
      .map((issue) => ({
        issue,
        start: starts[issue.block] + issue.from,
        end: starts[issue.block] + issue.to,
        blockText: blocks[issue.block].text,
        rects: [],
      }));
    const measured = found.length
      ? await desktop?.liveRects(found.map((p): LiveRange => [p.start, p.end]), fingerprint(update.text))
      : { placements: [], stale: false };
    if (current.current !== update) return;
    if (measured?.stale) {
      // The writer typed while this was measured. Keep the results, not yet drawn: the update on
      // its way moves them with the edit and measures them again.
      placedRef.current = found;
      return;
    }
    const placements = measured?.placements;
    const next = placements
      ? found.map((p, i) => ({ ...p, rects: placements[i]?.rects ?? [] })).filter((p, i) => placements[i] && squeeze(placements[i].text) === squeeze(p.issue.text))
      : [];
    checks.current++;
    debug(`[live] check ${checks.current}: ${update.text.length} chars, ${result.issues.length} issues, ${next.length} drawn, ${Math.round(performance.now() - started)} ms`);
    show(next);
  }, [show]);

  const following = useRef(false);

  /**
   * After an edit, later paragraphs can only move up or down, all by the same amount. So one
   * underline below the edited paragraph is measured, and the others below it move by as much.
   */
  const followLaterParagraphs = useCallback(
    async (update: LiveText, end: number) => {
      if (following.current) return;
      const later = placedRef.current.filter((p) => p.start > end && p.rects.length > 0);
      if (later.length === 0) return;
      const anchor = later.reduce((a, b) => (b.start < a.start ? b : a));
      following.current = true;
      try {
        const measured = await desktop?.liveRects([[anchor.start, anchor.end]], fingerprint(update.text));
        if (!measured || measured.stale || current.current !== update) return;
        const placement = measured.placements[0];
        const was = anchor.rects[0];
        const now = placement?.rects[0];
        if (!placement || !was || !now || squeeze(placement.text) !== squeeze(anchor.issue.text)) return;
        const dy = now.y - was.y;
        if (dy === 0) return;
        show(
          placedRef.current.map((p) =>
            p.start > end ? { ...p, rects: p.rects.map((rect) => ({ ...rect, y: rect.y + dy })) } : p,
          ),
        );
      } finally {
        following.current = false;
      }
    },
    [show],
  );

  const textChanged = useCallback(
    (update: LiveText) => {
      const previous = current.current;
      current.current = update;
      if (!previous || previous.app !== update.app) configureEngine(update.app);
      // Another message or document: its text is not an edit of the last one's.
      if (previous && previous.field !== update.field) {
        openRef.current = null;
        setOpen(null);
        show([]);
      }
      const edited = previous !== null && previous.field === update.field && previous.text !== update.text;
      if (edited) {
        // Underlines before the edit have not moved. Later ones in the same paragraph may have
        // reflowed, so they hide until the writer pauses and the next check measures them.
        // Measuring every underline on every keystroke kept Outlook at over half a core.
        const edit = applyEdit(placedRef.current, previous.text, update.text);
        const end = paragraphEnd(update.text, edit.end);
        show(edit.kept.map((p) => (p.end > edit.start && p.start <= end ? { ...p, rects: [] } : p)));
        void followLaterParagraphs(update, end);
      }
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => void check(), edited ? TYPING_DELAY_MS : 0);
    },
    [check, followLaterParagraphs, show],
  );

  useEffect(() => {
    const stopText = desktop?.onLiveText(textChanged);
    const stopTick = desktop?.onLiveTick(() => void refreshRects());
    const stopSettings = useSettings.subscribe(() => {
      if (current.current) {
        configureEngine(current.current.app);
        void check();
      }
    });
    desktop?.liveReady();
    return () => {
      stopText?.();
      stopTick?.();
      stopSettings();
    };
  }, [check, refreshRects, textChanged]);

  /* ---------- Hovering ---------- */

  const closeCard = useCallback(
    (why: string) => {
      clearTimeout(openTimer.current);
      openRef.current = null;
      overCard.current = false;
      setOpen(null);
      setNote(null);
      updateInteractive(why);
    },
    [updateInteractive],
  );

  const closeSoon = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!overCard.current) closeCard('card closed');
    }, CLOSE_DELAY_MS);
  }, [closeCard]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      const under = hit(placedRef.current, event.clientX, event.clientY);
      if (under) {
        clearTimeout(closeTimer.current);
        setInteractive(true, 'pointer on an underline');
        if (openRef.current?.issue.id !== under.issue.id) {
          clearTimeout(openTimer.current);
          openTimer.current = setTimeout(() => {
            // The underlines may have been redrawn meanwhile, so open the current one.
            const current = placedRef.current.find((p) => p.issue.id === under.issue.id);
            if (!current) return;
            openRef.current = current;
            setOpen(current);
            setNote(null);
          }, OPEN_DELAY_MS);
        }
        return;
      }
      clearTimeout(openTimer.current);
      if (overCard.current) return;
      if (openRef.current) closeSoon();
      else setInteractive(false, 'pointer on nothing');
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [closeSoon, setInteractive]);

  const cardEnter = () => {
    overCard.current = true;
    clearTimeout(closeTimer.current);
    setInteractive(true, 'pointer on the card');
  };
  const cardLeave = () => {
    overCard.current = false;
    closeSoon();
  };

  /* ---------- Acting on a suggestion ---------- */

  const applyFix = async (target: Placed, fix: Fix) => {
    if (!desktop) return;
    const blockStart = target.start - target.issue.from;
    const original = target.blockText.slice(fix.from, fix.to);
    debug(`[live] fix pressed: "${original}" -> "${fix.text}"`);
    const outcome = await desktop.liveReplace({ start: blockStart + fix.from, end: blockStart + fix.to, original, text: fix.text });
    if (outcome.ok) {
      overCard.current = false;
      show(placedRef.current.filter((p) => p !== target));
      return;
    }
    const app = current.current?.app ?? 'the app';
    setNote(
      outcome.reason === 'selection-changed'
        ? 'The text changed, so nothing was replaced.'
        : outcome.reason === 'paste-failed'
          ? `${app} did not take the change.`
          : `Could not reach ${app}.`,
    );
  };

  const dismiss = (target: Placed) => {
    dismissed.current.add(target.issue.id);
    overCard.current = false;
    show(placedRef.current.filter((p) => p !== target));
  };

  const addWord = (target: Placed, word: string) => {
    useSettings.getState().addWord(word);
    overCard.current = false;
    show(placedRef.current.filter((p) => p !== target));
  };

  return (
    <div className="live">
      {placed.map((p) =>
        p.rects.map((rect, index) => (
          <div
            key={`${p.issue.id}-${index}`}
            className={`live-mark live-mark--${p.issue.category}`}
            style={{ left: rect.x, top: rect.y + rect.height - 3, width: rect.width }}
          />
        )),
      )}
      {open && (
        <div onMouseEnter={cardEnter} onMouseLeave={cardLeave}>
          <Card placed={open} note={note} onFix={(p, fix) => void applyFix(p, fix)} onDismiss={dismiss} onAddWord={addWord} />
        </div>
      )}
    </div>
  );
}
