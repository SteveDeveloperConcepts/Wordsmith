// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { acceleratorFor, shortcutLabel } from '@renderer/lib/shortcuts';

const press = (key: string, code: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers,
});

describe('shortcutLabel', () => {
  it('uses the names on a PC keyboard', () => {
    expect(shortcutLabel('Control+Alt+W', false)).toBe('Ctrl+Alt+W');
    expect(shortcutLabel('Super+Shift+K', false)).toBe('Win+Shift+K');
  });

  it('uses the symbols on a Mac', () => {
    expect(shortcutLabel('Control+Alt+W', true)).toBe('⌃⌥W');
    expect(shortcutLabel('Command+Shift+K', true)).toBe('⌘⇧K');
  });
});

describe('acceleratorFor', () => {
  it('builds an accelerator from a key press', () => {
    expect(acceleratorFor(press('w', 'KeyW', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+W');
    expect(acceleratorFor(press('K', 'KeyK', { metaKey: true, shiftKey: true }))).toBe('Shift+Command+K');
    expect(acceleratorFor(press('F7', 'F7', { ctrlKey: true }))).toBe('Control+F7');
    expect(acceleratorFor(press(' ', 'Space', { altKey: true }))).toBe('Alt+Space');
  });

  it('names the plus key, which would otherwise look like a separator', () => {
    expect(acceleratorFor(press('+', 'Equal', { ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+Plus');
  });

  it('reads the letter from the key position, since Option changes the character on a Mac', () => {
    expect(acceleratorFor(press('∑', 'KeyW', { altKey: true }))).toBe('Alt+W');
  });

  it('waits while only modifiers are held', () => {
    expect(acceleratorFor(press('Control', 'ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(acceleratorFor(press('Alt', 'AltLeft', { altKey: true }))).toBeNull();
  });

  it('refuses keys that would be typed as text', () => {
    expect(acceleratorFor(press('w', 'KeyW'))).toBeNull();
    expect(acceleratorFor(press('W', 'KeyW', { shiftKey: true }))).toBeNull();
  });
});
