// @vitest-environment happy-dom
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { documentToEml } from '@renderer/lib/handoff';

const content: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Café plans' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See you ' },
        { type: 'text', text: 'Friday', marks: [{ type: 'bold' }] },
      ],
    },
  ],
};

/** Split a message into its headers and its decoded parts. */
function parseEml(eml: string) {
  const [head, ...rest] = eml.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const parts = body
    .split('--wordsmith-boundary')
    .slice(1, -1)
    .map((part) => {
      const [headers, ...data] = part.trim().split('\r\n\r\n');
      return { headers, text: Buffer.from(data.join('').replace(/\s+/g, ''), 'base64').toString('utf8') };
    });
  return { head, parts };
}

describe('documentToEml', () => {
  it('opens as an unsent draft', () => {
    expect(parseEml(documentToEml('Plans', content)).head).toContain('X-Unsent: 1');
  });

  it('carries the document as text and as formatted HTML', () => {
    const { parts } = parseEml(documentToEml('Plans', content));
    expect(parts).toHaveLength(2);
    expect(parts[0].headers).toContain('text/plain');
    expect(parts[0].text).toContain('See you Friday');
    expect(parts[1].headers).toContain('text/html');
    expect(parts[1].text).toContain('<strong');
    expect(parts[1].text).toContain('Café plans');
  });

  it('keeps a plain subject readable, and encodes any other', () => {
    expect(parseEml(documentToEml('Plans for Friday', content)).head).toContain('Subject: Plans for Friday');
    const encoded = parseEml(documentToEml('Café plans', content)).head;
    expect(encoded).toContain(`Subject: =?UTF-8?B?${Buffer.from('Café plans').toString('base64')}?=`);
  });

  it('cannot be tricked into adding headers by a title with line breaks', () => {
    const { head } = parseEml(documentToEml('Plans\r\nBcc: someone@example.com', content));
    expect(head.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false);
  });

  it('keeps lines short enough for mail servers', () => {
    const long: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'word '.repeat(2000) }] }],
    };
    expect(documentToEml('Long', long).split('\r\n').every((line) => line.length <= 998)).toBe(true);
  });
});
