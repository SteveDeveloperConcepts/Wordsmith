import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import '../styles/dialogs.css';

interface Props {
  title: string;
  /** One line under the title. */
  description?: string;
  onClose(): void;
  children: ReactNode;
  /** Buttons along the bottom edge. */
  footer?: ReactNode;
  size?: 'normal' | 'wide';
}

/**
 * A modal built on the native <dialog> element, which gives focus trapping,
 * Escape to close, and inert page content without extra code.
 */
export function Dialog({ title, description, onClose, children, footer, size = 'normal' }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // A click on the dialog element itself is a click on the backdrop.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog__frame">
        <header className="dialog__header">
          <div>
            <h2 className="dialog__title" id={titleId}>
              {title}
            </h2>
            {description && <p className="dialog__description">{description}</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
