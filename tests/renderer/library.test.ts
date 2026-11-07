// @vitest-environment happy-dom
import type { Editor, JSONContent } from '@tiptap/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentContent, useLibrary } from '@renderer/state/library';
import { useSession } from '@renderer/state/session';

const textDoc = (text: string): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const summary = { preview: 'preview', words: 2 };

/** Long enough for the save that follows an edit, and for a late save to land. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

const fakeEditor = (content: JSONContent) => ({ isDestroyed: false, getJSON: () => content }) as unknown as Editor;

describe('the document library', () => {
  let first: string;
  let second: string;

  beforeEach(async () => {
    useSession.getState().setEditor(null);
    first = await useLibrary.getState().create({ title: 'First', content: textDoc('first text') });
    second = await useLibrary.getState().create({ title: 'Second', content: textDoc('second text') });
  });

  it('files an edit that arrives after a switch under the document it came from', async () => {
    // The second document is open. The first one's editor has its last word.
    useLibrary.getState().saveContent(first, textDoc('first text, edited'), summary);
    await settled();

    expect(currentContent()).toEqual(textDoc('second text'));
    await useLibrary.getState().open(first);
    expect(useLibrary.getState().current?.content).toEqual(textDoc('first text, edited'));
    await useLibrary.getState().open(second);
    expect(useLibrary.getState().current?.content).toEqual(textDoc('second text'));
  });

  it('updates the list entry of the document that was edited', async () => {
    useLibrary.getState().saveContent(first, textDoc('first text, edited'), { preview: 'edited', words: 3 });
    await settled();
    const entry = useLibrary.getState().docs.find((doc) => doc.id === first);
    expect(entry).toMatchObject({ preview: 'edited', words: 3 });
  });

  it('does not bring back a deleted document', async () => {
    await useLibrary.getState().remove(first);
    useLibrary.getState().saveContent(first, textDoc('too late'), summary);
    await settled();
    expect(useLibrary.getState().docs.some((doc) => doc.id === first)).toBe(false);
    await useLibrary.getState().open(first);
    expect(useLibrary.getState().current?.id).toBe(second);
  });

  it('asks the editor for the latest text, which runs ahead of the saved draft', () => {
    useLibrary.getState().saveContent(second, textDoc('saved a moment ago'), summary);
    useSession.getState().setEditor(fakeEditor(textDoc('typed just now')), second);
    expect(currentContent()).toEqual(textDoc('typed just now'));
  });

  it('ignores an editor still showing another document, as happens during a switch', () => {
    useSession.getState().setEditor(fakeEditor(textDoc('another document')), first);
    expect(currentContent()).toEqual(textDoc('second text'));
  });

  it('saves the editor’s latest text when flushing, as when the window closes', async () => {
    useSession.getState().setEditor(fakeEditor(textDoc('typed just now')), second);
    await useLibrary.getState().flush();
    useSession.getState().setEditor(null);
    await useLibrary.getState().open(first);
    await useLibrary.getState().open(second);
    expect(useLibrary.getState().current?.content).toEqual(textDoc('typed just now'));
  });
});
