/// <reference types="office-js" />
/**
 * Outlook compose mode.
 *
 * An add-in cannot place a range in a draft, so it cannot select text, and the only
 * way to change the body is to replace all of it. Replacing it is costly, in ways
 * that differ by client, and everything odd in this file answers one of these:
 *
 * - Cursor: goes to the start in classic Outlook and to the end in new Outlook and on
 *   the web. On Mac it disappears. Writes therefore happen only on a click in the pane.
 * - Undo: classic Outlook and Mac cannot undo a write, so the pane offers its own.
 * - Conversation view: the default body mode swaps the writer's layout setting during
 *   the write and shows them a notification. HostConfig avoids that, and when messages
 *   are grouped it keeps the quoted thread out of the round trip altogether.
 * - Stale reads: a read just after a write can return the old body (office-js 5983),
 *   and building on that would silently undo the fix before it.
 * - Late typing: classic Outlook can miss the last seconds of typing in a read
 *   (office-js 5846), and writing that back would erase them.
 * - Pictures: new Outlook can rewrite cid images after a write (6997) and truncate
 *   bodies holding many of them (6944).
 */
import type { Block, Fix, Goals, Issue } from '@engine/types';
import { pictureSources, parseHtml, readHtmlBlocks, readPlainBlocks, replaceHtmlBlock, replacePlainBlock, type Patch } from './mail-body';
import { settle } from './office-async';
import { hashText, refused, stale, stillFits, Stop, type Host, type Notice, type Outcome, type Snapshot } from './types';

const CHANGED = 'This text has changed, so nothing was applied. Checking again.';
const LOST = 'Wordsmith could not place this fix exactly, so nothing was changed. Checking again.';
const NOT_SAVED = 'Outlook has not finished the last change. Try again in a moment.';
const TOO_LONG = 'This draft is too long for Outlook to accept a change from an add-in.';
const NO_DRAFT = 'Open a message you are writing, and Wordsmith will check it here.';

/** Outlook refuses longer bodies. */
const MAX_BODY = 1_000_000;

/** New Outlook has been seen truncating bodies with about this many pictures or file links. */
const PICTURE_LIMIT = 10;

/** How long a body has to hold still before it is trusted as the writer's latest. */
const SETTLE_MS = 400;

const AFTER_WRITE_POLL_MS = 250;
const AFTER_WRITE_TRIES = 8;

/** Prefixes on a subject the writer did not write. */
const INHERITED_SUBJECT = /^\s*(re|fw|fwd|aw|wg|sv|vs|tr|rv|antw)\s*:/i;

/** What a broken cid picture turns into (office-js 6997). */
const BROKEN_PICTURE = /^(cid:Local\.ContentId|blob:)/i;

type Client = 'classic' | 'mac' | 'new' | 'web' | 'other';
type BodyKind = 'html' | 'text';
type Place = { in: 'subject' } | { in: 'body'; index: number };

interface Draft {
  item: Office.MessageCompose;
  bodyKind: BodyKind;
  blocks: Block[];
  /** Where each block lives, by block number. */
  places: Place[];
}

interface Step {
  place: Place;
  before: string;
  after: string;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clientOf(): Client {
  const name = Office.context.mailbox.diagnostics?.hostName;
  if (name === 'newOutlookWindows') return 'new';
  if (name === 'OutlookWebApp') return 'web';
  if (name === 'Outlook') return Office.context.platform === Office.PlatformType.Mac ? 'mac' : 'classic';
  return 'other';
}

const REWRITE_NOTICE: Record<Client, string> = {
  classic: 'A fix rewrites the whole message. The cursor moves to the start, and Ctrl+Z cannot take it back, so use Undo here.',
  mac: 'A fix rewrites the whole message. The cursor disappears until you click in the message, and Command+Z cannot take it back, so use Undo here.',
  new: 'A fix rewrites the whole message and moves the cursor to the end. Use Undo here to take one back.',
  web: 'A fix rewrites the whole message and moves the cursor to the end. Use Undo here to take one back.',
  other: 'A fix rewrites the whole message. Use Undo here to take one back.',
};

/** The item, if it is a message being written. A pinned pane can outlive the draft it opened on. */
function composeItem(): Office.MessageCompose | null {
  const item = Office.context.mailbox.item as Office.MessageCompose | null | undefined;
  return item && typeof item.subject === 'object' ? item : null;
}

/** Absent on classic Outlook and Mac, where the option is ignored anyway. */
function bodyOptions(): { bodyMode?: Office.MailboxEnums.BodyMode } {
  const mode = Office.MailboxEnums?.BodyMode?.HostConfig;
  return mode === undefined ? {} : { bodyMode: mode };
}

const coercion = (kind: BodyKind) => (kind === 'html' ? Office.CoercionType.Html : Office.CoercionType.Text);

function readType(item: Office.MessageCompose): Promise<BodyKind> {
  return settle<Office.CoercionType>((done) => item.body.getTypeAsync(done)).then((type) =>
    type === Office.CoercionType.Html ? 'html' : 'text',
  );
}

function readBody(item: Office.MessageCompose, kind: BodyKind): Promise<string> {
  return settle<string>((done) => item.body.getAsync(coercion(kind), bodyOptions(), done));
}

function readSubject(item: Office.MessageCompose): Promise<string> {
  return settle<string>((done) => item.subject.getAsync(done));
}

function failure(err: unknown): Outcome {
  if (err instanceof Stop) return err.outcome;
  return { ok: false, kind: 'failed', message: 'Outlook could not make that change. Nothing was applied.' };
}

export function createOutlookHost(): Host {
  let draft: Draft | null = null;
  let undoSteps: Step[] = [];
  /** The body our last write replaced, until a read shows that write has landed. */
  let replacedBody: string | null = null;
  /** Pictures as they stood when the last write went out. */
  let writtenPictures: string[] | null = null;
  let picturesChanged = false;
  /** Tells drafts apart in the fingerprint, since two can hold the same text. */
  let itemNumber = 0;
  let seenItem: Office.MessageCompose | null = null;
  const dismissals = new WeakMap<object, string[]>();

  function forgetDraft() {
    draft = null;
    undoSteps = [];
    replacedBody = null;
    writtenPictures = null;
    picturesChanged = false;
  }

  function noticeItem(item: Office.MessageCompose | null) {
    if (item === seenItem) return;
    seenItem = item;
    itemNumber++;
    forgetDraft();
  }

  /** Reads the body, waiting out the moment after a write when the old one can come back. */
  async function latestBody(item: Office.MessageCompose, kind: BodyKind): Promise<string> {
    let body = await readBody(item, kind);
    for (let tries = 0; body === replacedBody && tries < AFTER_WRITE_TRIES; tries++) {
      await delay(AFTER_WRITE_POLL_MS);
      body = await readBody(item, kind);
    }
    if (body === replacedBody) throw stale(NOT_SAVED);
    replacedBody = null;
    return body;
  }

  /** Reads until two looks agree, so that typing still on its way to the item is not overwritten. */
  async function settledBody(item: Office.MessageCompose, kind: BodyKind): Promise<string> {
    let body = await latestBody(item, kind);
    for (let tries = 0; tries < 3; tries++) {
      await delay(SETTLE_MS);
      const again = await readBody(item, kind);
      if (again === body) return body;
      body = again;
    }
    throw stale(CHANGED);
  }

  async function write(step: Step): Promise<void> {
    const current = draft;
    const item = composeItem();
    if (!current || !item || item !== current.item) throw stale(CHANGED);

    if (step.place.in === 'subject') {
      if ((await readSubject(item)) !== step.before) throw stale(CHANGED);
      await settle<void>((done) => item.subject.setAsync(step.after, done));
      return;
    }

    const kind = current.bodyKind;
    const was = current.blocks.filter((_, i) => current.places[i].in === 'body').map((block) => block.text);
    // An undo can come after a re-read that moved the block, so the old number is only a first guess.
    const index = was[step.place.index] === step.before ? step.place.index : was.indexOf(step.before);
    if (index === -1) throw stale(CHANGED);

    const body = await settledBody(item, kind);
    const patch: Patch =
      kind === 'html' ? replaceHtmlBlock(body, was, index, step.after) : replacePlainBlock(body, was, index, step.after);
    if (patch.status !== 'ok') throw stale(patch.status === 'stale' ? CHANGED : LOST);
    if (patch.body.length > MAX_BODY) throw refused(TOO_LONG);

    await settle<void>((done) =>
      item.body.setAsync(patch.body, { coercionType: coercion(kind), ...bodyOptions() }, done),
    );
    replacedBody = body;
    if (kind === 'html') writtenPictures = pictureSources(parseHtml(patch.body));
  }

  /** Runs after each read, so the writer hears about a broken picture before sending. */
  function watchPictures(now: string[]) {
    if (writtenPictures && writtenPictures.length === now.length) {
      picturesChanged ||= now.some((src, i) => src !== writtenPictures?.[i] && BROKEN_PICTURE.test(src));
    }
    writtenPictures = null;
  }

  async function attempt(work: () => Promise<void>): Promise<Outcome> {
    try {
      await work();
      return { ok: true };
    } catch (err) {
      return failure(err);
    }
  }

  return {
    kind: 'outlook',
    name: 'Outlook',
    live: true,
    canSelect: false,
    pollMs: 2500,

    goals: (base: Goals) => ({ ...base, domain: 'email' }),

    async fingerprint() {
      const item = composeItem();
      noticeItem(item);
      if (!item) return 'no draft';
      const kind = await readType(item);
      const [subject, body] = await Promise.all([readSubject(item), readBody(item, kind)]);
      return `${itemNumber}:${hashText(`${subject}\u0000${body}`)}`;
    },

    async read(): Promise<Snapshot> {
      const item = composeItem();
      noticeItem(item);
      if (!item) {
        forgetDraft();
        return { blocks: [], notices: [], empty: NO_DRAFT, readOnly: true };
      }

      const bodyKind = await readType(item);
      const [subject, body] = await Promise.all([readSubject(item), latestBody(item, bodyKind)]);

      const blocks: Block[] = [];
      const places: Place[] = [];
      if (subject.trim() && !INHERITED_SUBJECT.test(subject)) {
        blocks.push({ text: subject, kind: 'heading' });
        places.push({ in: 'subject' });
      }

      let pictures: string[] = [];
      if (bodyKind === 'html') {
        const doc = parseHtml(body);
        pictures = pictureSources(doc);
        readHtmlBlocks(doc).forEach((block, index) => {
          // The DOM references behind each block cannot cross to the worker.
          blocks.push({ text: block.text, kind: block.kind });
          places.push({ in: 'body', index });
        });
      } else {
        readPlainBlocks(body).forEach((block, index) => {
          blocks.push({ text: block.text, kind: block.kind });
          places.push({ in: 'body', index });
        });
      }
      draft = { item, bodyKind, blocks, places };
      watchPictures(pictures);

      const client = clientOf();
      const crowded = pictures.length >= PICTURE_LIMIT && (client === 'new' || client === 'web');
      const notices: Notice[] = [];
      if (crowded) {
        notices.push({
          id: 'crowded',
          tone: 'warn',
          text: 'This draft has many pictures, and Outlook can lose content when an add-in rewrites a draft like this. Make these changes in the message yourself.',
        });
      } else {
        notices.push({ id: 'rewrite', tone: 'info', text: REWRITE_NOTICE[client] });
        if (pictures.length > 0) {
          notices.push({
            id: 'pictures',
            tone: 'warn',
            text: 'This draft has pictures, and Outlook can break them when a message is rewritten. Check them before you send.',
          });
        }
      }
      if (picturesChanged) {
        notices.push({
          id: 'pictures-changed',
          tone: 'warn',
          text: 'Outlook changed a picture in this draft during the last fix. Check that it still shows before you send.',
        });
      }
      return { blocks, notices, readOnly: crowded };
    },

    apply(issue: Issue, fix: Fix) {
      return attempt(async () => {
        if (!draft || !stillFits(draft.blocks, issue)) throw stale(CHANGED);
        const before = draft.blocks[issue.block].text;
        const step: Step = {
          place: draft.places[issue.block],
          before,
          after: before.slice(0, fix.from) + fix.text + before.slice(fix.to),
        };
        await write(step);
        undoSteps.push(step);
      });
    },

    async select() {
      return { ok: false, kind: 'refused', message: 'Outlook does not let an add-in select text in a message.' };
    },

    undo() {
      return attempt(async () => {
        const step = undoSteps.at(-1);
        if (!step) return;
        await write({ place: step.place, before: step.after, after: step.before });
        undoSteps.pop();
      });
    },

    canUndo: () => undoSteps.length > 0,

    // Custom properties would travel with the message, so these last as long as the pane does.
    loadDismissed: async () => {
      const item = composeItem();
      return (item && dismissals.get(item)) ?? [];
    },

    saveDismissed: async (ids) => {
      const item = composeItem();
      if (item) dismissals.set(item, ids);
    },

    onItemChange(listener) {
      const { mailbox } = Office.context;
      const handler = () => {
        noticeItem(composeItem());
        listener();
      };
      mailbox.addHandlerAsync(Office.EventType.ItemChanged, handler);
      return () => mailbox.removeHandlerAsync(Office.EventType.ItemChanged);
    },
  };
}
