// A real ProseMirror editor, mounted through TipTap as in the app.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const editor = new Editor({
  element: document.getElementById('editor') as HTMLElement,
  extensions: [StarterKit],
  content: '<p>The quik fox jumped over the lazy dog.</p><p>This paragraph has <strong>a mispelled</strong> word.</p>',
});

Object.assign(window, { pageEditor: editor });
