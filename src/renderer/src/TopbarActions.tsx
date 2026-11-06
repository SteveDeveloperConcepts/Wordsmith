import { ChevronDown, ClipboardCopy, Download } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { MenuAction } from '@shared/api';
import { runCommand } from './commands';
import { isDesktop } from './platform';

const EXPORTS: Array<{ action: MenuAction; label: string }> = [
  ...(isDesktop
    ? ([
        { action: 'open-in-word', label: 'Open in Word' },
        { action: 'email-document', label: 'Start an email' },
      ] as const)
    : []),
  { action: 'export-docx', label: 'Word document' },
  { action: 'export-pdf', label: 'PDF' },
  { action: 'export-html', label: 'Web page' },
  { action: 'export-md', label: 'Markdown' },
  { action: 'export-txt', label: 'Plain text' },
  { action: 'print', label: 'Print' },
];

function ExportMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      items[(moves[event.key] + items.length) % items.length].focus();
    } else if (event.key === 'Escape') {
      close();
    }
  };

  return (
    <div className="menu-anchor" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn btn--quiet"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Save this document in another format"
        onClick={() => setOpen(!open)}
      >
        <Download size={15} aria-hidden /> Export <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Export" onKeyDown={onKeyDown}>
          {EXPORTS.map(({ action, label }) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              onClick={() => {
                close();
                runCommand(action);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Getting a finished document out of the app. */
export function TopbarActions() {
  return (
    <>
      <button
        type="button"
        className="btn btn--quiet"
        title="Copy the document with its formatting, ready to paste into Word or an email"
        onClick={() => runCommand('copy-document')}
      >
        <ClipboardCopy size={15} aria-hidden /> Copy
      </button>
      <ExportMenu />
    </>
  );
}
