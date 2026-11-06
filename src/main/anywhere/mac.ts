/**
 * macOS system calls for Check Anywhere, made through koffi so that the app needs
 * no compiled addon of its own. Posting keystrokes to another app requires the
 * Accessibility permission, which Electron's systemPreferences checks for us.
 */
import koffi from 'koffi';
import type { Native, SourceWindow } from './native';

const FRAMEWORKS = '/System/Library/Frameworks';

/** kCGEventSourceStateCombinedSessionState: what the keyboard is doing across all apps. */
const COMBINED_SESSION_STATE = 0;
/** kCGHIDEventTap: as if typed on the keyboard. */
const HID_EVENT_TAP = 0;
const FLAG_SHIFT = 0x20000;
const FLAG_CONTROL = 0x40000;
const FLAG_OPTION = 0x80000;
const FLAG_COMMAND = 0x100000;

/** kVK_ANSI_*: positions on the keyboard, not letters. */
const KEY_A = 0;
const KEY_C = 8;
const KEY_V = 9;

/** NSApplicationActivateIgnoringOtherApps. */
const ACTIVATE_IGNORING_OTHERS = 2;

const TERMINAL_APPS = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'io.alacritty',
  'net.kovidgoyal.kitty',
  'co.zeit.hyper',
]);

interface MacSource extends SourceWindow {
  handle: number;
}

export function createMacNative(): Native {
  const coreGraphics = koffi.load(`${FRAMEWORKS}/CoreGraphics.framework/CoreGraphics`);
  const coreFoundation = koffi.load(`${FRAMEWORKS}/CoreFoundation.framework/CoreFoundation`);
  // Loaded for its classes, which the Objective-C runtime then finds by name.
  koffi.load(`${FRAMEWORKS}/AppKit.framework/AppKit`);
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');

  const CGEventSourceCreate = coreGraphics.func('void *CGEventSourceCreate(int state)');
  const CGEventCreateKeyboardEvent = coreGraphics.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)');
  const CGEventSetFlags = coreGraphics.func('void CGEventSetFlags(void *event, uint64_t flags)');
  const CGEventPost = coreGraphics.func('void CGEventPost(uint32_t tap, void *event)');
  const CGEventSourceFlagsState = coreGraphics.func('uint64_t CGEventSourceFlagsState(int state)');
  const CFRelease = coreFoundation.func('void CFRelease(void *object)');

  const objc_getClass = objc.func('void *objc_getClass(const char *name)');
  const sel_registerName = objc.func('void *sel_registerName(const char *name)');

  // objc_msgSend has no fixed signature: each shape of message needs its own binding.
  const sendForObject = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const sendForString = objc.func('objc_msgSend', 'const char *', ['void *', 'void *']);
  const sendForLong = objc.func('objc_msgSend', 'int64_t', ['void *', 'void *']);
  const sendForInt = objc.func('objc_msgSend', 'int32_t', ['void *', 'void *']);
  const sendWithInt = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int32_t']);
  const sendWithLong = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'uint64_t']);

  const selector = (name: string) => sel_registerName(name);
  const workspace = () => sendForObject(objc_getClass('NSWorkspace'), selector('sharedWorkspace'));
  const frontmostApp = () => sendForObject(workspace(), selector('frontmostApplication'));
  const stringOf = (nsString: unknown) => (nsString ? (sendForString(nsString, selector('UTF8String')) as string) : null);
  const pidOf = (app: unknown) => sendForInt(app, selector('processIdentifier')) as number;

  const ownPid = process.pid;

  function press(key: number, flags: number): void {
    const source = CGEventSourceCreate(COMBINED_SESSION_STATE);
    for (const down of [true, false]) {
      const event = CGEventCreateKeyboardEvent(source, key, down);
      CGEventSetFlags(event, flags);
      CGEventPost(HID_EVENT_TAP, event);
      CFRelease(event);
    }
    if (source) CFRelease(source);
  }

  return {
    frontmost(): SourceWindow | null {
      const app = frontmostApp();
      if (!app) return null;
      const bundleId = stringOf(sendForObject(app, selector('bundleIdentifier')));
      const source: MacSource = {
        name: stringOf(sendForObject(app, selector('localizedName'))),
        handle: pidOf(app),
        terminal: bundleId !== null && TERMINAL_APPS.has(bundleId),
      };
      return source;
    },

    isFrontmost(source) {
      const app = frontmostApp();
      return Boolean(app) && pidOf(app) === source.handle;
    },

    isOwn: (source) => source.handle === ownPid,

    focus(source) {
      const running = objc_getClass('NSRunningApplication');
      const app = sendWithInt(running, selector('runningApplicationWithProcessIdentifier:'), source.handle as number);
      if (!app) return false;
      return Boolean(sendWithLong(app, selector('activateWithOptions:'), ACTIVATE_IGNORING_OTHERS));
    },

    modifiersUp() {
      const flags = Number(CGEventSourceFlagsState(COMBINED_SESSION_STATE));
      return [FLAG_SHIFT, FLAG_CONTROL, FLAG_OPTION, FLAG_COMMAND].every((flag) => Math.floor(flags / flag) % 2 === 0);
    },

    clipboardStamp() {
      const pasteboard = sendForObject(objc_getClass('NSPasteboard'), selector('generalPasteboard'));
      return Number(sendForLong(pasteboard, selector('changeCount')));
    },

    pressCopy: () => press(KEY_C, FLAG_COMMAND),
    pressPaste: () => press(KEY_V, FLAG_COMMAND),
    pressSelectAll: () => press(KEY_A, FLAG_COMMAND),
  };
}
