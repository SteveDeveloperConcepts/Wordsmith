import { describe, expect, it, vi } from 'vitest';
import {
  captureAll,
  captureSelection,
  replaceSelection,
  type ClipboardContent,
  type ClipboardPort,
} from '../../src/main/anywhere/capture';
import { friendlyAppName, type Native, type SourceWindow } from '../../src/main/anywhere/native';

const source: SourceWindow = { name: 'Outlook', handle: 1 };

/** A pretend desktop: one app with a selection, and a real-acting clipboard. */
function setup(options: { selection?: string | null; focusWorks?: boolean; keysHeld?: boolean } = {}) {
  const log: string[] = [];
  const state = {
    selection: options.selection === undefined ? 'Their is a mistake.' : options.selection,
    clipboard: { text: 'what the writer copied earlier', html: null } as ClipboardContent,
    stamp: 100,
    pasted: null as ClipboardContent | null,
    front: true,
  };

  const clipboard: ClipboardPort<ClipboardContent> = {
    save: async () => {
      log.push('save');
      return state.clipboard;
    },
    restore: async (snapshot) => {
      log.push('restore');
      state.clipboard = snapshot;
      state.stamp++;
    },
    read: async () => state.clipboard,
    write: async (content) => {
      log.push('write');
      state.clipboard = content;
      state.stamp++;
    },
  };

  const native: Native = {
    frontmost: () => source,
    isFrontmost: () => state.front,
    isOwn: () => false,
    focus: () => {
      log.push('focus');
      if (options.focusWorks === false) return false;
      state.front = true;
      return true;
    },
    modifiersUp: () => !options.keysHeld,
    clipboardStamp: () => state.stamp,
    pressCopy: () => {
      log.push('copy');
      if (state.selection === null) return;
      state.clipboard = { text: state.selection, html: `<p>${state.selection}</p>` };
      state.stamp++;
    },
    pressPaste: () => {
      log.push('paste');
      state.pasted = state.clipboard;
    },
    pressSelectAll: () => {
      log.push('select-all');
      state.selection = 'Everything in the field.';
    },
  };

  return { native, clipboard, state, log };
}

describe('captureSelection', () => {
  it('returns the selection and puts the clipboard back', async () => {
    const { native, clipboard, state, log } = setup();
    const result = await captureSelection(native, clipboard);
    expect(result).toEqual({ kind: 'text', content: { text: 'Their is a mistake.', html: '<p>Their is a mistake.</p>' } });
    expect(state.clipboard.text).toBe('what the writer copied earlier');
    expect(log).toEqual(['save', 'copy', 'restore']);
  });

  it('reports nothing selected when the app does not answer', async () => {
    const { native, clipboard, state } = setup({ selection: null });
    expect(await captureSelection(native, clipboard)).toEqual({ kind: 'nothing' });
    expect(state.clipboard.text).toBe('what the writer copied earlier');
  });

  it('treats a selection of only spaces as nothing', async () => {
    const { native, clipboard } = setup({ selection: '  \n ' });
    expect(await captureSelection(native, clipboard)).toEqual({ kind: 'nothing' });
  });

  it('does not press anything while the writer still holds the shortcut', async () => {
    const { native, clipboard, log } = setup({ keysHeld: true });
    expect(await captureSelection(native, clipboard)).toEqual({ kind: 'keys-held' });
    expect(log).toEqual([]);
  });

  it('restores the clipboard even if reading it fails', async () => {
    const { native, clipboard, log } = setup();
    clipboard.read = vi.fn().mockRejectedValue(new Error('clipboard is busy'));
    await expect(captureSelection(native, clipboard)).rejects.toThrow('busy');
    expect(log).toContain('restore');
  });
});

describe('captureAll', () => {
  it('returns to the app, selects everything, and copies it', async () => {
    const { native, clipboard, log, state } = setup({ selection: null });
    state.front = false;
    const result = await captureAll(native, clipboard, source);
    expect(result.kind).toBe('text');
    expect(log).toEqual(['focus', 'select-all', 'save', 'copy', 'restore']);
  });
});

describe('replaceSelection', () => {
  const fixed = { text: 'There is a mistake.', html: 'There is a mistake.' };

  it('checks the selection, pastes, and puts the clipboard back', async () => {
    const { native, clipboard, state, log } = setup();
    const result = await replaceSelection(native, clipboard, source, 'Their is a mistake.', fixed);
    expect(result).toEqual({ ok: true });
    expect(state.pasted).toEqual(fixed);
    expect(state.clipboard.text).toBe('what the writer copied earlier');
    expect(log).toEqual(['focus', 'save', 'copy', 'write', 'paste', 'restore']);
  });

  it('accepts a selection that differs only in line endings', async () => {
    const { native, clipboard } = setup({ selection: 'One\r\nTwo\r\n' });
    expect(await replaceSelection(native, clipboard, source, 'One\nTwo', fixed)).toEqual({ ok: true });
  });

  it('refuses to paste over a selection that has changed', async () => {
    const { native, clipboard, state, log } = setup({ selection: 'Something else entirely.' });
    const result = await replaceSelection(native, clipboard, source, 'Their is a mistake.', fixed);
    expect(result).toEqual({ ok: false, reason: 'selection-changed' });
    expect(state.pasted).toBeNull();
    expect(log).not.toContain('paste');
    expect(state.clipboard.text).toBe('what the writer copied earlier');
  });

  it('refuses to paste when the selection is gone', async () => {
    const { native, clipboard, state } = setup({ selection: null });
    const result = await replaceSelection(native, clipboard, source, 'Their is a mistake.', fixed);
    expect(result).toEqual({ ok: false, reason: 'selection-changed' });
    expect(state.pasted).toBeNull();
  });

  it('gives up if the window cannot be reached', async () => {
    const { native, clipboard, state, log } = setup({ focusWorks: false });
    state.front = false;
    const result = await replaceSelection(native, clipboard, source, 'Their is a mistake.', fixed);
    expect(result).toEqual({ ok: false, reason: 'window-gone' });
    expect(log).toEqual(['focus']);
    expect(state.pasted).toBeNull();
  });

  it('carries on if the system refuses focus but the window is in front anyway', async () => {
    const { native, clipboard, state } = setup({ focusWorks: false });
    expect(await replaceSelection(native, clipboard, source, 'Their is a mistake.', fixed)).toEqual({ ok: true });
    expect(state.pasted).toEqual(fixed);
  });

  it('leaves anything the writer copied during the paste alone', async () => {
    const { native, clipboard, state } = setup();
    const press = native.pressPaste;
    native.pressPaste = () => {
      press();
      state.clipboard = { text: 'copied just now', html: null };
      state.stamp++;
    };
    await replaceSelection(native, clipboard, source, 'Their is a mistake.', fixed);
    expect(state.clipboard.text).toBe('copied just now');
  });
});

describe('friendlyAppName', () => {
  it.each([
    ['C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE', 'Outlook'],
    ['C:\\Program Files\\WindowsApps\\Microsoft.OutlookForWindows\\olk.exe', 'Outlook'],
    ['C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', 'Word'],
    ['C:\\Users\\me\\AppData\\Local\\slack\\slack.exe', 'Slack'],
    ['C:\\Tools\\mytool.exe', 'Mytool'],
    [null, null],
  ])('names %s', (path, name) => {
    expect(friendlyAppName(path)).toBe(name);
  });
});
