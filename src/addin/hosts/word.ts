/// <reference types="office-js" />
/**
 * Word. Paragraphs come from the Word API and a fix goes straight into the range it
 * belongs to, so formatting, comments, and undo all keep working.
 *
 * getReviewedText would give tracked-change-free text, but the notes on it are bad:
 * it has crashed Word (office-js 5873, 6085) and frozen it (4302). It is never called
 * here. Instead the search that places a fix is checked against the paragraph text,
 * so tracked changes can make a fix fail, but cannot make it land in the wrong place.
 */
import type { Block, BlockKind, Fix, Goals, Issue } from '@engine/types';
import { diffText, type TextEdit } from '@shared/html-text';
import { readDismissed, writeDismissed } from './office-async';
import { findAgain, hashText, refused, stale, stillFits, Stop, type Host, type Notice, type Outcome, type Snapshot } from './types';
import { anchorFor, cleanText, coversObject, pickMatch, planSearch } from './word-find';

const CHANGED = 'This text has changed, so nothing was applied. Checking again.';
const LOST = 'Wordsmith could not find this exact text, so nothing was changed. Checking again.';
const IN_LINK = 'This text is part of a link. Change it in Word so the link stays intact.';
const IN_FIELD = 'This text comes from a field. Change the field in Word.';
const IN_REVISION = 'This text has a tracked change. Accept or reject that change first.';
const OVER_OBJECT = 'This fix would remove a footnote mark or a picture. Make this change in Word.';

const supports = (version: string) => Office.context.requirements.isSetSupported('WordApi', version);

/** A place in the paragraph, located and ready to be written to. */
interface Spot {
  range: Word.Range;
  write(): void;
}

function kindOf(paragraph: Word.Paragraph): BlockKind {
  const style = String(paragraph.styleBuiltIn);
  // Generated text. The engine leaves code alone, and the paragraph keeps its place in the list.
  if (/^Toc\d$/.test(style)) return 'code';
  // Sentence rules expect prose. A cell, like a list item, is usually a fragment.
  if (paragraph.tableNestingLevel > 0 || paragraph.isListItem) return 'list';
  if (/^(Heading\d|Title|Subtitle)$/.test(style) || (paragraph.outlineLevel >= 1 && paragraph.outlineLevel <= 9)) {
    return 'heading';
  }
  if (/Quote$/.test(style)) return 'quote';
  return 'paragraph';
}

/** Finds text[from, to) inside `scope`, or stops the operation. Never returns a near miss. */
async function locate(
  context: Word.RequestContext,
  scope: Word.Paragraph | Word.Range,
  text: string,
  from: number,
  to: number,
): Promise<Word.Range> {
  const plan = planSearch(text, from, to);
  if (!plan) throw stale(LOST);

  const searches = plan.terms.map((term) => {
    const found = scope.search(term.query, { matchCase: true });
    found.load('text');
    return found;
  });
  await context.sync();

  const ranges = plan.terms.map((term, i) => {
    const { items } = searches[i];
    const index = pickMatch(
      text,
      term,
      items.map((item) => item.text),
    );
    if (index === -1) throw stale(LOST);
    return items[index];
  });
  if (ranges.length === 1) return ranges[0];

  const whole = ranges[0].expandTo(ranges[1]);
  whole.load('text');
  await context.sync();
  if (cleanText(whole.text) !== cleanText(text.slice(plan.from, plan.to))) throw stale(LOST);
  return whole;
}

/**
 * Two searches: the whole word first, which has few matches, then the changed
 * characters inside that one match. Replacing only those is what keeps mixed
 * formatting within the word.
 */
async function spotFor(
  context: Word.RequestContext,
  paragraph: Word.Paragraph,
  text: string,
  edit: TextEdit,
): Promise<Spot> {
  if (coversObject(text, edit.from, edit.to)) throw refused(OVER_OBJECT);
  const anchor = anchorFor(text, edit.from, edit.to);
  if (!anchor) throw stale(LOST);

  const word = await locate(context, paragraph, text, anchor.from, anchor.to);
  const inner = text.slice(anchor.from, anchor.to);
  const from = edit.from - anchor.from;
  const to = edit.to - anchor.from;

  if (from === to) {
    if (from === 0) return { range: word, write: () => void word.insertText(edit.text, 'Start') };
    const before = from === inner.length ? word : await locate(context, word, inner, 0, from);
    return { range: before, write: () => void before.insertText(edit.text, 'End') };
  }
  const target = from === 0 && to === inner.length ? word : await locate(context, word, inner, from, to);
  return {
    range: target,
    write: () => {
      if (edit.text) target.insertText(edit.text, 'Replace');
      else target.delete();
    },
  };
}

/** Replacing link text can spread its formatting or drop the link (office-js 1762), and a field would rewrite it. */
async function refuseFragile(context: Word.RequestContext, paragraph: Word.Paragraph, spots: Spot[]): Promise<void> {
  for (const spot of spots) spot.range.load('hyperlink');
  const revisions = supports('1.6') ? spots.map((spot) => spot.range.getTrackedChanges()) : [];
  for (const revision of revisions) revision.load('items');
  const fields = supports('1.4') ? paragraph.fields : null;
  fields?.load('items');
  await context.sync();

  if (spots.some((spot) => spot.range.hyperlink)) throw refused(IN_LINK);
  if (revisions.some((revision) => revision.items.length > 0)) throw refused(IN_REVISION);
  if (!fields?.items.length) return;

  const overlaps = fields.items.flatMap((field) =>
    spots.map((spot) => field.result.intersectWithOrNullObject(spot.range)),
  );
  for (const overlap of overlaps) overlap.load('isNullObject');
  await context.sync();
  if (overlaps.some((overlap) => !overlap.isNullObject)) throw refused(IN_FIELD);
}

function failure(err: unknown): Outcome {
  const code = (err as { code?: string }).code;
  if (code === 'AccessDenied' || code === 'NotAllowed') {
    return { ok: false, kind: 'failed', message: 'Word would not accept the change. The document may be read-only or protected.' };
  }
  if (code === 'ItemNotFound' || code === 'SearchStringInvalidOrTooLong') {
    return { ok: false, kind: 'stale', message: LOST };
  }
  return { ok: false, kind: 'failed', message: 'Word could not make that change. Nothing was applied.' };
}

export function createWordHost(): Host {
  /** Word's own text, by paragraph, as of the last read. */
  let sources: string[] = [];
  let blocks: Block[] = [];

  async function findParagraph(context: Word.RequestContext, issue: Issue): Promise<Word.Paragraph> {
    if (!stillFits(blocks, issue)) throw stale(CHANGED);
    const paragraphs = context.document.body.paragraphs;
    paragraphs.load('text');
    await context.sync();
    const paragraph = findAgain(paragraphs.items, (item) => item.text, sources, issue.block);
    if (!paragraph) throw stale(CHANGED);
    return paragraph;
  }

  /** Stop is caught inside Word.run, so the outcome does not depend on how Office passes errors along. */
  async function attempt(work: (context: Word.RequestContext) => Promise<void>): Promise<Outcome> {
    let outcome: Outcome = { ok: true };
    try {
      await Word.run(async (context) => {
        try {
          await work(context);
        } catch (err) {
          if (!(err instanceof Stop)) throw err;
          outcome = err.outcome;
        }
      });
      return outcome;
    } catch (err) {
      return failure(err);
    }
  }

  return {
    kind: 'word',
    name: 'Word',
    live: true,
    canSelect: true,
    pollMs: 1500,

    goals: (base: Goals) => base,

    async fingerprint() {
      return Word.run(async (context) => {
        const { body } = context.document;
        body.load('text');
        await context.sync();
        return hashText(body.text);
      });
    },

    async read(): Promise<Snapshot> {
      if (!supports('1.3')) {
        return { blocks: [], notices: [], empty: 'Wordsmith needs Word 2016 or later.', readOnly: true };
      }
      return Word.run(async (context) => {
        const { document } = context;
        const paragraphs = document.body.paragraphs;
        paragraphs.load('text,isListItem,styleBuiltIn,outlineLevel,tableNestingLevel');
        const caret = document.getSelection().paragraphs.getFirstOrNullObject();
        caret.load('text');
        if (supports('1.4')) document.load('changeTrackingMode');
        const revisions = supports('1.6') ? document.body.getTrackedChanges() : null;
        revisions?.load('items');
        await context.sync();

        sources = paragraphs.items.map((paragraph) => paragraph.text);
        blocks = paragraphs.items.map((paragraph) => ({ text: cleanText(paragraph.text), kind: kindOf(paragraph) }));

        const notices: Notice[] = [];
        if (supports('1.4') && document.changeTrackingMode !== 'Off') {
          notices.push({ id: 'tracking', tone: 'info', text: 'Track Changes is on, so each fix appears as a tracked change.' });
        }
        if (revisions?.items.length) {
          notices.push({
            id: 'revisions',
            tone: 'info',
            text: 'This document has tracked changes. Deleted text can show up in suggestions, and text with a tracked change cannot be fixed from here.',
          });
        }
        const caretBlock = caret.isNullObject ? -1 : sources.indexOf(caret.text);
        return { blocks, notices, caretBlock: caretBlock === -1 ? undefined : caretBlock };
      });
    },

    apply(issue: Issue, fix: Fix) {
      return attempt(async (context) => {
        const paragraph = await findParagraph(context, issue);
        const text = sources[issue.block];
        const edits = diffText(blocks[issue.block].text.slice(fix.from, fix.to), fix.text).map((edit) => ({
          ...edit,
          from: edit.from + fix.from,
          to: edit.to + fix.from,
        }));
        const spots: Spot[] = [];
        for (const edit of edits) spots.push(await spotFor(context, paragraph, text, edit));
        await refuseFragile(context, paragraph, spots);
        // Last first, so a write cannot disturb what the next one is aimed at.
        for (const spot of spots.reverse()) spot.write();
        await context.sync();
      });
    },

    select(issue: Issue) {
      return attempt(async (context) => {
        const paragraph = await findParagraph(context, issue);
        const text = sources[issue.block];
        const span = issue.from === issue.to ? anchorFor(text, issue.from, issue.to) : issue;
        if (!span) throw stale(LOST);
        const range = await locate(context, paragraph, text, span.from, span.to);
        range.select();
        await context.sync();
      });
    },

    loadDismissed: async () => readDismissed(),
    saveDismissed: writeDismissed,
  };
}
