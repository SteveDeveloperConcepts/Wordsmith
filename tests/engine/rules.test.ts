/**
 * Wordsmith's own rules, run without the WebAssembly grammar engine so each
 * test exercises exactly one hand-written rule.
 */
import { describe, expect, it } from 'vitest';
import type { Goals } from '@engine/types';
import { applyFix, check, find, fixed, rules, rulesOnly } from '../helpers';

const analyzer = rulesOnly();

/** [rule, input, expected text after applying the rule's fix, optional fix index] */
const FIXES: Array<[rule: string, input: string, expected: string, option?: number]> = [
  // grammar and confused words
  ['ws/less-fewer', 'Our team has less projects this quarter.', 'Our team has fewer projects this quarter.'],
  ['ws/amount-number', 'The amount of people was high.', 'The number of people was high.'],
  ['ws/much-many', 'There was too much cars on the road.', 'There was too many cars on the road.'],
  ['ws/weather-whether', "I don't know weather it's good or not.", "I don't know whether it's good or not."],
  ['ws/your-youre', 'Your welcome to join us.', "You're welcome to join us."],
  ['ws/youre-your', "Thank you for you're help.", 'Thank you for your help.'],
  ['ws/its-contraction', 'I think its going to rain.', "I think it's going to rain."],
  ['ws/its-contraction', 'Its a nice day.', "It's a nice day."],
  ['ws/its-possessive', "The company lost it's purpose.", 'The company lost its purpose.'],
  ['ws/their-there', 'Their is a problem.', 'There is a problem.'],
  ['ws/there-their', 'They lost there car.', 'They lost their car.'],
  ['ws/whos-whose', "Who's book is this?", 'Whose book is this?'],
  ['ws/whose-whos', 'Whose going to the store?', "Who's going to the store?"],
  ['ws/seen-done', 'I seen him yesterday.', 'I saw him yesterday.'],
  ['ws/seen-done', 'She done the work.', 'She has done the work.', 1],
  ['ws/pronoun-was', 'We was late again.', 'We were late again.'],
  ['ws/there-is-plural', 'There is many reasons to stay.', 'There are many reasons to stay.'],
  ['ws/third-person-verb', 'It is short, and it make a better impression.', 'It is short, and it makes a better impression.'],
  ['ws/this-these', 'These is wrong.', 'These are wrong.'],
  ['ws/indefinite-pronoun-agreement', 'Everyone have a phone.', 'Everyone has a phone.'],
  ['ws/me-and-subject', 'Me and him went to the store.', 'He and I went to the store.'],
  ['ws/me-and-subject', 'Me and my sister like tea.', 'My sister and I like tea.'],
  ['ws/between-you-and-i', 'Between you and I, this is wrong.', 'Between you and me, this is wrong.'],
  ['ws/double-negative', "I don't know nothing about it.", "I don't know anything about it."],
  ['ws/hardly-negative', "I can't hardly wait.", 'I can hardly wait.'],
  ['ws/reason-is-because', 'The reason is because he was late.', 'The reason is that he was late.'],
  ['ws/could-care-less', 'I could care less about that.', "I couldn't care less about that."],
  ['ws/am-agree', 'I am agree with you.', 'I agree with you.'],
  ['ws/look-forward-to', 'I look forward to hear from you.', 'I look forward to hearing from you.'],
  ['ws/lets-contraction', 'Lets go to the park.', "Let's go to the park."],
  ['ws/double-comparative', 'This one is more better.', 'This one is better.'],
  ['ws/missing-apostrophe', 'I dont know.', "I don't know."],
  ['ws/capitalize-proper', 'She speaks french on monday.', 'She speaks French on monday.'],
  // punctuation
  ['ws/comma-splice', 'I went home, I was tired.', 'I went home; I was tired.'],
  ['ws/comma-splice', 'The weather was nice, we went outside for a walk.', 'The weather was nice. We went outside for a walk.', 1],
  ['ws/comma-splice', 'I went home, I was tired.', 'I went home, and I was tired.', 2],
  ['ws/missing-question-mark', 'What is your name.', 'What is your name?'],
  ['ws/missing-question-mark', 'Do you want to come with us.', 'Do you want to come with us?'],
  ['ws/date-comma', 'We met on January 5 2024 in Boston.', 'We met on January 5, 2024 in Boston.'],
  ['ws/repeated-punctuation', 'This is great!!', 'This is great!'],
  ['ws/quote-punctuation', 'He said "hello", and left.', 'He said "hello," and left.'],
  ['ws/comma-before-but', 'I wanted to go but I was too tired to drive.', 'I wanted to go, but I was too tired to drive.'],
  ['ws/compound-hyphen', 'She is a well known author.', 'She is a well-known author.'],
  ['ws/compound-hyphen', 'He has a 20 year old car.', 'He has a 20-year-old car.'],
  ['ws/space-before-punctuation', 'We shipped the product ; it works.', 'We shipped the product; it works.'],
  ['ws/space-after-punctuation', 'Hello,world is the classic.', 'Hello, world is the classic.'],
  ['ws/introductory-comma', 'For example the results were clear.', 'For example, the results were clear.'],
  ['ws/missing-end-punctuation', 'Thanks for all your help with the project today', 'Thanks for all your help with the project today.'],
  // clarity
  ['ws/wordy', 'In order to succeed, we must work.', 'To succeed, we must work.'],
  ['ws/wordy', 'We stayed home due to the fact that it rained.', 'We stayed home because it rained.'],
  ['ws/wordy', 'The majority of the students passed.', 'Most of the students passed.'],
  ['ws/wordy', 'The majority of students passed.', 'Most students passed.'],
  ['ws/wordy', 'We are in the process of moving.', 'We are moving.'],
  ['ws/wordy', 'It is important to note that prices rose.', 'Prices rose.'],
  ['ws/redundant', 'We must revert back to the plan.', 'We must revert to the plan.'],
  ['ws/redundant', 'It was an added bonus.', 'It was a bonus.'],
  ['ws/complex-word', 'We need to utilize the tools.', 'We need to use the tools.'],
  ['ws/filler', 'Basically, we need more time.', 'We need more time.'],
  ['ws/filler', 'It was a really unusual idea.', 'It was an unusual idea.'],
  // engagement
  ['ws/intensifier', 'It was a really big house.', 'It was a huge house.'],
  ['ws/intensifier', 'It was a really big house.', 'It was an enormous house.', 1],
  ['ws/cliche', 'At the end of the day, we need results.', 'Ultimately, we need results.'],
  // delivery
  ['ws/hedging', 'I think we should start now.', 'We should start now.'],
  ['ws/hedging', 'This is, to be honest, the wrong plan.', 'This is the wrong plan.'],
  ['ws/hedging', "It's kind of hard to explain.", "It's hard to explain."],
  ['ws/hedging', 'I was wondering if you could send the file.', 'Please send the file.'],
  ['ws/informal', 'I am gonna leave soon.', 'I am going to leave soon.'],
  ['ws/informal', 'Can u send it today?', 'Can you send it today?'],
  ['ws/inclusive', 'The chairman opened the meeting.', 'The chair opened the meeting.'],
  ['ws/inclusive', 'A policeman stopped us.', 'A police officer stopped us.'],
  ['ws/strong-language', 'This is damn stupid of them.', 'This is stupid of them.'],
  ['ws/all-caps', 'PLEASE READ THIS NOW before you go.', 'Please read this now before you go.'],
];

describe('fixes', () => {
  it.each(FIXES)('%s: %s', async (rule, input, expected, option = 0) => {
    const result = await check(analyzer, input);
    expect(fixed(result, input, rule, option)).toBe(expected);
  });
});

/** [rule that must NOT fire, input] */
const QUIET: Array<[rule: string, input: string]> = [
  ['ws/less-fewer', 'It costs less than last year.'],
  ['ws/less-fewer', 'We have less stress now.'],
  ['ws/less-fewer', 'The plan is less ambitious than before.'],
  ['ws/its-contraction', 'The dog wagged its tail.'],
  ['ws/its-contraction', 'The company cut its time to market.'],
  ['ws/your-youre', 'Bring your A game.'],
  ['ws/your-youre', 'Put out your welcome mat.'],
  ['ws/there-their', 'Are there children here?'],
  ['ws/double-negative', "I couldn't say no."],
  ['ws/double-negative', "I won't go no matter what."],
  ['ws/lets-contraction', 'He lets go of the rope.'],
  ['ws/seen-done', 'Have you seen it?'],
  ['ws/third-person-verb', 'Does it make sense to wait?'],
  ['ws/third-person-verb', 'We watched it happen and let it go.'],
  ['ws/third-person-verb', 'I suggest that he take the early train.'],
  ['ws/this-these', 'One of these is broken.'],
  ['ws/indefinite-pronoun-agreement', 'Does everyone have a phone?'],
  ['ws/comma-splice', 'When I got home, I was tired.'],
  ['ws/comma-splice', 'You know, I think it works.'],
  ['ws/comma-splice', 'The moment I saw her, I knew the answer.'],
  ['ws/comma-splice', 'I came, I saw, I conquered.'],
  ['ws/comma-splice', 'The plan is solid, I think.'],
  ['ws/comma-splice', 'After the meeting, we went home.'],
  ['ws/missing-question-mark', 'Do the right thing.'],
  ['ws/missing-question-mark', 'Should you need help, call us.'],
  ['ws/missing-question-mark', 'What you need is rest.'],
  ['ws/introductory-comma', 'However you look at it, the plan works.'],
  ['ws/introductory-comma', 'Thus far we have seen no issues.'],
  ['ws/comma-before-but', 'Everyone but I went home early today.'],
  ['ws/compound-hyphen', 'She works full time.'],
  ['ws/compound-hyphen', 'In the long term we will grow.'],
  ['ws/missing-end-punctuation', 'Quarterly Report'],
  ['ws/unmatched-bracket', 'That was fun :) and easy (really).'],
  ['ws/wordy', 'Read https://example.com/in-order-to-win today.'],
  ['ws/intensifier', 'It is not very good.'],
  ['ws/hedging', 'I think so.'],
  ['ws/hedging', 'What kind of car is that?'],
  ['ws/hedging', 'That is kind of you.'],
  ['ws/inclusive', 'The elderly man smiled at us.'],
  ['ws/inclusive', 'We met Chairman Powell yesterday.'],
  ['ws/informal', 'It dates from 500 BC.'],
  ['ws/fragment', 'Because of you I survived.'],
  ['ws/filler', 'Not really.'],
];

describe('no false positives', () => {
  it.each(QUIET)('%s stays quiet: %s', async (rule, input) => {
    const result = await check(analyzer, input);
    expect(rules(result)).not.toContain(rule);
  });
});

describe('sentence-level rules', () => {
  it('flags a sentence that is too long, across its whole range', async () => {
    const long =
      'The committee, which had met every week since the start of the year to review the budget, decided after a long and difficult debate that the proposal needed more work before anyone could vote on it.';
    const result = await check(analyzer, long);
    const issue = find(result, 'ws/long-sentence');
    expect(issue?.sentenceLevel).toBe(true);
    expect(issue?.text).toBe(long);
    expect(issue?.rewriteHint).toBeTruthy();
  });

  it('flags passive voice when the doer is named', async () => {
    const result = await check(analyzer, 'The report was written by the team.');
    expect(find(result, 'ws/passive-voice-agent')?.text).toBe('was written');
  });

  it('includes the helping verb in a passive phrase', async () => {
    const result = await check(analyzer, 'The files have been deleted by the script.');
    expect(find(result, 'ws/passive-voice-agent')?.text).toBe('have been deleted');
  });

  it('flags a fragment', async () => {
    const result = await check(analyzer, 'We left early. Because I was tired.');
    expect(find(result, 'ws/fragment')?.text).toBe('Because I was tired.');
  });

  it('flags a run-on chain of clauses', async () => {
    const result = await check(
      analyzer,
      'I went to the store and I bought milk and I came home and I cooked dinner.',
    );
    expect(rules(result)).toContain('ws/run-on');
  });

  it('flags three sentences in a row with the same opening word', async () => {
    const result = await check(analyzer, 'I like tea. I like coffee. I like juice too.');
    const issue = find(result, 'ws/repeated-opening');
    expect(issue?.from).toBe('I like tea. I like coffee. '.length);
  });

  it('lets a sentence-level issue coexist with a word-level one inside it', async () => {
    const text = 'We left early. Because I was really tired.';
    const result = await check(analyzer, text);
    expect(rules(result)).toEqual(expect.arrayContaining(['ws/fragment', 'ws/intensifier']));
    expect(find(result, 'ws/intensifier')?.text).toBe('really tired');
  });
});

describe('document-level rules', () => {
  it('flags a generic word that keeps recurring, after its first use', async () => {
    const text = [
      'The launch went well and the team did good work on the design.',
      'Customers gave good feedback about the new layout in the first week.',
      'We expect good results from the next release once the remaining bugs are fixed.',
      'The roadmap for the following quarter covers search, export, and sharing.',
      'Each of those features depends on the storage rewrite planned for early spring.',
      'After that, the focus shifts to performance on older devices and slower networks.',
    ].join('\n\n');
    const result = await check(analyzer, text);
    const overused = result.issues.filter((i) => i.ruleId === 'ws/overused-word');
    expect(overused).toHaveLength(2);
    expect(overused[0].block).toBe(1);
    expect(overused[0].fixes.length).toBeGreaterThan(0);
  });
});

describe('goals change which rules apply', () => {
  const withGoals = (goals: Partial<Goals>) => rulesOnly({ goals: goals as Goals });

  it('flags conversational wording only in formal writing', async () => {
    const text = 'We got a lot of feedback from the kids.';
    expect(rules(await check(analyzer, text))).not.toContain('ws/formal-wording');
    const formal = await check(withGoals({ formality: 'formal' }), text);
    expect(fixed(formal, text, 'ws/formal-wording')).toBe('We got many feedback from the kids.');
  });

  it('allows slang and hedging in casual writing', async () => {
    const text = 'I think we are gonna be late.';
    expect(rules(await check(analyzer, text))).toEqual(expect.arrayContaining(['ws/hedging', 'ws/informal']));
    const casual = await check(withGoals({ domain: 'casual' }), text);
    expect(rules(casual)).not.toContain('ws/hedging');
    expect(rules(casual)).not.toContain('ws/informal');
  });

  it('leaves passive voice and fragments alone in creative writing', async () => {
    const text = 'The door was opened by a stranger. Because nobody else would.';
    const creative = await check(withGoals({ domain: 'creative' }), text);
    expect(rules(creative)).not.toContain('ws/passive-voice-agent');
    expect(rules(creative)).not.toContain('ws/fragment');
  });

  it('softens demands in email', async () => {
    const text = 'You need to send the report today.';
    expect(rules(await check(analyzer, text))).not.toContain('ws/politeness');
    const email = await check(withGoals({ domain: 'email' }), text);
    expect(fixed(email, text, 'ws/politeness')).toBe('Please send the report today.');
  });

  it('raises the long-sentence threshold for expert readers', async () => {
    const sentence = `${Array.from({ length: 34 }, (_, i) => `word${i}`).join(' ')}.`;
    expect(rules(await check(analyzer, sentence))).toContain('ws/long-sentence');
    expect(rules(await check(withGoals({ audience: 'expert' }), sentence))).not.toContain('ws/long-sentence');
  });
});

describe('settings', () => {
  const text = 'In order to win, we must utilize every tool. I seen it work.';

  it('turns off a whole category', async () => {
    const result = await check(rulesOnly({ checks: { correctness: true, clarity: false, engagement: true, delivery: true } }), text);
    expect(result.issues.every((i) => i.category !== 'clarity')).toBe(true);
    expect(rules(result)).toContain('ws/seen-done');
  });

  it('turns off a single rule', async () => {
    const result = await check(rulesOnly({ disabledRules: ['ws/wordy'] }), text);
    expect(rules(result)).not.toContain('ws/wordy');
    expect(rules(result)).toContain('ws/complex-word');
  });

  it('keeps issue ids stable and honors dismissals', async () => {
    const first = await analyzer.analyze({ blocks: [{ text, kind: 'paragraph' }] });
    const second = await analyzer.analyze({ blocks: [{ text, kind: 'paragraph' }] });
    expect(second.issues.map((i) => i.id)).toEqual(first.issues.map((i) => i.id));

    const dismissed = first.issues[0].id;
    const third = await analyzer.analyze({ blocks: [{ text, kind: 'paragraph' }], dismissed: [dismissed] });
    expect(third.issues.map((i) => i.id)).not.toContain(dismissed);
    expect(third.issues).toHaveLength(first.issues.length - 1);
  });

  it('gives repeated identical findings distinct ids', async () => {
    const result = await check(analyzer, 'It was very good.\n\nIt was very good.');
    const ids = result.issues.filter((i) => i.ruleId === 'ws/intensifier').map((i) => i.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('does not flag an unfinished paragraph that is still being typed', async () => {
    const block = { text: 'Thanks for all your help with the project today', kind: 'paragraph' as const };
    const idle = await analyzer.analyze({ blocks: [block] });
    expect(rules(idle)).toContain('ws/missing-end-punctuation');
    const typing = await analyzer.analyze({ blocks: [block], caretBlock: 0 });
    expect(rules(typing)).not.toContain('ws/missing-end-punctuation');
  });

  it('skips code blocks', async () => {
    const result = await analyzer.analyze({ blocks: [{ text: 'in order to utilize teh thing', kind: 'code' }] });
    expect(result.issues).toHaveLength(0);
  });
});

describe('fix ranges', () => {
  it('every fix stays inside its block and changes the text', async () => {
    for (const [, input] of FIXES) {
      const result = await check(analyzer, input);
      for (const issue of result.issues) {
        expect(input.slice(issue.from, issue.to)).toBe(issue.text);
        for (const fix of issue.fixes) {
          expect(fix.from).toBeGreaterThanOrEqual(0);
          expect(fix.to).toBeLessThanOrEqual(input.length);
          expect(fix.from).toBeLessThanOrEqual(fix.to);
          expect(applyFix(input, fix)).not.toBe(input);
        }
      }
    }
  });
});
