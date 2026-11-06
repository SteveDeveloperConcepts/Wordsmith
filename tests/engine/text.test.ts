import { describe, expect, it } from 'vitest';
import { computeStats } from '@engine/stats';
import { countSyllables, countWords, splitSentences, tokenize } from '@engine/text';
import { detectTones } from '@engine/tone';
import { paragraphs } from '../helpers';

const sentences = (text: string) => splitSentences(text).map((s) => s.text);

describe('splitSentences', () => {
  it('splits on end marks', () => {
    expect(sentences('I went home. Was it late? Yes!')).toEqual(['I went home.', 'Was it late?', 'Yes!']);
  });

  it('does not split on abbreviations, initials, or decimals', () => {
    expect(sentences('Dr. Smith moved to the U.S. in 2010. She paid $3.50 for coffee.')).toEqual([
      'Dr. Smith moved to the U.S. in 2010.',
      'She paid $3.50 for coffee.',
    ]);
    expect(sentences('We met J. K. Rowling at 3 p.m. on Friday.')).toHaveLength(1);
    expect(sentences('Bring fruit, e.g. apples and pears.')).toHaveLength(1);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(sentences('She said "stop." Then she left (quietly.) Nobody spoke.')).toEqual([
      'She said "stop."',
      'Then she left (quietly.)',
      'Nobody spoke.',
    ]);
  });

  it('treats ellipses and line breaks as boundaries', () => {
    expect(sentences('Well... I guess so.')).toEqual(['Well...', 'I guess so.']);
    expect(sentences('First line\nSecond line')).toEqual(['First line', 'Second line']);
  });

  it('reports offsets that slice back to the sentence', () => {
    const text = '  One here.   "Two there."  ';
    for (const s of splitSentences(text)) expect(text.slice(s.from, s.to)).toBe(s.text);
    expect(text[splitSentences(text)[1].firstWord]).toBe('T');
  });
});

describe('words and syllables', () => {
  it('counts contractions, hyphenated words, and numbers as single words', () => {
    expect(countWords("Don't use the well-known 3.14 trick — ever.")).toBe(7);
    expect(tokenize('a b').map((t) => [t.from, t.to])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('estimates syllables', () => {
    expect(countSyllables('cat')).toBe(1);
    expect(countSyllables('table')).toBe(2);
    expect(countSyllables('beautiful')).toBe(3);
    expect(countSyllables('understanding')).toBe(4);
  });
});

describe('computeStats', () => {
  const text =
    'Wordsmith checks your writing as you type. It counts words, sentences, and paragraphs.\n\nIt also estimates reading time.';
  const { stats, readability } = computeStats(paragraphs(text));

  it('counts words, sentences, paragraphs, and characters', () => {
    expect(stats.words).toBe(18);
    expect(stats.sentences).toBe(3);
    expect(stats.paragraphs).toBe(2);
    expect(stats.characters).toBe(text.replace(/\n/g, '').length);
    expect(stats.charactersNoSpaces).toBe(text.replace(/\s/g, '').length);
  });

  it('estimates reading and speaking time from the word count', () => {
    expect(stats.readingTimeSec).toBe(Math.round((18 / 238) * 60));
    expect(stats.speakingTimeSec).toBe(Math.round((18 / 150) * 60));
  });

  it('scores readability once there is enough text', () => {
    expect(readability.fleschReadingEase).toBeGreaterThan(0);
    expect(readability.gradeLevel).not.toBeNull();
    expect(computeStats(paragraphs('Too short.')).readability.fleschReadingEase).toBeNull();
  });

  it('counts an emoji as one character', () => {
    expect(computeStats(paragraphs('Hi 😀')).stats.characters).toBe(4);
  });

  it('treats everyday words as common and unusual ones as rare', () => {
    const plain = computeStats(paragraphs('The man walked to the house and looked at the big tree in the garden.'));
    expect(plain.stats.rareWordsPct).toBe(0);
    const fancy = computeStats(paragraphs('The perspicacious lexicographer eschewed obfuscation.'));
    expect(fancy.stats.rareWordsPct).toBeGreaterThan(40);
  });
});

describe('detectTones', () => {
  const tone = (text: string) => {
    const { stats } = computeStats(paragraphs(text));
    return detectTones(text, stats.words, stats.sentences).map((t) => t.id);
  };

  it('needs a minimum amount of text', () => {
    expect(tone('Thanks a lot!')).toEqual([]);
  });

  it('recognizes an appreciative, friendly note', () => {
    const ids = tone(
      'Hi Sam, thank you so much for your help with the launch last week. I really appreciate the extra hours you put in, and I am grateful to have you on the team. Looking forward to working together again!',
    );
    expect(ids).toContain('appreciative');
    expect(ids).toContain('friendly');
  });

  it('recognizes a frustrated complaint', () => {
    const ids = tone(
      'This is completely unacceptable. I am furious that the order arrived broken again, and the support I received was awful. I am fed up with these ridiculous delays and I demand a refund.',
    );
    expect(ids[0]).toBe('angry');
  });

  it('falls back to neutral', () => {
    const ids = tone(
      'The box is on the table near the window. A lamp sits beside it. The room has four chairs and one long shelf along the far wall.',
    );
    expect(ids).toEqual(['neutral']);
  });
});
