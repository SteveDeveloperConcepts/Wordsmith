/**
 * Windows system calls for Check Anywhere, made through koffi so that the app
 * needs no compiled addon of its own.
 *
 * koffi.view() must never be used here: in Electron 45 it aborts the whole main
 * process instead of throwing, as it needs external array buffers.
 */
import koffi from 'koffi';
import { friendlyAppName, type Native, type SourceWindow } from './native';

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;
const VK_A = 0x41;
const VK_C = 0x43;
const VK_V = 0x56;
const SW_RESTORE = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const MAX_PATH = 1024;
const MAX_CLASS_NAME = 256;

/** The classic console, Windows Terminal, and the terminals of Git for Windows and PuTTY. */
const TERMINAL_CLASSES = new Set(['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'mintty', 'PuTTY']);

export function createWindowsNative(): Native {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32_t',
    dy: 'int32_t',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
  const INPUT = koffi.struct('INPUT', {
    type: 'uint32_t',
    u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  });

  const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int size)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void *hwnd)');
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void *hwnd)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hwnd, int command)');
  const IsWindow = user32.func('bool __stdcall IsWindow(void *hwnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
  const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *name, int size)');
  const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)');
  const GetClipboardSequenceNumber = user32.func('uint32_t __stdcall GetClipboardSequenceNumber()');
  const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
  const GetCurrentProcessId = kernel32.func('uint32_t __stdcall GetCurrentProcessId()');
  const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)');
  const QueryFullProcessImageNameW = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)',
  );

  const inputSize = koffi.sizeof(INPUT);

  function press(...keys: number[]): void {
    const event = (wVk: number, dwFlags: number) => ({
      type: INPUT_KEYBOARD,
      u: { ki: { wVk, wScan: 0, dwFlags, time: 0, dwExtraInfo: 0 } },
    });
    const events = [...keys.map((key) => event(key, 0)), ...[...keys].reverse().map((key) => event(key, KEYEVENTF_KEYUP))];
    SendInput(events.length, events, inputSize);
  }

  function processOf(hwnd: unknown): { pid: number; thread: number } {
    const pid = [0];
    const thread = GetWindowThreadProcessId(hwnd, pid) as number;
    return { pid: pid[0], thread };
  }

  function programPath(pid: number): string | null {
    const process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!process) return null;
    try {
      const name = new Uint16Array(MAX_PATH);
      const size = [MAX_PATH];
      if (!QueryFullProcessImageNameW(process, 0, name, size)) return null;
      return String.fromCharCode(...name.subarray(0, size[0]));
    } finally {
      CloseHandle(process);
    }
  }

  function classOf(hwnd: unknown): string {
    const name = new Uint16Array(MAX_CLASS_NAME);
    const length = GetClassNameW(hwnd, name, MAX_CLASS_NAME) as number;
    return String.fromCharCode(...name.subarray(0, length));
  }

  const keyDown = (key: number) => ((GetAsyncKeyState(key) as number) & 0x8000) !== 0;

  return {
    frontmost(): SourceWindow | null {
      const handle = GetForegroundWindow();
      if (!handle) return null;
      return {
        name: friendlyAppName(programPath(processOf(handle).pid)),
        handle,
        terminal: TERMINAL_CLASSES.has(classOf(handle)),
      };
    },

    isFrontmost: (source) => GetForegroundWindow() === source.handle,

    isOwn: (source) => processOf(source.handle).pid === GetCurrentProcessId(),

    focus(source) {
      const hwnd = source.handle;
      if (!IsWindow(hwnd)) return false;
      if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
      if (SetForegroundWindow(hwnd) && GetForegroundWindow() === hwnd) return true;

      // The system refuses focus changes from background apps. Sharing the input
      // state of the app in front is the supported way around that for a tool the
      // writer has just asked to act.
      const ours = GetCurrentThreadId() as number;
      const front = GetForegroundWindow();
      const theirs = front ? processOf(front).thread : 0;
      const attached = theirs !== 0 && theirs !== ours && Boolean(AttachThreadInput(ours, theirs, true));
      try {
        BringWindowToTop(hwnd);
        return Boolean(SetForegroundWindow(hwnd));
      } finally {
        if (attached) AttachThreadInput(ours, theirs, false);
      }
    },

    modifiersUp: () => ![VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN].some(keyDown),

    clipboardStamp: () => GetClipboardSequenceNumber() as number,

    pressCopy: () => press(VK_CONTROL, VK_C),
    pressPaste: () => press(VK_CONTROL, VK_V),
    pressSelectAll: () => press(VK_CONTROL, VK_A),
  };
}
