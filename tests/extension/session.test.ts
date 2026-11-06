// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeRequest, Block, Fix, Issue } from '@engine/types';
import type { Field, PlacedIssue } from '../../src/extension/content/field';
import { Session, type SessionHost } from '../../src/extension/content/session';
import type { AnalyzeReply } from '../../src/extension/shared/messages';

/** A field over plain strings, so a test can change the text underneath the session. */
class FakeField implements Field {
  readonly element = document.createElement('div');
  readonly multiline = true;
  /** What the page does with a replacement, or null to ignore it. */
  onReplace: ((from: number, to: number, text: string) => void) | null = (from, to, text) => {
    const [block] = this.texts;
    this.texts[0] = block.slice(0, from) + text + block.slice(to);
  };

  constructor(public texts: string[]) {}

  read(): Block[] {
    return this.texts.map((text) => ({ text, kind: 'paragraph' }));
  }

  rangeOf(block: number, from: number, to: number): Range {
    const text = document.createTextNode(this.texts[block]);
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    return range;
  }

  caret: number | undefined;

  caretBlock(): number | undefined {
    return this.caret;
  }

  async replace(_block: number, from: number, to: number, text: string): Promise<boolean> {
    if (!this.onReplace) return false;
    this.onReplace(from, to, text);
    return true;
  }

  hitTest(): PlacedIssue | null {
    return null;
  }

  sync(): void {}
  layout(): void {}
  suspend(): void {}
}

function issueFor(text: string, word: string, block = 0): Issue {
  const from = text.indexOf(word);
  const to = from + word.length;
  return {
    id: `id-${word}`,
    block,
    from,
    to,
    text: word,
    category: 'correctness',
    type: 'spelling',
    ruleId: 'test',
    title: 'Correct your spelling',
    message: '',
    fixes: [{ label: 'fix', from, to, text: 'fixed' }],
    sentenceLevel: false,
    sentence: { from: 0, to: text.length },
  };
}

/** Flags every word in `flagged` wherever the text still has it. */
function engine(flagged: string[]) {
  const requests: AnalyzeRequest[] = [];
  const host: SessionHost & { settingsVersion: number } = {
    settingsVersion: 0,
    analyze: async (_fieldId, request): Promise<AnalyzeReply> => {
      requests.push(request);
      const issues = request.blocks.flatMap(({ text }, block) =>
        flagged.filter((word) => text.includes(word)).map((word) => issueFor(text, word, block)),
      );
      return { status: 'done', issues, grammarEngineReady: true };
    },
    changed: vi.fn(),
  };
  return { host, requests };
}

const settle = () => vi.advanceTimersByTimeAsync(600);

describe('a check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('places what the engine finds', async () => {
    const { host } = engine(['wrold']);
    const session = new Session(new FakeField(['Hello wrold.']), host);
    session.resume();
    await settle();
    expect(session.placed.map(({ issue }) => issue.text)).toEqual(['wrold']);
    expect(session.placed[0].blockText).toBe('Hello wrold.');
  });

  it('does not ask again about text it has already checked', async () => {
    const { host, requests } = engine(['wrold']);
    const session = new Session(new FakeField(['Hello wrold.']), host);
    session.resume();
    await settle();
    session.resume();
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('asks again when settings change, even with the same text', async () => {
    const { host, requests } = engine(['wrold']);
    const session = new Session(new FakeField(['Hello wrold.']), host);
    session.resume();
    await settle();
    host.settingsVersion++;
    session.resume();
    await settle();
    expect(requests).toHaveLength(2);
  });

  it('keeps an unchanged issue the same across checks, so an open card stays open', async () => {
    const { host } = engine(['wrold']);
    const session = new Session(new FakeField(['Hello wrold.']), host);
    session.resume();
    await settle();
    const [before] = session.placed;
    host.settingsVersion++;
    session.resume();
    await settle();
    expect(session.placed[0]).toBe(before);
  });

  it('places an issue anew when its block moved', async () => {
    const field = new FakeField(['Hello wrold.']);
    const { host } = engine(['wrold']);
    const session = new Session(field, host);
    session.resume();
    await settle();
    const [before] = session.placed;
    field.texts = ['New first line.', 'Hello wrold.'];
    session.resume();
    await settle();
    expect(session.placed[0]).not.toBe(before);
    expect(session.placed[0].issue.block).toBe(1);
  });

  it('drops a reply for text that changed while it was being checked', async () => {
    const field = new FakeField(['Hello wrold.']);
    const { host } = engine(['wrold']);
    const analyze = host.analyze.bind(host);
    host.analyze = async (id, request) => {
      field.texts[0] = 'Hello there wrold.';
      return analyze(id, request);
    };
    const session = new Session(field, host);
    session.resume();
    await settle();
    expect(session.placed).toEqual([]);
  });

  it('keeps issues in blocks that did not change while one block did', async () => {
    const field = new FakeField(['One wrold.', 'Two wrold.']);
    const { host } = engine(['wrold']);
    const analyze = host.analyze.bind(host);
    host.analyze = async (id, request) => {
      field.texts[1] = 'Two words.';
      return analyze(id, request);
    };
    const session = new Session(field, host);
    session.resume();
    await settle();
    expect(session.placed.map(({ blockText }) => blockText)).toEqual(['One wrold.']);
  });

  it('ignores a request that a newer one overtook', async () => {
    const field = new FakeField(['Hello wrold.']);
    const { host } = engine(['wrold']);
    const replies: Array<(reply: AnalyzeReply) => void> = [];
    host.analyze = () => new Promise((resolve) => replies.push(resolve));
    const session = new Session(field, host);
    session.resume();
    await settle();
    field.texts[0] = 'Hello there.';
    session.textChanged();
    await settle();
    expect(replies).toHaveLength(2);
    replies[0]({ status: 'done', grammarEngineReady: true, issues: [issueFor('Hello wrold.', 'wrold')] });
    await settle();
    expect(session.placed).toEqual([]);
  });

  it('says so when the engine fails, and tries again on the next change', async () => {
    const field = new FakeField(['Hello wrold.']);
    const { host, requests } = engine(['wrold']);
    const working = host.analyze.bind(host);
    host.analyze = async () => ({ status: 'failed', message: 'no engine' });
    const session = new Session(field, host);
    session.resume();
    await settle();
    expect(session.notice).toContain('could not start');

    host.analyze = working;
    session.resume();
    await settle();
    expect(requests).toHaveLength(1);
    expect(session.notice).toBeNull();
  });

  it('says so when only the basic checks are running', async () => {
    const { host } = engine([]);
    const analyze = host.analyze.bind(host);
    host.analyze = async (id, request) => {
      const reply = await analyze(id, request);
      return reply?.status === 'done' ? { ...reply, grammarEngineReady: false } : reply;
    };
    const session = new Session(new FakeField(['Hello.']), host);
    session.resume();
    await settle();
    expect(session.notice).toContain('basic checks');
  });

  it('checks again when the caret leaves a block, and not while it stays', async () => {
    const field = new FakeField(['One.', 'Two.']);
    field.caret = 0;
    const { host, requests } = engine([]);
    const session = new Session(field, host);
    session.resume();
    await settle();
    session.caretMoved();
    await settle();
    expect(requests).toHaveLength(1);

    field.caret = 1;
    session.caretMoved();
    await settle();
    expect(requests.map(({ caretBlock }) => caretBlock)).toEqual([0, 1]);
  });

  it('does not let the caret hurry a check that is waiting for typing to stop', async () => {
    const field = new FakeField(['One.', 'Two.']);
    const { host, requests } = engine([]);
    const session = new Session(field, host);
    session.textChanged();
    field.caret = 1;
    session.caretMoved();
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(0);
    await settle();
    expect(requests).toHaveLength(1);
  });

  it('sends dismissed issues with the next check', async () => {
    const { host, requests } = engine(['wrold']);
    const session = new Session(new FakeField(['Hello wrold.']), host);
    session.resume();
    await settle();
    session.dismiss(session.placed[0]);
    expect(session.placed).toEqual([]);
    host.settingsVersion++;
    session.resume();
    await settle();
    expect(requests.at(-1)?.dismissed).toEqual(['id-wrold']);
  });
});

describe('applying a fix', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function ready(texts: string[], flagged = ['wrold']) {
    const field = new FakeField(texts);
    const { host, requests } = engine(flagged);
    const session = new Session(field, host);
    session.resume();
    await settle();
    return { field, session, requests };
  }

  const apply = async (session: Session, placed: PlacedIssue, fix: Fix) => {
    const result = session.apply(placed, fix);
    await vi.advanceTimersByTimeAsync(100);
    return result;
  };

  it('replaces the text and checks again', async () => {
    const { field, session, requests } = await ready(['Hello wrold.']);
    const [placed] = session.placed;
    expect(await apply(session, placed, placed.issue.fixes[0])).toBe('applied');
    expect(field.texts).toEqual(['Hello fixed.']);
    await settle();
    expect(requests.at(-1)?.blocks[0].text).toBe('Hello fixed.');
  });

  it('refuses to touch a block that changed, and drops its issues', async () => {
    const { field, session } = await ready(['Hello wrold.', 'Another wrold.']);
    const [placed] = session.placed;
    field.texts[0] = 'Hello wrold, again.';
    const replace = vi.spyOn(field, 'replace');

    expect(await apply(session, placed, placed.issue.fixes[0])).toBe('stale');
    expect(replace).not.toHaveBeenCalled();
    expect(field.texts[0]).toBe('Hello wrold, again.');
    expect(session.placed.map(({ blockText }) => blockText)).not.toContain('Hello wrold.');
  });

  it('keeps issues in other blocks while one is fixed', async () => {
    const { session } = await ready(['Hello wrold.', 'Another wrold.']);
    const [placed] = session.placed;
    const pending = session.apply(placed, placed.issue.fixes[0]);
    expect(session.placed.map(({ issue }) => issue.block)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  });

  it('reports an editor that ignored the change, and brings the underline back', async () => {
    const { field, session } = await ready(['Hello wrold.']);
    const [placed] = session.placed;
    field.onReplace = () => undefined;

    expect(await apply(session, placed, placed.issue.fixes[0])).toBe('refused');
    await settle();
    expect(session.placed.map(({ issue }) => issue.text)).toEqual(['wrold']);
  });

  it('calls it stale when the page did something other than the fix', async () => {
    const { field, session } = await ready(['Hello wrold.']);
    const [placed] = session.placed;
    field.onReplace = () => {
      field.texts[0] = 'Something else entirely.';
    };
    expect(await apply(session, placed, placed.issue.fixes[0])).toBe('stale');
  });

  it('brings an underline back when an undo restores the text straight after a fix', async () => {
    const { field, session } = await ready(['Hello wrold.']);
    const [placed] = session.placed;
    const pending = session.apply(placed, placed.issue.fixes[0]);
    field.texts[0] = 'Hello wrold.';
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    await settle();
    expect(session.placed.map(({ issue }) => issue.text)).toEqual(['wrold']);
  });

  it('accepts a fix the browser spaced with a non-breaking space', async () => {
    const { field, session } = await ready(['Hello wrold.']);
    const [placed] = session.placed;
    field.onReplace = () => {
      field.texts[0] = 'Hello fixed.';
    };
    expect(await apply(session, placed, placed.issue.fixes[0])).toBe('applied');
  });
});
