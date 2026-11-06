import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { Copy, Ellipsis, FileUp, Plus, Search, SearchX, Settings, Trash2, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import { scoreLabel } from '../assistant/ScoreRing';
import { formatRelative, plural } from '../lib/format';
import { useLibrary, type DocMeta } from '../state/library';
import { useSession } from '../state/session';
import '../styles/library.css';

/** Longer than the double-click window, so the second click of a double-click can never confirm. */
const CONFIRM_DELAY = 600;

const CLOCK_INTERVAL = 30_000;

const titleOf = (doc: DocMeta) => doc.title.trim() || 'Untitled document';

/** Every word of the search must appear in the title or preview, in any order. */
function matches(doc: DocMeta, terms: string[]): boolean {
  const text = `${titleOf(doc)} ${doc.preview}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

/** The same bands as the score ring in the Assistant panel. */
const scoreBand = (score: number | null) =>
  score === null ? 'none' : score >= 85 ? 'good' : score >= 70 ? 'warn' : 'bad';

const scoreText = (score: number | null) =>
  score === null ? scoreLabel(null) : `Score ${score} out of 100: ${scoreLabel(score)}`;

/** The current time, refreshed so that "Just now" does not linger on an idle list. */
function useClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Calls `onOutside` when the pointer goes down anywhere but inside the given elements. */
function useOutsidePointer(inside: Array<RefObject<HTMLElement | null>>, onOutside: () => void): void {
  useEffect(() => {
    const listener = (event: PointerEvent) => {
      if (!inside.some((ref) => ref.current?.contains(event.target as Node))) onOutside();
    };
    document.addEventListener('pointerdown', listener);
    return () => document.removeEventListener('pointerdown', listener);
  });
}

function Mark() {
  return (
    <svg className="library__mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect className="library__mark-tile" width="24" height="24" rx="6" />
      <path className="library__mark-letter" d="M5.5 7.5 8.7 17 12 9.6 15.3 17l3.2-9.5" />
    </svg>
  );
}

interface RowMenuProps {
  label: string;
  anchor: RefObject<HTMLButtonElement | null>;
  onDuplicate(): void;
  onDelete(): void;
  onClose(refocus: boolean): void;
}

/** Fixed to the viewport, because the list's scrolling would clip it on the last rows. */
function RowMenu({ label, anchor, onDuplicate, onDelete, onClose }: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useOutsidePointer([ref, anchor], () => onClose(false));

  useLayoutEffect(() => {
    const menu = ref.current;
    const button = anchor.current;
    if (!menu || !button) return;
    let cancelled = false;
    void computePosition(button, menu, {
      placement: 'bottom-end',
      strategy: 'fixed',
      middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      if (cancelled) return;
      menu.style.left = `${Math.round(x)}px`;
      menu.style.top = `${Math.round(y)}px`;
      menu.style.visibility = 'visible';
      menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    });
    return () => {
      cancelled = true;
    };
  }, [anchor]);

  // The menu would otherwise be left floating away from its row.
  useEffect(() => {
    const close = () => onClose(true);
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
    };
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      items[(moves[event.key] + items.length) % items.length].focus();
    } else if (event.key === 'Escape') {
      onClose(true);
    }
  };

  return (
    <div
      ref={ref}
      className="doc-menu"
      role="menu"
      aria-label={label}
      style={{ visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next && !event.currentTarget.contains(next)) onClose(false);
      }}
    >
      <button type="button" role="menuitem" tabIndex={-1} className="doc-menu__item" onClick={onDuplicate}>
        <Copy size={15} aria-hidden /> Duplicate
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className="doc-menu__item doc-menu__item--danger" onClick={onDelete}>
        <Trash2 size={15} aria-hidden /> Delete
      </button>
    </div>
  );
}

interface DeleteConfirmProps {
  title: string;
  onCancel(refocus: boolean): void;
  onConfirm(): Promise<void>;
}

/** Takes the row's place. Anything other than pressing Delete backs out, and focus starts on Cancel. */
function DeleteConfirm({ title, onCancel, onConfirm }: DeleteConfirmProps) {
  const [ready, setReady] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  useOutsidePointer([panel], () => onCancel(false));

  useEffect(() => {
    cancel.current?.focus();
    const timer = setTimeout(() => setReady(true), CONFIRM_DELAY);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      ref={panel}
      className="doc-confirm"
      role="group"
      aria-labelledby={questionId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next && !event.currentTarget.contains(next)) onCancel(false);
      }}
    >
      <p id={questionId} className="doc-confirm__question">
        Delete <span className="doc-confirm__title">“{title}”</span>?
      </p>
      <p className="doc-confirm__warning">This cannot be undone.</p>
      <div className="doc-confirm__actions">
        <button ref={cancel} type="button" className="btn btn--outline btn--small" onClick={() => onCancel(true)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--danger btn--small"
          disabled={!ready || deleting}
          onClick={() => {
            setDeleting(true);
            void onConfirm();
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

interface DocRowProps {
  doc: DocMeta;
  active: boolean;
  now: number;
  onDelete(id: string): Promise<void>;
}

/** Memoized because the open document's row changes as the writer types; the others should not re-render. */
const DocRow = memo(function DocRow({ doc, active, now, onDelete }: DocRowProps) {
  const open = useLibrary((s) => s.open);
  const duplicate = useLibrary((s) => s.duplicate);
  const [mode, setMode] = useState<'row' | 'menu' | 'confirm'>('row');
  const trigger = useRef<HTMLButtonElement>(null);
  const title = titleOf(doc);

  /** Back to the plain row. The sync flush is needed because the trigger may only exist again after it. */
  const reset = (refocus: boolean) => {
    flushSync(() => setMode('row'));
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };

  return (
    <li className={`doc${active ? ' is-active' : ''}`} data-doc={doc.id}>
      {mode === 'confirm' ? (
        <DeleteConfirm title={title} onCancel={reset} onConfirm={() => onDelete(doc.id)} />
      ) : (
        <>
          <button
            type="button"
            className="doc__open"
            aria-current={active ? 'true' : undefined}
            title={title}
            onClick={() => void open(doc.id)}
          >
            <span className="doc__title">{title}</span>
            <span className={`doc__preview${doc.preview ? '' : ' doc__preview--empty'}`}>
              {doc.preview || 'No text yet'}
            </span>
            <span className="doc__meta">
              <span
                className={`dot doc__score doc__score--${scoreBand(doc.score)}`}
                role="img"
                aria-label={scoreText(doc.score)}
                title={scoreText(doc.score)}
              />
              {formatRelative(doc.updatedAt, now)} · {plural(doc.words, 'word')}
            </span>
          </button>
          <button
            ref={trigger}
            type="button"
            className="icon-btn doc__more"
            title="More actions"
            aria-label={`More actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={mode === 'menu'}
            onClick={() => setMode(mode === 'menu' ? 'row' : 'menu')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setMode('menu');
              }
            }}
          >
            <Ellipsis size={16} aria-hidden />
          </button>
          {mode === 'menu' && (
            <RowMenu
              label={`Actions for ${title}`}
              anchor={trigger}
              onClose={reset}
              onDuplicate={() => {
                reset(true);
                void duplicate(doc.id);
              }}
              onDelete={() => setMode('confirm')}
            />
          )}
        </>
      )}
    </li>
  );
});

interface Props {
  onImport(): void;
}

/** The list of documents down the left of the window. */
export function LibrarySidebar({ onImport }: Props) {
  const docs = useLibrary((s) => s.docs);
  const currentId = useLibrary((s) => s.current?.id);
  const openDialog = useSession((s) => s.openDialog);
  const [query, setQuery] = useState('');
  const now = useClock();
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const terms = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const visible = useMemo(() => (terms.length ? docs.filter((doc) => matches(doc, terms)) : docs), [docs, terms]);
  const searching = terms.length > 0;

  // The open document can change from elsewhere (the File menu, an import), and may be far down the list.
  useEffect(() => {
    list.current?.querySelector('.doc.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  const clearSearch = () => {
    setQuery('');
    search.current?.focus();
  };

  const newDocument = async () => {
    // A blank document would not match the search, and would seem not to have appeared.
    setQuery('');
    await useLibrary.getState().create();
    useSession.getState().editor?.commands.focus();
  };

  const deleteDocument = useCallback(async (id: string) => {
    const { current, docs: all, open, create, remove } = useLibrary.getState();
    const rows = () => Array.from(list.current?.children ?? []) as HTMLElement[];
    const position = rows().findIndex((row) => row.dataset.doc === id);

    // Move off the document first: with nothing open, the app swaps the whole window for a spinner.
    if (current?.id === id) {
      const next = all.find((doc) => doc.id !== id);
      await (next ? open(next.id) : create());
    }
    await remove(id);

    // The focused button went with the row, so hand focus to the row that took its place.
    const remaining = rows();
    const target = remaining[Math.min(position, remaining.length - 1)];
    (target?.querySelector('button') ?? search.current)?.focus();
  }, []);

  return (
    <aside className="library" aria-label="Documents">
      <header className="library__header">
        <span className="library__brand">
          <Mark />
          Wordsmith
        </span>
        <button
          type="button"
          className="icon-btn"
          title="New document"
          aria-label="New document"
          onClick={() => void newDocument()}
        >
          <Plus size={18} aria-hidden />
        </button>
      </header>

      <div className="library__search" role="search">
        <Search size={15} aria-hidden />
        <input
          ref={search}
          className="input"
          type="search"
          placeholder="Search documents"
          aria-label="Search documents"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
        />
        {query && (
          <button type="button" className="library__clear" aria-label="Clear search" onClick={clearSearch}>
            <X size={14} aria-hidden />
          </button>
        )}
      </div>

      <p className="library__status" role="status">
        {searching ? `${plural(visible.length, 'document')} found` : ''}
      </p>

      {searching && visible.length === 0 ? (
        <div className="library__empty">
          <SearchX size={26} aria-hidden />
          <h3>No documents found</h3>
          <p>Nothing matches “{query.trim()}”. Try a different word.</p>
          <button type="button" className="link" onClick={clearSearch}>
            Clear search
          </button>
        </div>
      ) : (
        <ul ref={list} className="library__list">
          {visible.map((doc) => (
            <DocRow key={doc.id} doc={doc} active={doc.id === currentId} now={now} onDelete={deleteDocument} />
          ))}
        </ul>
      )}

      <footer className="library__footer">
        <button type="button" className="btn btn--ghost btn--small" onClick={() => onImport()}>
          <FileUp size={15} aria-hidden /> Import
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--small"
          aria-haspopup="dialog"
          onClick={() => openDialog('settings')}
        >
          <Settings size={15} aria-hidden /> Settings
        </button>
      </footer>
    </aside>
  );
}
