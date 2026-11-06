import { useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Heading1,
  Heading2,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  TextQuote,
  Underline,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { MOD } from '../platform';

interface ToolProps {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}

function Tool({ label, shortcut, active = false, disabled = false, onClick, children }: ToolProps) {
  return (
    <button
      type="button"
      className={`tool${active ? ' is-active' : ''}`}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the text selection while clicking the toolbar.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (/^(?:https?:|mailto:)/i.test(url)) return url;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(url)) return `mailto:${url}`;
  return `https://${url}`;
}

export function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const linkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!linkOpen) return;
    const close = (event: MouseEvent) => {
      if (!linkRef.current?.contains(event.target as Node)) setLinkOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [linkOpen]);

  const openLink = () => {
    setHref((editor.getAttributes('link').href as string | undefined) ?? '');
    setLinkOpen((open) => !open);
  };

  const applyLink = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeUrl(href);
    const chain = editor.chain().focus();
    if (!url) {
      chain.extendMarkRange('link').unsetLink().run();
    } else if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
    } else {
      chain.extendMarkRange('link').setLink({ href: url }).run();
    }
    setLinkOpen(false);
  };

  const run = () => editor.chain().focus();

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <Tool label="Undo" shortcut={`${MOD}+Z`} disabled={!state.canUndo} onClick={() => run().undo().run()}>
        <Undo2 size={16} />
      </Tool>
      <Tool label="Redo" shortcut={`${MOD}+Shift+Z`} disabled={!state.canRedo} onClick={() => run().redo().run()}>
        <Redo2 size={16} />
      </Tool>
      <span className="toolbar__divider" />
      <Tool label="Bold" shortcut={`${MOD}+B`} active={state.bold} onClick={() => run().toggleBold().run()}>
        <Bold size={16} />
      </Tool>
      <Tool label="Italic" shortcut={`${MOD}+I`} active={state.italic} onClick={() => run().toggleItalic().run()}>
        <Italic size={16} />
      </Tool>
      <Tool label="Underline" shortcut={`${MOD}+U`} active={state.underline} onClick={() => run().toggleUnderline().run()}>
        <Underline size={16} />
      </Tool>
      <Tool label="Strikethrough" active={state.strike} onClick={() => run().toggleStrike().run()}>
        <Strikethrough size={16} />
      </Tool>
      <span className="toolbar__divider" />
      <Tool label="Heading 1" active={state.h1} onClick={() => run().toggleHeading({ level: 1 }).run()}>
        <Heading1 size={16} />
      </Tool>
      <Tool label="Heading 2" active={state.h2} onClick={() => run().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={16} />
      </Tool>
      <Tool label="Bulleted list" active={state.bullet} onClick={() => run().toggleBulletList().run()}>
        <List size={16} />
      </Tool>
      <Tool label="Numbered list" active={state.ordered} onClick={() => run().toggleOrderedList().run()}>
        <ListOrdered size={16} />
      </Tool>
      <Tool label="Quote" active={state.quote} onClick={() => run().toggleBlockquote().run()}>
        <TextQuote size={16} />
      </Tool>
      <div className="toolbar__anchor" ref={linkRef}>
        <Tool label="Link" shortcut={`${MOD}+K`} active={state.link || linkOpen} onClick={openLink}>
          <LinkIcon size={16} />
        </Tool>
        {linkOpen && (
          <form className="link-form" onSubmit={applyLink}>
            <input
              autoFocus
              className="input"
              type="text"
              inputMode="url"
              placeholder="Paste or type a link"
              value={href}
              onChange={(event) => setHref(event.target.value)}
              aria-label="Link address"
            />
            <button type="submit" className="btn btn--primary btn--small">
              {href.trim() ? 'Apply' : 'Remove'}
            </button>
          </form>
        )}
      </div>
      <Tool label="Clear formatting" onClick={() => run().unsetAllMarks().clearNodes().run()}>
        <RemoveFormatting size={16} />
      </Tool>
    </div>
  );
}
