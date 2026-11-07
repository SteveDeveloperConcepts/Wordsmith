import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { documentExtensions } from '../lib/schema';
import { useLibrary, type DocRecord } from '../state/library';
import { useSession } from '../state/session';
import { useSettings } from '../state/settings';
import { AnalysisController } from './controller';
import { IssuePopover, type PopoverTarget } from './IssuePopover';
import { IssuesExtension, locateIssue } from './issues';
import { SelectionMenu } from './SelectionMenu';
import { useIssueActions } from './useIssueActions';

/** How long the pointer rests on an underline before its suggestion appears. */
const HOVER_DELAY = 280;
/** Grace period for moving the pointer from the text into the popover. */
const LEAVE_DELAY = 220;

interface Props {
  doc: DocRecord;
  onEditor(editor: Editor | null): void;
  /** No title, for text that is being checked rather than written as a document. */
  compact?: boolean;
}

/** The writing surface for one document: title, rich text, underlines, and the hover popover. */
export function EditorPane({ doc, onEditor, compact = false }: Props) {
  const editorFont = useSettings((s) => s.editorFont);
  const editorSize = useSettings((s) => s.editorSize);
  const rename = useLibrary((s) => s.rename);
  const actions = useIssueActions();
  const [title, setTitle] = useState(doc.title);
  const [popover, setPopover] = useState<PopoverTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      ...documentExtensions,
      Placeholder.configure({ placeholder: 'Start writing, or paste your text here…' }),
      IssuesExtension,
    ],
    content: doc.content,
    editorProps: {
      attributes: {
        class: 'ws-prose',
        // Wordsmith does the checking; the browser's own squiggles would only compete.
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'sentences',
        'aria-label': 'Document text',
      },
    },
  });

  const docId = doc.id;
  useEffect(() => {
    if (!editor) return;
    onEditor(editor);
    useSession.getState().setEditor(editor, docId);
    const controller = new AnalysisController(editor, docId);
    return () => {
      controller.dispose();
      useSession.getState().setEditor(null);
      useSession.getState().setResult(null);
      onEditor(null);
    };
  }, [editor, onEditor, docId]);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const closePopover = useCallback(() => {
    clearTimer();
    setPopover(null);
  }, []);

  const scheduleClose = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => setPopover(null), LEAVE_DELAY);
  }, []);

  /** Find the issue under the pointer and the line box it sits on. */
  const targetAt = (event: MouseEvent): PopoverTarget | null => {
    if (!editor) return null;
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-issue]');
    const id = element?.dataset.issue;
    if (!element || !id) return null;
    const placed = locateIssue(editor.state, id);
    if (!placed) return null;
    const rects = Array.from(element.getClientRects());
    const rect =
      rects.find((r) => event.clientY >= r.top - 1 && event.clientY <= r.bottom + 1 && event.clientX >= r.left - 1 && event.clientX <= r.right + 1) ??
      rects.find((r) => event.clientY >= r.top - 1 && event.clientY <= r.bottom + 1) ??
      element.getBoundingClientRect();
    // A long flagged sentence: anchor the card near the pointer rather than at the line start.
    const anchored = placed.issue.sentenceLevel
      ? new DOMRect(Math.max(rect.left, event.clientX - 24), rect.top, 1, rect.height)
      : rect;
    return { issue: placed.issue, rect: anchored };
  };

  const onMouseOver = (event: MouseEvent) => {
    if (event.buttons !== 0) return; // dragging a selection
    const target = targetAt(event);
    if (!target) return;
    if (popover?.issue.id === target.issue.id) {
      clearTimer();
      return;
    }
    // Whole-sentence underlines open on click only, so reading is not interrupted.
    if (target.issue.sentenceLevel) return;
    clearTimer();
    timer.current = setTimeout(() => setPopover(target), HOVER_DELAY);
  };

  const onMouseOut = (event: MouseEvent) => {
    const from = (event.target as HTMLElement).closest('[data-issue]');
    const to = (event.relatedTarget as HTMLElement | null)?.closest?.('[data-issue]');
    if (!from || from === to) return;
    if (popover) scheduleClose();
    else clearTimer();
  };

  const onClick = (event: MouseEvent) => {
    const target = targetAt(event);
    if (!target) {
      closePopover();
      return;
    }
    clearTimer();
    setPopover(target);
    actions.select(target.issue, false);
  };

  // Close the popover when its issue disappears, the page scrolls, or Escape is pressed.
  const result = useSession((s) => s.result);
  useEffect(() => {
    if (popover && !result?.issues.some((i) => i.id === popover.issue.id)) setPopover(null);
  }, [result, popover]);

  useEffect(() => {
    if (!popover) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closePopover();
    };
    const element = scroller.current;
    document.addEventListener('keydown', onKey);
    element?.addEventListener('scroll', closePopover, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      element?.removeEventListener('scroll', closePopover);
    };
  }, [popover, closePopover]);

  useEffect(() => clearTimer, []);

  const onTitleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      editor?.commands.focus('start');
    }
  };

  return (
    <div
      className="page-scroll"
      ref={scroller}
      onMouseOver={onMouseOver}
      onMouseOut={onMouseOut}
      onClick={onClick}
      // Typing hides the card so it never covers the line being written.
      onKeyDown={popover ? closePopover : undefined}
    >
      <div
        className={`page page--${editorFont}`}
        style={{ ['--editor-size' as string]: `${editorSize}px` }}
      >
        {!compact && (
          <input
            className="title-input"
            value={title}
            placeholder="Untitled document"
            aria-label="Document title"
            spellCheck={false}
            onChange={(event) => {
              setTitle(event.target.value);
              rename(event.target.value);
            }}
            onKeyDown={onTitleKey}
          />
        )}
        <EditorContent editor={editor} />
        {editor && !compact && <SelectionMenu editor={editor} />}
      </div>
      {popover && (
        <IssuePopover target={popover} actions={actions} onMouseEnter={clearTimer} onMouseLeave={scheduleClose} />
      )}
    </div>
  );
}
