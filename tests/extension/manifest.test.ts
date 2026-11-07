import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { CATEGORIES } from '@engine/types';
import { HIGHLIGHT_CSS, highlightName, SENTENCE_HIGHLIGHT, UNDERLINE_COLORS } from '../../src/extension/content/styles';
import { buildManifest, ICON_SIZES } from '../../src/extension/manifest';
import { DEFAULT_SITE_MATCHES, isWebmailHost, sitePattern, unsupportedSurface } from '../../src/extension/shared/sites';

const manifest = buildManifest('1.2.3');

describe('the shipped manifest', () => {
  it('is Manifest V3 with the version it was given', () => {
    expect(manifest).toMatchObject({ manifest_version: 3, version: '1.2.3' });
  });

  it('asks up front only for webmail', () => {
    expect(manifest.host_permissions).toEqual([
      'https://outlook.office.com/*',
      'https://outlook.office365.com/*',
      'https://outlook.live.com/*',
      'https://outlook.cloud.microsoft/*',
      'https://mail.google.com/*',
    ]);
    expect(manifest.content_scripts[0].matches).toEqual(manifest.host_permissions);
  });

  it('never carries a test host', () => {
    expect(JSON.stringify(manifest)).not.toMatch(/localhost|127\.0\.0\.1|5341/);
  });

  it('leaves every other site to a grant from the writer', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  it('allows WebAssembly and cuts extension pages off from the network', () => {
    const policy = manifest.content_security_policy.extension_pages;
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).toContain("object-src 'self'");
    expect(policy).toContain("connect-src 'self'");
  });

  it('asks for no permission beyond what it uses', () => {
    expect(manifest.permissions.sort()).toEqual(['activeTab', 'offscreen', 'scripting', 'storage']);
  });
});

describe('sites', () => {
  it('knows the webmail hosts', () => {
    expect(isWebmailHost('mail.google.com')).toBe(true);
    expect(isWebmailHost('outlook.cloud.microsoft')).toBe(true);
    expect(isWebmailHost('mail.example.com')).toBe(false);
    expect(DEFAULT_SITE_MATCHES).toHaveLength(5);
  });

  it('grants one site at a time, on any port', () => {
    expect(sitePattern(new URL('https://forum.example.com/t/1?x=2'))).toBe('https://forum.example.com/*');
    expect(sitePattern(new URL('http://intranet:8080/wiki'))).toBe('http://intranet/*');
  });

  it('offers no grant for browser pages and files', () => {
    expect(sitePattern(new URL('chrome://extensions'))).toBeNull();
    expect(sitePattern(new URL('file:///C:/notes.html'))).toBeNull();
  });

  it('is plain about surfaces that cannot be underlined', () => {
    expect(unsupportedSurface(new URL('https://docs.google.com/document/d/abc/edit'))).toContain('canvas');
    expect(unsupportedSurface(new URL('https://word.cloud.microsoft/open'))).toContain('Word');
    expect(unsupportedSurface(new URL('https://word-edit.officeapps.live.com/we/wordeditorframe.aspx'))).toContain('Word');
    expect(unsupportedSurface(new URL('https://word.online.office.com/open'))).toContain('Word');
    expect(unsupportedSurface(new URL('https://docs.google.com/spreadsheets/d/abc'))).toBeNull();
    expect(unsupportedSurface(new URL('https://example.com/document/'))).toBeNull();
  });
});

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('underline styles', () => {
  it('has a rule for every highlight the painter registers', () => {
    for (const name of [...CATEGORIES.map(highlightName), SENTENCE_HIGHLIGHT]) {
      expect(HIGHLIGHT_CSS).toContain(`::highlight(${name})`);
    }
  });
});

describe('underline colors', () => {
  // White, Outlook's page grey, and the dark greys of Gmail and Outlook.
  it.each(['#ffffff', '#faf9f8', '#292929', '#1f1f1f', '#111111'])('stand out on %s', (background) => {
    for (const category of CATEGORIES) {
      expect(contrast(UNDERLINE_COLORS[category], background)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('icons', () => {
  const iconFile = (size: number) => readFileSync(new URL(`../../src/extension/assets/icon-${size}.png`, import.meta.url));

  /** Width, height, and RGBA rows of a PNG the icon script made. */
  function decode(png: Buffer) {
    const size = png.readUInt32BE(16);
    const start = png.indexOf('IDAT') + 4;
    const raw = inflateSync(png.subarray(start, start + png.readUInt32BE(start - 8)));
    const pixel = (x: number, y: number) => {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      return [...raw.subarray(at, at + 4)];
    };
    return { size, pixel };
  }

  it.each(ICON_SIZES)('has a %i pixel PNG', (size) => {
    const png = iconFile(size);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(decode(png).size).toBe(size);
  });

  it('is a glowing W on a dark rounded tile', () => {
    const { pixel } = decode(iconFile(128));
    expect(pixel(0, 0)[3]).toBe(0);
    const [tileRed, , , tileAlpha] = pixel(64, 14);
    expect(tileAlpha).toBe(255);
    expect(tileRed).toBeLessThan(110);
    const [red, , blue] = pixel(30, 50);
    expect(red).toBeGreaterThan(220);
    expect(red).toBeGreaterThan(blue);
  });
});
