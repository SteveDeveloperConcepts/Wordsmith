import { describe, expect, it } from 'vitest';
import { loadNative } from '../../src/main/anywhere/native';

const supported = process.platform === 'win32' || process.platform === 'darwin';

// The binding strings are only proved by calling them, so this runs on each platform in CI.
// Nothing here presses a key or changes focus.
describe.runIf(supported)('system calls', () => {
  it('load, and answer the read-only questions', async () => {
    const native = await loadNative();
    expect(native).not.toBeNull();
    if (!native) return;

    expect(native.clipboardStamp()).toBeTypeOf('number');
    expect(native.modifiersUp()).toBeTypeOf('boolean');

    const front = native.frontmost();
    if (front) {
      expect(native.isFrontmost(front)).toBeTypeOf('boolean');
      expect(native.isOwn(front)).toBeTypeOf('boolean');
    }
  });
});
