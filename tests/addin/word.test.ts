/// <reference types="office-js" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Fix, Issue } from '@engine/types';
import type { Host } from '../../src/addin/hosts/types';
import { createWordHost } from '../../src/addin/hosts/word';
import { anchorFor, cleanText, escapeQuery, MAX_QUERY, pickMatch, planSearch } from '../../src/addin/hosts/word-find';
import { installFakeOffice, type FakeConfig, type FakeHandles } from './fake-office.mjs';

afterEach(() => vi.unstubAllGlobals());

function setUp(word: NonNullable<FakeConfig['word']>, unsupported: string[] = []): { fake: FakeHandles; host: Host } {
  const globals: { Office?: unknown; Word?: unknown } = {};
  const fake = installFakeOffice(globals, { host: 'Word', word, unsupported });
  vi.stubGlobal('Office', globals.Office);
  vi.stubGlobal('Word', globals.Word);
  return { fake, host: createWordHost() };
}

/** An issue on the nth occurrence of `find` in a paragraph, the way the engine reports one. */
function issueOn(text: string, find: string, replacement: string, block = 0, nth = 0): { issue: Issue; fix: Fix } {
  let from = -1;
  for (let i = 0; i <= nth; i++) from = text.indexOf(find, from + 1);
  expect(from, `"${find}" occurrence ${nth} should be in the text`).toBeGreaterThanOrEqual(0);
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
    text: cleanText(text).slice(from, to),
    fixes: [fix],
    sentenceLevel: false,
    sentence: { from: 0, to: text.length },
  };
  return { issue, fix };
}

describe('escapeQuery', () => {
  it('turns characters Word treats specially into its notation', () => {
    expect(escapeQuery('100^2')).toBe('100^^2');
    expect(escapeQuery('a\tb\vc')).toBe('a^tb^lc');
    expect(escapeQuery('a b')).toBe('a^sb');
    expect(escapeQuery('non\u001Ebreaking\u001Fhyphen')).toBe('non^~breaking^-hyphen');
  });

  it('leaves ordinary punctuation alone', () => {
    expect(escapeQuery('What? (yes) *really* [no] 50%')).toBe('What? (yes) *really* [no] 50%');
  });
});

describe('cleanText', () => {
  it('keeps the length, so offsets carry across unchanged', () => {
    const raw = 'One two\vthree\u0002four\u001Efive�';
    expect(cleanText(raw)).toHaveLength(raw.length);
    expect(cleanText(raw)).toBe('One two\nthree￼four-five￼');
  });
});

describe('planSearch', () => {
  it('uses one term for text that fits', () => {
    const plan = planSearch('Some words here', 5, 10);
    expect(plan?.terms).toHaveLength(1);
    expect(plan?.terms[0]).toMatchObject({ raw: 'words', query: 'words', start: 5 });
  });

  it('splits text over the limit into a first and a last term', () => {
    const text = 'x'.repeat(600);
    const [first, last] = planSearch(text, 10, 500)?.terms ?? [];
    expect(first.start).toBe(10);
    expect(last.start + last.raw.length).toBe(500);
    expect(first.query.length).toBeLessThanOrEqual(MAX_QUERY);
    expect(last.query.length).toBeLessThanOrEqual(MAX_QUERY);
  });

  it('counts the limit after escaping', () => {
    const plan = planSearch('^'.repeat(200), 0, 200);
    expect(plan?.terms).toHaveLength(2);
    for (const term of plan?.terms ?? []) expect(term.query.length).toBeLessThanOrEqual(MAX_QUERY);
  });

  it('never cuts a surrogate pair in half', () => {
    const text = `${'a'.repeat(254)}😀${'b'.repeat(300)}`;
    const plan = planSearch(text, 0, text.length);
    expect(plan?.terms[0].raw.endsWith('\uD83D')).toBe(false);
  });

  it('works around an object in the middle, and trims one at the edge', () => {
    const text = 'before\u0002after';
    expect(planSearch(text, 0, text.length)?.terms.map((term) => term.raw)).toEqual(['before', 'after']);
    expect(planSearch(text, 6, text.length)).toMatchObject({ from: 7, to: text.length });
    expect(planSearch('\u0002', 0, 1)).toBeNull();
  });
});

describe('pickMatch', () => {
  const term = (raw: string, start: number) => ({ raw, query: raw, start });

  it('finds the nth match from the text', () => {
    expect(pickMatch('the cat and the dog', term('the', 12), ['the', 'the'])).toBe(1);
  });

  it('accepts the extra matches folded characters add', () => {
    const text = 'don’t and don\'t';
    expect(pickMatch(text, term("don't", 10), ['don’t', "don't"])).toBe(1);
  });

  it('refuses when a match is missing, rather than taking the wrong one', () => {
    expect(pickMatch('the cat and the dog', term('the', 12), ['the'])).toBe(-1);
  });

  it('refuses when the matches do not line up with the text', () => {
    expect(pickMatch('the cat', term('the', 0), ['The'])).toBe(-1);
  });
});

describe('anchorFor', () => {
  it('widens to the whole word', () => {
    expect(anchorFor('a mistaken word', 5, 6)).toEqual({ from: 2, to: 10 });
  });

  it('leans on the word before an insertion between spaces', () => {
    expect(anchorFor('one  two', 4, 4)).toEqual({ from: 0, to: 4 });
  });

  it('leans on the word after when there is nothing before', () => {
    expect(anchorFor('  two', 1, 1)).toEqual({ from: 1, to: 5 });
  });

  it('gives up on blank text', () => {
    expect(anchorFor('   ', 1, 1)).toBeNull();
  });
});

describe('reading', () => {
  it('labels paragraphs by what they are', async () => {
    const { host } = setUp({
      paragraphs: [
        { text: 'A title', styleBuiltIn: 'Title' },
        { text: 'A heading', styleBuiltIn: 'Heading2' },
        { text: 'Custom heading', outlineLevel: 3 },
        { text: 'Plain text.' },
        { text: 'A list item', isListItem: true },
        { text: 'A cell', tableNestingLevel: 1 },
        { text: 'A contents line', styleBuiltIn: 'Toc1' },
        { text: 'As they said', styleBuiltIn: 'IntenseQuote' },
      ],
    });
    const { blocks } = await host.read();
    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'heading',
      'heading',
      'paragraph',
      'list',
      'list',
      'code',
      'quote',
    ]);
  });

  it('keeps empty paragraphs, so block numbers match paragraph numbers', async () => {
    const { host } = setUp({ paragraphs: ['One', '', 'Three'] });
    expect((await host.read()).blocks.map((block) => block.text)).toEqual(['One', '', 'Three']);
  });

  it('asks the writer for a newer Word when the API is missing', async () => {
    const { host } = setUp({ paragraphs: ['One'] }, ['WordApi 1.3']);
    expect((await host.read()).empty).toBe('Wordsmith needs Word 2016 or later.');
  });

  it('says when fixes will be tracked, and when tracked changes are present', async () => {
    const { host } = setUp({
      changeTrackingMode: 'TrackAll',
      paragraphs: [{ text: 'Some text.', revisions: [[0, 4]] }],
    });
    expect((await host.read()).notices.map((notice) => notice.id)).toEqual(['tracking', 'revisions']);
  });

  it('runs without the tracked change API on older clients', async () => {
    const { host } = setUp({ paragraphs: ['Some text.'] }, ['WordApi 1.4', 'WordApi 1.6']);
    expect((await host.read()).notices).toEqual([]);
  });

  it('notices a change through the fingerprint', async () => {
    const { fake, host } = setUp({ paragraphs: ['One'] });
    const first = await host.fingerprint();
    expect(await host.fingerprint()).toBe(first);
    fake.word.paragraphs[0].text = 'Two';
    expect(await host.fingerprint()).not.toBe(first);
  });
});

describe('applying a fix', () => {
  it('replaces only the characters that changed', async () => {
    const text = 'Please read teh report.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.word.paragraphs[0].text).toBe('Please read the report.');
    expect(fake.word.log).toEqual([{ op: 'Replace', before: 'eh', text: 'he' }]);
  });

  it('keeps mixed formatting inside the word', async () => {
    const text = 'recieve it';
    const { fake, host } = setUp({ paragraphs: [{ text, bold: [[0, 3]] }] });
    await host.read();
    const { issue, fix } = issueOn(text, 'recieve', 'receive');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('receive it');
    // "rec" stays bold and the rest stays plain, which replacing the whole word could not do.
    expect(fake.word.paragraphs[0].bold.slice(0, 3)).toEqual([true, true, true]);
    expect(fake.word.paragraphs[0].bold.slice(3, 7)).toEqual([false, false, false, false]);
  });

  it('touches the right one of several repeated words', async () => {
    const text = 'teh first, teh second, teh third';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the', 0, 1);
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('teh first, the second, teh third');
  });

  it('is not fooled by the word inside a longer word', async () => {
    const text = 'theatre and teh other';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('theatre and the other');
  });

  it('counts matches case by case', async () => {
    const text = 'Teh start and teh end';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('Teh start and the end');
  });

  it('handles search notation in the text', async () => {
    const text = '2^10 is teh^answer';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh^answer', 'the^answer');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('2^10 is the^answer');
  });

  it('handles tabs and line breaks next to the word', async () => {
    const text = 'One\tteh\vtwo';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('One\tthe\vtwo');
  });

  it('copes with matches that only differ by a curly quote', async () => {
    const text = "don’t stop, don't stop";
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, "don't", 'do not');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('don’t stop, do not stop');
  });

  it('keeps a non-breaking space the fix did not mean to change', async () => {
    const text = 'Dr. Smith recieved it';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'recieved', 'received');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('Dr. Smith received it');
  });

  it('places a fix deep in a very long paragraph', async () => {
    const text = `${'A long sentence goes on and on. '.repeat(60)}Finally teh end.`;
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text.endsWith('Finally the end.')).toBe(true);
  });

  it('places a change longer than Word can search for', async () => {
    const clause = `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')} `;
    const text = `Keep this, ${clause}and keep this.`;
    expect(clause.length).toBeGreaterThan(MAX_QUERY);
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, clause, '');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('Keep this, and keep this.');
  });

  it('reports rather than guesses when long text repeats itself, so matches overlap', async () => {
    const clause = 'this clause goes round and round and never ends, '.repeat(8);
    const text = `Keep this, ${clause}and keep this.`;
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, clause, '');
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.word.paragraphs[0].text).toBe(text);
  });

  it('inserts at the end of a word', async () => {
    const text = 'However we left.';
    const { fake, host } = setUp({ paragraphs: [{ text, bold: [[0, 7]] }] });
    await host.read();
    const { issue } = issueOn(text, 'However', 'However');
    await host.apply(issue, { label: ',', from: 7, to: 7, text: ',' });
    expect(fake.word.paragraphs[0].text).toBe('However, we left.');
    expect(fake.word.log).toEqual([{ op: 'End', before: '', text: ',' }]);
    expect(fake.word.paragraphs[0].bold[7]).toBe(true);
  });

  it('inserts inside a word', async () => {
    const text = 'alot of it';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'alot', 'a lot');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('a lot of it');
  });

  it('inserts at the very start of a paragraph', async () => {
    const text = 'quiet start';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue } = issueOn(text, 'quiet', 'quiet');
    await host.apply(issue, { label: 'Add', from: 0, to: 0, text: 'A ' });
    expect(fake.word.paragraphs[0].text).toBe('A quiet start');
    expect(fake.word.log[0].op).toBe('Start');
  });

  it('deletes without leaving anything behind', async () => {
    const text = 'It is very very good.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'very ', '');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('It is very good.');
    expect(fake.word.log[0].op).toBe('Delete');
  });

  it('applies a fix that changes two separate words', async () => {
    const text = 'Their is alot here.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'Their is alot', 'There is a lot');
    await host.apply(issue, fix);
    expect(fake.word.paragraphs[0].text).toBe('There is a lot here.');
    expect(fake.word.log).toHaveLength(2);
  });
});

describe('text that changed since the check', () => {
  it('changes nothing when the paragraph was edited', async () => {
    const text = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    fake.word.paragraphs[0].text = 'Read teh new report.';
    const { issue, fix } = issueOn(text, 'teh', 'the');
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.word.paragraphs[0].text).toBe('Read teh new report.');
    expect(fake.word.log).toEqual([]);
  });

  it('follows a paragraph that moved', async () => {
    const text = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: ['Intro.', text] });
    await host.read();
    fake.word.addParagraph('New first line.', 0);
    const { issue, fix } = issueOn(text, 'teh', 'the', 1);
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.word.paragraphs[2].text).toBe('Read the report.');
  });

  it('finds the right copy of a repeated paragraph after the text above it grew', async () => {
    const text = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: [text, text] });
    await host.read();
    // Paragraph 1 still says the same thing, but it is now the other copy.
    fake.word.addParagraph('New first line.', 0);
    const { issue, fix } = issueOn(text, 'teh', 'the', 1);
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.word.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      'New first line.',
      text,
      'Read the report.',
    ]);
  });

  it('gives up when a copy of the paragraph came or went', async () => {
    const text = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: [text, text] });
    await host.read();
    fake.word.paragraphs.shift();
    const { issue, fix } = issueOn(text, 'teh', 'the', 1);
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.word.log).toEqual([]);
  });

  it('turns down an issue from a check older than the last read', async () => {
    const before = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: [before] });
    await host.read();
    const { issue, fix } = issueOn(before, 'teh', 'the');
    fake.word.paragraphs[0].text = 'A much longer line now, reading teh report.';
    await host.read();
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.word.log).toEqual([]);
  });
});

describe('fragile text', () => {
  const blocked = async (spec: { text: string; find: string; replace: string; paragraph: object }, message: RegExp) => {
    const { fake, host } = setUp({ paragraphs: [{ text: spec.text, ...spec.paragraph }] });
    await host.read();
    const { issue, fix } = issueOn(spec.text, spec.find, spec.replace);
    const outcome = await host.apply(issue, fix);
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' });
    expect(outcome).toHaveProperty('message', expect.stringMatching(message));
    expect(fake.word.paragraphs[0].text).toBe(spec.text);
  };

  it('leaves link text alone', () =>
    blocked(
      { text: 'See teh guide.', find: 'teh', replace: 'the', paragraph: { links: [[4, 13, 'https://example.com']] } },
      /link/,
    ));

  it('leaves field results alone', () =>
    blocked({ text: 'Page teh one.', find: 'teh', replace: 'the', paragraph: { fields: [[5, 8]] } }, /field/));

  it('leaves text with a tracked change alone', () =>
    blocked({ text: 'Fix teh word.', find: 'teh', replace: 'the', paragraph: { revisions: [[4, 7]] } }, /tracked change/));

  it('still fixes text beside a link, field, or tracked change', async () => {
    const text = 'See the guide and teh rest.';
    const { fake, host } = setUp({
      paragraphs: [{ text, links: [[4, 13, 'https://example.com']], fields: [[0, 3]], revisions: [[14, 17]] }],
    });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.word.paragraphs[0].text).toBe('See the guide and the rest.');
  });

  it('fixes a word beside a footnote mark', async () => {
    const text = 'As teh\u0002 study shows.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    expect(await host.apply(issue, fix)).toEqual({ ok: true });
    expect(fake.word.paragraphs[0].text).toBe('As the\u0002 study shows.');
  });

  it('will not remove a footnote mark', async () => {
    const text = 'Keep\u0002 this.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue } = issueOn(text, 'Keep', 'Keep');
    const outcome = await host.apply(issue, { label: 'Remove', from: 0, to: 6, text: '' });
    expect(outcome).toMatchObject({ ok: false, kind: 'refused' });
    expect(fake.word.paragraphs[0].text).toBe(text);
  });

  it('reports rather than guesses when a tracked deletion hides a match', async () => {
    const text = 'teh old and teh new';
    const { fake, host } = setUp({ paragraphs: [{ text, deleted: [[0, 3]] }] });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the', 1);
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.word.paragraphs[0].text).toBe(text);
  });

  it('reports a read-only document in plain words', async () => {
    const text = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: [text], readOnly: true });
    await host.read();
    const { issue, fix } = issueOn(text, 'teh', 'the');
    expect(await host.apply(issue, fix)).toMatchObject({ ok: false, kind: 'failed', message: expect.stringContaining('read-only') });
    expect(fake.word.paragraphs[0].text).toBe(text);
  });
});

describe('selecting', () => {
  it('selects the flagged text, the right one of several', async () => {
    const text = 'teh first, teh second';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue } = issueOn(text, 'teh second', 'x');
    expect(await host.select(issue)).toEqual({ ok: true });
    expect(fake.word.selection).toBe('teh second');
  });

  it('selects a sentence too long to search for in one go', async () => {
    const text = `${'word '.repeat(120)}end`;
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue } = issueOn(text, text, 'x');
    expect(await host.select(issue)).toEqual({ ok: true });
    expect(fake.word.selection).toBe(text);
  });

  it('selects across a footnote mark', async () => {
    const text = 'Before the mark\u0002 and after it';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    const { issue } = issueOn(text, text, 'x');
    expect(await host.select(issue)).toEqual({ ok: true });
    expect(fake.word.selection).toBe(text);
  });

  it('asks for a re-check when the text has gone', async () => {
    const text = 'Read teh report.';
    const { fake, host } = setUp({ paragraphs: [text] });
    await host.read();
    fake.word.paragraphs[0].text = 'Something else.';
    const { issue } = issueOn(text, 'teh', 'the');
    expect(await host.select(issue)).toMatchObject({ ok: false, kind: 'stale' });
    expect(fake.word.selection).toBeNull();
  });
});

describe('dismissals', () => {
  it('are kept in the document', async () => {
    const { fake, host } = setUp({ paragraphs: ['One'] });
    expect(await host.loadDismissed()).toEqual([]);
    await host.saveDismissed(['rule:abc']);
    expect(fake.saved.count).toBe(1);
    expect(await host.loadDismissed()).toEqual(['rule:abc']);
  });
});
