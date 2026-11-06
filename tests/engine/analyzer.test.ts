/**
 * The full analyzer: Harper's WebAssembly grammar engine plus Wordsmith's rules.
 */
import { describe, expect, it } from 'vitest';
import { applyFix, check, find, fixed, fullAnalyzer, paragraphs, rules } from '../helpers';

const analyzer = fullAnalyzer();

describe('grammar engine', () => {
  it('loads', async () => {
    await analyzer.warmUp();
    expect(analyzer.engineError).toBeUndefined();
    expect(analyzer.grammarEngineReady).toBe(true);
  });

  it.each([
    ['harper/AnA', 'This is an test.', 'This is a test.'],
    ['harper/SpellCheck', 'I love grammer.', 'I love grammar.'],
    ['harper/RepeatedWords', 'The cat sat on the the mat.', 'The cat sat on the mat.'],
    ['harper/ModalOf', 'I could of helped.', 'I could have helped.'],
    ['harper/PronounVerbAgreement', 'She have a car.', 'She has a car.'],
    ['harper/DidPast', "She didn't went home.", "She didn't go home."],
    ['harper/DiscourseMarkers', 'However we decided to go anyway.', 'However, we decided to go anyway.'],
    ['harper/OxfordComma', 'We bought apples, oranges, pears and plums.', 'We bought apples, oranges, pears, and plums.'],
    ['harper/Spaces', 'I like bananas .', 'I like bananas.'],
    ['harper/CapitalizePersonalPronouns', 'Then i left.', 'Then I left.'],
  ])('%s: %s', async (rule, input, expected) => {
    const result = await check(analyzer, input);
    expect(fixed(result, input, rule)).toBe(expected);
  });

  it('reports offsets in UTF-16 units, so text after an emoji still lines up', async () => {
    const text = '😀 She have a car.';
    const result = await check(analyzer, text);
    const issue = find(result, 'harper/PronounVerbAgreement');
    expect(issue?.text).toBe('have');
    expect(applyFix(text, issue!.fixes[0])).toBe('😀 She has a car.');
  });

  it('files findings under the right category and type', async () => {
    const result = await check(analyzer, 'I love grammer. It was very good, and i left.');
    expect(find(result, 'harper/SpellCheck')).toMatchObject({ category: 'correctness', type: 'spelling', word: 'grammer' });
    expect(find(result, 'harper/Excellent')).toMatchObject({ category: 'engagement', type: 'word-choice' });
  });
});

describe('clean prose stays quiet', () => {
  it.each([
    'Hi Maria, thanks for sending the report yesterday. I read it this morning, and the numbers look solid. Could we meet on Thursday at 3 p.m. to discuss the next steps?',
    'The study examined 240 participants over six months. Results indicate that regular exercise improves sleep quality, although the effect varies with age.',
    'Well... I guess so. "It\'s fine," she said, "but don\'t be late."',
    'Dr. Smith moved to the U.S. in 2010; since then, she has published twelve papers.',
    'Wordsmith checks grammar, spelling, and punctuation as you type — no internet connection required.',
    'My email is jane.doe@example.com and the site is https://example.com/docs?page=2.',
    'The CEO of OpenAI and the CTO of GitHub spoke at WWDC about JavaScript and macOS.',
    "It costs $5.99, or about 10% less than last year's price of $6.65.",
    'When I was young, I wanted to be a pilot. If it rains, we will stay home. As you know, I am busy.',
    "She couldn't believe it: the package had arrived two days early!",
  ])('%s', async (text) => {
    const result = await check(analyzer, text);
    expect(result.issues.map((i) => `${i.ruleId}: ${i.text}`)).toEqual([]);
  });
});

describe('merging the two sources', () => {
  it('prefers the exact hand-written fix over a spelling guess', async () => {
    const text = 'Can u send thx to them?';
    const result = await check(analyzer, text);
    expect(rules(result).filter((r) => r === 'harper/SpellCheck')).toEqual([]);
    expect(result.issues.filter((i) => i.ruleId === 'ws/informal').map((i) => i.fixes[0].label)).toEqual(['you', 'thanks']);
  });

  it('never returns two word-level findings on the same text', async () => {
    const text =
      'Its a state of the art system and their is alot of intrest, however we dont know weather it will work.';
    const result = await check(analyzer, text);
    const word = result.issues.filter((i) => !i.sentenceLevel);
    for (let a = 0; a < word.length; a++) {
      for (let b = a + 1; b < word.length; b++) {
        expect(word[a].to <= word[b].from || word[b].to <= word[a].from).toBe(true);
      }
    }
    expect(word.length).toBeGreaterThanOrEqual(6);
  });

  it('applying every first fix repeatedly converges on clean text', async () => {
    let text = 'Their is alot of reasons too go, and i could of went but i dont has time.';
    for (let round = 0; round < 12; round++) {
      const result = await check(analyzer, text);
      const next = result.issues.find((i) => i.category === 'correctness' && i.fixes.length > 0);
      if (!next) break;
      text = applyFix(text, next.fixes[0]);
    }
    const final = await check(analyzer, text);
    expect(final.issues.filter((i) => i.category === 'correctness')).toEqual([]);
    expect(text).toContain('a lot of');
    expect(text).toContain('could have');
  });
});

describe('settings reach the grammar engine', () => {
  it('skips words in the personal dictionary', async () => {
    const text = 'We deployed the frobnicator yesterday.';
    expect(rules(await check(analyzer, text))).toContain('harper/SpellCheck');
    const custom = fullAnalyzer({ dictionary: ['frobnicator'] });
    expect(rules(await check(custom, text))).not.toContain('harper/SpellCheck');
  });

  it('follows the chosen dialect', async () => {
    const text = 'I like the colour of your car.';
    expect(rules(await check(analyzer, text))).toContain('harper/SpellCheck');
    const british = fullAnalyzer({ dialect: 'british' });
    expect(rules(await check(british, text))).not.toContain('harper/SpellCheck');
  });

  it('turns off a single engine rule', async () => {
    const text = 'We bought apples, oranges, pears and plums.';
    const off = fullAnalyzer({ disabledRules: ['harper/OxfordComma'] });
    expect(rules(await check(off, text))).not.toContain('harper/OxfordComma');
  });

  it('flags contractions only in formal writing', async () => {
    const text = "We don't think the plan is ready for review.";
    expect(rules(await check(analyzer, text))).not.toContain('harper/AvoidContractions');
    const formal = fullAnalyzer({ goals: { audience: 'knowledgeable', formality: 'formal', domain: 'general', intent: 'inform' } });
    const result = await check(formal, text);
    expect(find(result, 'harper/AvoidContractions')).toMatchObject({ category: 'delivery', type: 'formality' });
  });
});

describe('score, counts, and statistics', () => {
  it('gives no score until there is enough text', async () => {
    expect((await check(analyzer, 'Too short to score.')).score).toBeNull();
  });

  it('scores clean text at 100 and lowers the score as errors accumulate', async () => {
    const clean =
      'The study examined 240 participants over six months. Results indicate that regular exercise improves sleep quality, although the effect varies with age.';
    const messy =
      'The studdy examined 240 participents over six months. Results indicates that regular excercise improve sleep quality, altho the affect vary with age.';
    const good = await check(analyzer, clean);
    const bad = await check(analyzer, messy);
    expect(good.score).toBe(100);
    expect(bad.score!).toBeLessThan(80);
    expect(bad.counts.total).toBe(bad.issues.length);
    expect(bad.counts.byCategory.correctness).toBeGreaterThanOrEqual(4);
    expect(Object.values(bad.counts.byType).reduce((a, b) => a + b, 0)).toBe(bad.counts.total);
  });

  it('returns statistics alongside the findings', async () => {
    const result = await analyzer.analyze({ blocks: paragraphs('One two three. Four five.\n\nSix seven eight nine.') });
    expect(result.stats).toMatchObject({ words: 9, sentences: 3, paragraphs: 2 });
    expect(result.grammarEngineReady).toBe(true);
  });
});
