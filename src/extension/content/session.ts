/**
 * One field's check cycle: read the text, ask the engine, place what comes back.
 * Nothing here ever guesses. An issue is only drawn or fixed while the text it was
 * found in is unchanged, and anything else waits for the next check.
 */
import type { AnalyzeRequest, Block, Fix, Issue } from '@engine/types';
import type { AnalyzeReply } from '../shared/messages';
import type { Field, PlacedIssue } from './field';
import { sameBlockText, sameFlaggedText } from './offsets';

/** Long enough not to check half-typed words, short enough to feel live. */
const TYPING_DELAY_MS = 400;
/** Editors such as ProseMirror rewrite the DOM a moment after an edit. */
const SETTLE_MS = 60;
/** Leaving a block can change its suggestions, because a block being typed in is treated gently. */
const CARET_DELAY_MS = 150;

export type ApplyResult = 'applied' | 'stale' | 'refused';

export interface SessionHost {
  /** Goes up when settings change, so that every field checks again when it is next active. */
  readonly settingsVersion: number;
  analyze(fieldId: number, request: AnalyzeRequest): Promise<AnalyzeReply | null>;
  /** The placed issues changed. */
  changed(session: Session): void;
}

let nextFieldId = 1;

export class Session {
  placed: PlacedIssue[] = [];
  /** Shown in the badge's menu when checking is limited or has failed. */
  notice: string | null = null;

  private readonly fieldId = nextFieldId++;
  private readonly dismissed = new Set<string>();
  private lastChecked: string | null = null;
  private checkedCaret: number | undefined;
  private ticket = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private checkPending = false;

  constructor(
    readonly field: Field,
    private readonly host: SessionHost,
  ) {}

  /** The text changed. Anything now wrong comes off at once; the rest waits for the next check. */
  textChanged(): void {
    this.field.sync();
    const kept = this.placed.filter(({ range, issue }) => sameFlaggedText(range.toString(), issue.text));
    if (kept.length !== this.placed.length) this.drop(kept);
    this.schedule(TYPING_DELAY_MS);
  }

  caretMoved(): void {
    if (!this.checkPending && this.field.caretBlock() !== this.checkedCaret) this.schedule(CARET_DELAY_MS);
  }

  resume(): void {
    this.schedule(0);
  }

  suspend(): void {
    clearTimeout(this.timer);
    this.checkPending = false;
    this.ticket++;
    this.field.suspend();
  }

  dismiss(placed: PlacedIssue): void {
    this.dismissed.add(placed.issue.id);
    this.setPlaced(this.placed.filter((other) => other !== placed));
  }

  async apply(placed: PlacedIssue, fix: Fix): Promise<ApplyResult> {
    const { issue, blockText } = placed;
    const before = this.field.read()[issue.block]?.text;
    if (before !== blockText || before.slice(issue.from, issue.to) !== issue.text) {
      this.dropBlock(issue.block);
      this.schedule(0);
      return 'stale';
    }

    // Every offset in this block is about to go out of date.
    this.dropBlock(issue.block);
    const expected = before.slice(0, fix.from) + fix.text + before.slice(fix.to);
    const accepted = await this.field.replace(issue.block, fix.from, fix.to, fix.text);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    const after = this.field.read()[issue.block]?.text;
    this.schedule(0);
    if (accepted && after !== undefined && sameBlockText(after, expected)) return 'applied';
    return after !== undefined && sameBlockText(after, before) ? 'refused' : 'stale';
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.checkPending = true;
    this.timer = setTimeout(() => void this.check(), delay);
  }

  private async check(): Promise<void> {
    this.checkPending = false;
    const blocks = this.field.read();
    const caretBlock = this.field.caretBlock();
    this.checkedCaret = caretBlock;
    const signature = JSON.stringify([this.host.settingsVersion, blocks.map(({ text, kind }) => [text, kind]), caretBlock]);
    if (signature === this.lastChecked) {
      this.host.changed(this);
      return;
    }
    this.lastChecked = signature;

    const ticket = ++this.ticket;
    if (blocks.length === 0) {
      this.setPlaced([]);
      return;
    }

    const request: AnalyzeRequest = {
      blocks: blocks.map(({ text, kind }): Block => ({ text, kind })),
      dismissed: [...this.dismissed],
      caretBlock,
    };
    const reply = await this.host.analyze(this.fieldId, request);
    if (ticket !== this.ticket || !reply || reply.status === 'superseded') return;
    if (reply.status === 'failed') {
      this.lastChecked = null;
      this.notice = 'The checker could not start, so nothing is being checked.';
      this.setPlaced([]);
      return;
    }

    this.notice = reply.grammarEngineReady
      ? null
      : 'The grammar engine did not load, so only the basic checks are running.';
    this.place(reply.issues, blocks);
  }

  private place(issues: Issue[], checked: Block[]): void {
    const current = this.field.read();
    const previous = new Map(this.placed.map((placed) => [placed.issue.id, placed]));
    const placed: PlacedIssue[] = [];
    for (const issue of issues) {
      const blockText = checked[issue.block].text;
      if (current[issue.block]?.text !== blockText) continue;

      // A check can finish while a card is open or about to open. An issue that has
      // not changed stays the same object, so the card stays with it.
      const same = previous.get(issue.id);
      if (same?.blockText === blockText && same.issue.block === issue.block && same.issue.from === issue.from) {
        placed.push(same);
        continue;
      }
      const range = this.field.rangeOf(issue.block, issue.from, issue.to);
      if (range) placed.push({ issue, range, blockText });
    }
    this.setPlaced(placed);
  }

  private dropBlock(block: number): void {
    this.drop(this.placed.filter(({ issue }) => issue.block !== block));
  }

  /** The text may yet return to what was last checked, as after an undo, and its issues must come back with it. */
  private drop(kept: PlacedIssue[]): void {
    this.lastChecked = null;
    this.setPlaced(kept);
  }

  private setPlaced(placed: PlacedIssue[]): void {
    this.placed = placed;
    this.host.changed(this);
  }
}
