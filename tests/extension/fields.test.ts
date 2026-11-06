// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { checkableField, editingHost } from '../../src/extension/content/field';
import { PlainField } from '../../src/extension/content/plainField';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root.firstElementChild as HTMLElement;
}

const SITE = 'example.com';

describe('finding the field', () => {
  it('climbs to the outermost editable element', () => {
    const body = mount('<div contenteditable="true"><p><b id="inner">text</b></p></div>');
    expect(editingHost(body.querySelector('#inner') as Element)).toBe(body);
  });

  it('accepts each way of switching contenteditable on', () => {
    for (const value of ['', 'true', 'plaintext-only']) {
      const body = mount(`<div contenteditable="${value}">text</div>`);
      expect(editingHost(body)).toBe(body);
    }
  });

  it('stops at an island that is not editable', () => {
    const body = mount('<div contenteditable="true"><span contenteditable="false"><i id="chip">x</i></span></div>');
    expect(editingHost(body.querySelector('#chip') as Element)).toBeNull();
  });

  it('takes an editable area inside such an island as its own field', () => {
    const body = mount(
      '<div contenteditable="true"><div contenteditable="false"><p id="caption" contenteditable="true">x</p></div></div>',
    );
    expect(editingHost(body.querySelector('#caption') as Element)?.id).toBe('caption');
  });

  it('takes textareas and text inputs, and no other input', () => {
    expect(checkableField(mount('<textarea></textarea>'), SITE)).not.toBeNull();
    expect(checkableField(mount('<input />'), SITE)).not.toBeNull();
    expect(checkableField(mount('<input type="text" />'), SITE)).not.toBeNull();
    for (const type of ['password', 'email', 'search', 'url', 'number']) {
      expect(checkableField(mount(`<input type="${type}" />`), SITE)).toBeNull();
    }
  });

  it('skips fields the writer cannot change', () => {
    expect(checkableField(mount('<textarea readonly></textarea>'), SITE)).toBeNull();
    expect(checkableField(mount('<textarea disabled></textarea>'), SITE)).toBeNull();
  });

  it('leaves personal details alone', () => {
    for (const token of ['name', 'street-address', 'cc-number', 'email']) {
      expect(checkableField(mount(`<input autocomplete="${token}" />`), SITE)).toBeNull();
    }
    expect(checkableField(mount('<input autocomplete="off" />'), SITE)).not.toBeNull();
  });

  it('skips recipient and search boxes', () => {
    expect(checkableField(mount('<input role="combobox" />'), SITE)).toBeNull();
    expect(checkableField(mount('<input aria-autocomplete="list" />'), SITE)).toBeNull();
    expect(checkableField(mount('<div contenteditable="true" role="textbox" aria-label="To"></div>'), SITE)).toBeNull();
    expect(checkableField(mount('<div contenteditable="true" aria-label="Cc recipients"></div>'), SITE)).toBeNull();
  });

  it('keeps a multi-line message body even if its label starts like a recipient box', () => {
    const body = mount('<div contenteditable="true" role="textbox" aria-multiline="true" aria-label="To the team"></div>');
    expect(checkableField(body, SITE)).toBe(body);
  });

  it('respects a site\'s request to leave a field alone', () => {
    expect(checkableField(mount('<textarea data-gramm="false"></textarea>'), SITE)).toBeNull();
    expect(checkableField(mount('<textarea data-enable-grammarly="false"></textarea>'), SITE)).toBeNull();
  });

  it('takes spellcheck off to mean code, except where it does not', () => {
    const code = '<div contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true"></div>';
    expect(checkableField(mount(code), SITE)).toBeNull();
    expect(checkableField(mount(code), 'mail.google.com')).not.toBeNull();
    expect(checkableField(mount(code), 'outlook.live.com')).not.toBeNull();
    expect(checkableField(mount('<div contenteditable spellcheck="false" data-lexical-editor="true"></div>'), SITE)).not.toBeNull();
    expect(checkableField(mount('<div contenteditable spellcheck="false" class="ql-editor"></div>'), SITE)).not.toBeNull();
  });
});

describe('applying a fix to a form field', () => {
  const field = (value: string) => {
    const area = mount('<textarea></textarea>') as HTMLTextAreaElement;
    area.value = value;
    const overlay = document.createElement('div').attachShadow({ mode: 'open' });
    return { area, plain: new PlainField(area, overlay) };
  };

  it('falls back to the value setter and an input event when execCommand does nothing', async () => {
    const { area, plain } = field('First line\nThe secnd line');
    plain.read();
    Object.assign(document, { execCommand: vi.fn(() => false) });
    const input = vi.fn();
    area.addEventListener('input', input);

    expect(await plain.replace(1, 4, 9, 'second')).toBe(true);
    expect(area.value).toBe('First line\nThe second line');
    expect(area.selectionStart).toBe('First line\nThe second'.length);
    expect(input).toHaveBeenCalledOnce();
  });

  it('leaves the value to execCommand when it works', async () => {
    const { area, plain } = field('The secnd line');
    plain.read();
    const execCommand = vi.fn((_command: string, _ui: boolean, text: string) => {
      area.value = `The ${text} line`;
      return true;
    });
    Object.assign(document, { execCommand });
    const input = vi.fn();
    area.addEventListener('input', input);

    expect(await plain.replace(0, 4, 9, 'second')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'second');
    expect(input).not.toHaveBeenCalled();
  });

  it('deletes rather than inserting nothing', async () => {
    const { area, plain } = field('The the line');
    plain.read();
    const execCommand = vi.fn(() => {
      area.value = 'The line';
      return true;
    });
    Object.assign(document, { execCommand });

    await plain.replace(0, 3, 7, '');
    expect(execCommand).toHaveBeenCalledWith('delete');
  });
});
