/// <reference types="chrome" />
/**
 * Ties the pieces together on a page where checking is on. Listens for the active
 * field, drives its session, and opens the card. Stopping removes every trace.
 */
import type { AnalyzeRequest, Fix } from '@engine/types';
import type { AnalyzeMessage, AnalyzeReply } from '../shared/messages';
import { addToDictionary, loadSettings, saveSettings, setSiteOn } from '../shared/settings';
import { Badge } from './badge';
import { Card } from './card';
import { checkableField, deepActiveElement, isBigEnough, isFormField, type PlacedIssue } from './field';
import { pointInRects } from './geometry';
import { visibleBox } from './mirror';
import { isOnDarkBackground, Overlay } from './overlay';
import { Painter } from './painter';
import { PlainField } from './plainField';
import { RichField } from './richField';
import { Session, type SessionHost } from './session';

/** How often the pointer is compared with the underlines. */
const HOVER_INTERVAL_MS = 50;
/** Pointers cross underlines on the way elsewhere; only a pause should open a card. */
const OPEN_DELAY_MS = 120;
/** Time to get from the underline to the card. */
const CLOSE_DELAY_MS = 250;

export class Controller implements SessionHost {
  settingsVersion = 0;

  private readonly doc = document;
  private readonly overlay = new Overlay(this.doc);
  private readonly painter = new Painter();
  private readonly card = new Card(this.doc, this.overlay.root, {
    applyFix: (placed, fix) => this.applyFix(placed, fix),
    dismiss: (placed) => this.active?.dismiss(placed),
    addToDictionary: (placed, word) => this.addWord(placed, word),
  });
  private readonly badge: Badge;
  private readonly sessions = new WeakMap<HTMLElement, Session>();
  private readonly listening = new AbortController();

  private active: Session | null = null;
  private activeListening: AbortController | null = null;
  private textObserver: MutationObserver | null = null;
  private sizeObserver: ResizeObserver | null = null;
  private viewObserver: IntersectionObserver | null = null;

  private pointer = { x: 0, y: 0 };
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private opening: PlacedIssue | null = null;
  private applying = false;
  private frame = 0;

  constructor(
    private readonly site: string,
    private readonly onContextLost: () => void,
  ) {
    this.badge = new Badge(this.doc, this.overlay.root, site, () => {
      this.turnOffSite().catch(() => this.onContextLost());
    });
  }

  start(): void {
    const { signal } = this.listening;
    this.doc.addEventListener('focusin', () => this.focusChanged(), { capture: true, signal });
    this.doc.addEventListener('mousemove', (event) => this.pointerMoved(event), { passive: true, signal });
    this.doc.addEventListener('mousedown', (event) => this.pressed(event), { capture: true, signal });
    this.doc.addEventListener('keydown', (event) => this.keyPressed(event), { capture: true, signal });
    // Capturing also catches scrolling inside panes, which does not bubble.
    window.addEventListener('scroll', () => this.viewChanged(), { capture: true, passive: true, signal });
    window.addEventListener('resize', () => this.viewChanged(), { passive: true, signal });
    this.doc.addEventListener('selectionchange', () => this.active?.caretMoved(), { signal });
    this.focusChanged();
  }

  stop(): void {
    this.listening.abort();
    this.deactivate();
    clearTimeout(this.hoverTimer);
    clearTimeout(this.openTimer);
    clearTimeout(this.closeTimer);
    cancelAnimationFrame(this.frame);
    this.painter.remove();
    this.overlay.remove();
  }

  settingsChanged(): void {
    this.settingsVersion++;
    this.active?.resume();
  }

  async analyze(fieldId: number, request: AnalyzeRequest): Promise<AnalyzeReply | null> {
    const message: AnalyzeMessage = { target: 'background', type: 'analyze', fieldId, request };
    try {
      return (await chrome.runtime.sendMessage(message)) as AnalyzeReply;
    } catch (error) {
      // After an update or reload this script is orphaned, and the page keeps it running until it reloads.
      if (!chrome.runtime?.id) this.onContextLost();
      return { status: 'failed', message: String(error) };
    }
  }

  changed(session: Session): void {
    if (session !== this.active) return;
    this.painter.paint(session.placed);
    this.badge.update(session.placed.length, session.notice);
    this.keepCardCurrent(session);
    this.requestLayout();
  }

  /** The card stays while its issue does, and while a fix from it is being applied, so it can report the outcome. */
  private keepCardCurrent(session: Session): void {
    const open = this.card.current;
    if (!open || this.applying) return;
    const same = session.placed.find(({ issue }) => issue.id === open.issue.id);
    if (same) this.card.current = same;
    else this.card.hide();
  }

  private focusChanged(): void {
    const element = checkableField(deepActiveElement(this.doc), this.site);
    if (element && isBigEnough(element)) this.activate(element);
  }

  private activate(element: HTMLElement): void {
    if (this.active?.field.element === element) return;
    this.deactivate();

    let session = this.sessions.get(element);
    if (!session) {
      const field = isFormField(element) ? new PlainField(element, this.overlay.root) : new RichField(element);
      session = new Session(field, this);
      this.sessions.set(element, session);
    }
    this.active = session;
    const active = session;

    this.overlay.attach();
    this.overlay.styleTree(element.getRootNode());
    this.overlay.setTheme(isOnDarkBackground(element));

    this.activeListening = new AbortController();
    const relayout = () => this.requestLayout();
    const { signal } = this.activeListening;
    element.addEventListener('input', () => active.textChanged(), { signal });
    element.addEventListener('click', (event) => this.clicked(event, active), { signal });
    element.addEventListener('scroll', relayout, { passive: true, signal });
    element.addEventListener('blur', () => active.caretMoved(), { signal });
    if (!isFormField(element)) {
      // Pages also change text without an input event, for instance when a signature is swapped.
      this.textObserver = new MutationObserver(() => active.textChanged());
      this.textObserver.observe(element, { childList: true, characterData: true, subtree: true });
    }
    this.sizeObserver = new ResizeObserver(relayout);
    this.sizeObserver.observe(element);
    // Also fires when the field is removed or hidden, which leaves no event of its own.
    this.viewObserver = new IntersectionObserver(relayout);
    this.viewObserver.observe(element);

    this.changed(active);
    active.resume();
  }

  private deactivate(): void {
    this.activeListening?.abort();
    this.activeListening = null;
    this.textObserver?.disconnect();
    this.sizeObserver?.disconnect();
    this.viewObserver?.disconnect();
    this.active?.suspend();
    this.active = null;
    this.card.hide();
    this.badge.hide();
    this.painter.paint([]);
  }

  /** A card left behind by a scroll would point at nothing, so it closes. The next hover opens it where the text is. */
  private viewChanged(): void {
    this.card.hide();
    this.opening = null;
    this.requestLayout();
  }

  private requestLayout(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }

  private layout(): void {
    const session = this.active;
    if (!session) return;
    const { field } = session;
    if (!field.element.isConnected) {
      this.deactivate();
      return;
    }
    field.layout();
    this.badge.place(visibleBox(field.element), field.multiline);
  }

  private pointerMoved(event: MouseEvent): void {
    // Dragging out a selection is not hovering.
    if (event.buttons !== 0) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.hoverTimer ??= setTimeout(() => {
      this.hoverTimer = undefined;
      this.hover();
    }, HOVER_INTERVAL_MS);
  }

  private hover(): void {
    const session = this.active;
    const { x, y } = this.pointer;
    if (!session) return;

    const open = this.card.current;
    if (this.card.containsPoint(x, y) || (open && pointInRects(open.range.getClientRects(), x, y))) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
      return;
    }
    if (open) this.closeSoon();

    // Whole-sentence underlines open on a click, as in the app, so reading is not interrupted.
    const words = session.placed.filter(({ issue }) => !issue.sentenceLevel);
    const hit = words.length > 0 ? session.field.hitTest(x, y, words) : null;
    if (hit !== this.opening) {
      clearTimeout(this.openTimer);
      this.opening = hit;
      if (hit) this.openTimer = setTimeout(() => this.openCard(hit), OPEN_DELAY_MS);
    }
  }

  private clicked(event: MouseEvent, session: Session): void {
    const sentences = session.placed.filter(({ issue }) => issue.sentenceLevel);
    if (sentences.length === 0 || !this.doc.getSelection()?.isCollapsed) return;
    this.pointer = { x: event.clientX, y: event.clientY };
    const hit = session.field.hitTest(event.clientX, event.clientY, sentences);
    if (hit) this.openCard(hit);
  }

  private openCard(placed: PlacedIssue): void {
    const { x, y } = this.pointer;
    const rects = placed.range.getClientRects();
    const line = pointInRects(rects, x, y) ?? rects[0];
    if (!line || !this.active?.placed.includes(placed)) return;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    // A sentence can run the width of the field, so the card goes by the pointer, not the start of the line.
    const left = placed.issue.sentenceLevel ? Math.max(line.left, x - 24) : line.left;
    this.card.show(placed, { left, top: line.top, width: line.width, height: line.height });
  }

  private closeSoon(): void {
    this.closeTimer ??= setTimeout(() => {
      this.closeTimer = undefined;
      this.card.hide();
      this.opening = null;
    }, CLOSE_DELAY_MS);
  }

  private pressed(event: MouseEvent): void {
    if (this.card.containsPoint(event.clientX, event.clientY)) return;
    this.card.hide();
    this.opening = null;
    if (!event.composedPath().some((target) => target instanceof Element && target.localName === 'wordsmith-overlay')) {
      this.badge.closeMenu();
    }
  }

  private keyPressed(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // Escape can also discard or close a compose window, which is not what the writer meant here.
    if (this.card.current) event.stopPropagation();
    this.card.hide();
    this.badge.closeMenu();
  }

  private async applyFix(placed: PlacedIssue, fix: Fix): Promise<string | null> {
    const session = this.active;
    if (!session) return null;
    this.applying = true;
    try {
      const result = await session.apply(placed, fix);
      return result === 'refused' ? 'This page did not accept the change. You can edit the text by hand.' : null;
    } finally {
      this.applying = false;
    }
  }

  private async addWord(placed: PlacedIssue, word: string): Promise<string | null> {
    try {
      await addToDictionary(word);
    } catch {
      return 'Could not save the word. The synced dictionary may be full.';
    }
    this.active?.dismiss(placed);
    return null;
  }

  private async turnOffSite(): Promise<void> {
    const settings = await loadSettings();
    await saveSettings({ disabledSites: setSiteOn(settings, this.site, false) });
  }
}
