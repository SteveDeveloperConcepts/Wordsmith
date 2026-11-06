/// <reference types="office-js" />
/**
 * PowerPoint and Excel, through the Common API. It offers the current selection as
 * text and can replace that selection, nothing finer, so there is no live checking
 * and a fix has to rewrite everything selected.
 */
import type { Block, Fix, Goals, Issue } from '@engine/types';
import { readDismissed, settle, writeDismissed } from './office-async';
import { refused, stale, stillFits, Stop, type Host, type Notice, type Outcome, type Snapshot } from './types';

const CHANGED = 'The selection has changed, so nothing was applied. Checking again.';
const NOTHING = 'Select some text, then choose Check selection.';
const ONE_CELL = 'Select a single cell with one line of text to apply a fix.';
const FORMULA = 'This cell holds a formula, and a fix would replace it with plain text. Change it in Excel.';

const LINE_END = /\r\n|\r|\n|\v/g;

interface Part {
  start: number;
  length: number;
}

const NOTICES: Record<'powerpoint' | 'excel', Notice> = {
  powerpoint: {
    id: 'selection',
    tone: 'info',
    text: 'A fix replaces the whole selection, so mixed formatting inside it can be lost.',
  },
  excel: {
    id: 'selection',
    tone: 'info',
    text: 'A fix replaces the text of the selected cell. Selecting several cells checks them, but they cannot be fixed from here.',
  },
};

/** Fails when the selection is something other than text, which to the writer just means there is none. */
async function selectedText(): Promise<string> {
  try {
    const text = await settle<string>((done) =>
      Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, done),
    );
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Lines, and in Excel the cells of a multi-cell selection, each become a block. */
function split(text: string, kind: 'powerpoint' | 'excel'): Part[] {
  const parts: Part[] = [];
  const separators = kind === 'excel' ? /\r\n|\r|\n|\v|\t/g : LINE_END;
  let start = 0;
  for (const match of text.matchAll(separators)) {
    parts.push({ start, length: match.index - start });
    start = match.index + match[0].length;
  }
  parts.push({ start, length: text.length - start });
  return parts.filter((part) => text.slice(part.start, part.start + part.length).trim());
}

/**
 * The Common API would write over a formula without a word, so this one check goes
 * through the Excel API. Returns why the cell cannot be written, if it cannot.
 */
async function unsafeCell(): Promise<string | null> {
  if (!Office.context.requirements.isSetSupported('ExcelApi', '1.4')) return null;
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load('cellCount,formulas');
    await context.sync();
    if (range.cellCount !== 1) return ONE_CELL;
    const formula: unknown = range.formulas[0][0];
    return typeof formula === 'string' && formula.startsWith('=') ? FORMULA : null;
  });
}

export function createSelectionHost(kind: 'powerpoint' | 'excel'): Host {
  let source = '';
  let parts: Part[] = [];
  let blocks: Block[] = [];

  return {
    kind,
    name: kind === 'excel' ? 'Excel' : 'PowerPoint',
    live: false,
    canSelect: false,
    pollMs: 0,

    goals: (base: Goals) => base,

    fingerprint: selectedText,

    async read(): Promise<Snapshot> {
      source = await selectedText();
      parts = split(source, kind);
      blocks = parts.map((part) => ({
        text: source.slice(part.start, part.start + part.length).replace(/ /g, ' '),
        kind: kind === 'excel' ? 'list' : 'paragraph',
      }));
      if (blocks.length === 0) return { blocks, notices: [], empty: NOTHING };
      return { blocks, notices: [NOTICES[kind]] };
    },

    async apply(issue: Issue, fix: Fix): Promise<Outcome> {
      try {
        if (!stillFits(blocks, issue)) throw stale(CHANGED);
        if ((await selectedText()) !== source) throw stale(CHANGED);
        if (kind === 'excel') {
          if (/[\t\r\n\v]/.test(source)) throw refused(ONE_CELL);
          const problem = await unsafeCell();
          if (problem) throw refused(problem);
        }
        const { start } = parts[issue.block];
        const next = source.slice(0, start + fix.from) + fix.text + source.slice(start + fix.to);
        await settle<void>((done) =>
          Office.context.document.setSelectedDataAsync(next, { coercionType: Office.CoercionType.Text }, done),
        );
        return { ok: true };
      } catch (err) {
        if (err instanceof Stop) return err.outcome;
        return { ok: false, kind: 'failed', message: `${kind === 'excel' ? 'Excel' : 'PowerPoint'} could not make that change. Nothing was applied.` };
      }
    },

    async select() {
      return { ok: false, kind: 'refused', message: 'This application does not let an add-in select part of a selection.' };
    },

    loadDismissed: async () => readDismissed(),
    saveDismissed: writeDismissed,
  };
}
