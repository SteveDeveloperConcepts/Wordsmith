/// <reference types="office-js" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fix, Issue } from '@engine/types';
import { createSelectionHost } from '../../src/addin/hosts/selection';
import type { Host, Snapshot } from '../../src/addin/hosts/types';
import { installFakeOffice, type FakeConfig, type FakeHandles } from './fake-office.mjs';

afterEach(() => vi.unstubAllGlobals());

function setUp(
  kind: 'powerpoint' | 'excel',
  selection: NonNullable<FakeConfig['selection']>,
  unsupported: string[] = [],
): { fake: FakeHandles; host: Host } {
  const globals: { Office?: unknown; Excel?: unknown } = {};
  const fake = installFakeOffice(globals, { host: kind === 'excel' ? 'Excel' : 'PowerPoint', selection, unsupported });
  vi.stubGlobal('Office', globals.Office);
  vi.stubGlobal('Excel', globals.Excel);
  return { fake, host: createSelectionHost(kind) };
}

function fixFor(snapshot: Snapshot, find: string, replacement: string): { issue: Issue; fix: Fix } {
  const block = snapshot.blocks.findIndex((candidate) => candidate.text.includes(find));
  const from = snapshot.blocks[block].text.indexOf(find);
  const to = from + find.length;
  const fix: Fix = { label: replacement, from, to, text: replacement };
  const issue: Issue = {
    id: 'rule:1',
    block,
    from,
    to,
    category: 'correctness',
    type: 'spelling',
    ruleId: 'rule',
    title: 'Fix this',
    message: '',
    text: find,
    fixes: [fix],
    sentenceLevel: false,
    sentence: { from: 0, to },
  };
  return { issue, fix };
}

describe('PowerPoint', () => {
  it('waits to be asked, and cannot select', () => {
    const { host } = setUp('powerpoint', {});
    expect(host.live).toBe(false);
    expect(host.canSelect).toBe(false);
  });

  it('checks each line of the selection', async () => {
    const { host } = setUp('powerpoint', { text: 'First line\rSecond line\vThird line' });
    expect((await host.read()).blocks.map((block) => block.text)).toEqual(['First line', 'Second line', 'Third line']);
  });

  it('asks for a selection when there is none', async () => {
    const { host } = setUp('powerpoint', { text: '' });
    expect((await host.read()).empty).toContain('Select some text');
  });

  it('treats a selection it cannot read as no selection', async () => {
    const { host } = setUp('powerpoint', { failRead: true });
    expect((await host.read()).empty).toContain('Select some text');
  });

  it('warns that a fix replaces the whole selection', async () => {
    const { host } = setUp('powerpoint', { text: 'Some text' });
    expect((await host.read()).notices[0].text).toContain('whole selection');
  });

  it('applies a fix to the right line and keeps the line breaks', async () => {
    const { fake, host } = setUp('powerpoint', { text: 'First line\rSecond teh line\rThird' });
    const { issue, fix } = fixFor(await host.read(), 'teh', 'the');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.selection.text).toBe('First line\rSecond the line\rThird');
  });

  it('writes nothing if the selection moved', async () => {
    const { fake, host } = setUp('powerpoint', { text: 'Read teh report' });
    const { issue, fix } = fixFor(await host.read(), 'teh', 'the');
    fake.selection.text = 'Another shape';
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.selection.writes).toEqual([]);
  });

  it('keeps dismissals in the file', async () => {
    const { fake, host } = setUp('powerpoint', {});
    await host.saveDismissed(['rule:abc']);
    expect(fake.saved.count).toBe(1);
    expect(await host.loadDismissed()).toEqual(['rule:abc']);
  });
});

describe('Excel', () => {
  it('checks each cell of a multi-cell selection', async () => {
    const { host } = setUp('excel', { text: 'One cell\tAnother\nNext row\t' });
    const { blocks } = await host.read();
    expect(blocks.map((block) => block.text)).toEqual(['One cell', 'Another', 'Next row']);
    expect(blocks.every((block) => block.kind === 'list')).toBe(true);
  });

  it('applies a fix to one cell', async () => {
    const { fake, host } = setUp('excel', { text: 'Read teh report' });
    const { issue, fix } = fixFor(await host.read(), 'teh', 'the');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.selection.text).toBe('Read the report');
  });

  it('will not write across several cells', async () => {
    const { fake, host } = setUp('excel', { text: 'Read teh report\tAnother', cellCount: 2 });
    const { issue, fix } = fixFor(await host.read(), 'teh', 'the');
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'refused' });
    expect(fake.selection.writes).toEqual([]);
  });

  it('will not overwrite a formula with its value', async () => {
    const { fake, host } = setUp('excel', { text: 'Read teh report', formula: '=A1&" report"' });
    const { issue, fix } = fixFor(await host.read(), 'teh', 'the');
    expect(await host.apply(issue, fix)).toMatchObject({
      ok: false,
      kind: 'refused',
      message: expect.stringContaining('formula'),
    });
    expect(fake.selection.writes).toEqual([]);
  });

  it('still works where the Excel API is too old to ask', async () => {
    const { fake, host } = setUp('excel', { text: 'Read teh report' }, ['ExcelApi 1.4']);
    const { issue, fix } = fixFor(await host.read(), 'teh', 'the');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.selection.text).toBe('Read the report');
  });
});
