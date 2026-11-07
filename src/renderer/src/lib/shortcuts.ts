/** Reading and writing global shortcuts, in Electron's accelerator format. */
import { isMac } from '../platform';

const MAC_SYMBOLS: Record<string, string> = {
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Command: '⌘',
  Super: '⌘',
};

const WINDOWS_NAMES: Record<string, string> = {
  Control: 'Ctrl',
  Command: 'Win',
  Super: 'Win',
};

/** "Control+Alt+W" as a person would write it on this platform. */
export function shortcutLabel(accelerator: string, mac = isMac): string {
  const parts = accelerator.split('+');
  if (mac) return parts.map((part) => MAC_SYMBOLS[part] ?? part).join('');
  return parts.map((part) => WINDOWS_NAMES[part] ?? part).join('+');
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  '+': 'Plus',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The character a key produces without Shift or Option, which is what the accelerator wants. */
function keyName({ key, code }: KeyPress): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(key)) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  if (/^F\d{1,2}$/.test(key)) return key;
  return key.length === 1 ? key.toUpperCase() : null;
}

/**
 * Turn a key press into an accelerator. Null while only modifiers are held, or for
 * a combination with too little in it to be safe as a shortcut across the whole system.
 */
export function acceleratorFor(event: KeyPress): string | null {
  const key = keyName(event);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Command');
  const hasCommandKey = event.ctrlKey || event.altKey || event.metaKey;
  if (!hasCommandKey) return null;
  return [...parts, key].join('+');
}
