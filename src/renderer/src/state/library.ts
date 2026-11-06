/**
 * The document library. Documents live in IndexedDB so they survive restarts
 * and work offline; nothing is uploaded anywhere.
 */
import type { JSONContent } from '@tiptap/react';
import { del, get, set } from 'idb-keyval';
import { create } from 'zustand';
import type { Goals } from '@engine/types';
import { SAMPLE_PARAGRAPHS, SAMPLE_TITLE, paragraphsToDoc } from '../lib/sample';
import { useSettings } from './settings';

export interface DocMeta {
  id: string;
  title: string;
  /** First words of the text, for the list. */
  preview: string;
  words: number;
  issues: number;
  score: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DocRecord {
  id: string;
  title: string;
  content: JSONContent;
  goals: Goals;
  /** Ids of suggestions the writer dismissed in this document. */
  dismissed: string[];
  createdAt: number;
  updatedAt: number;
}

interface NewDocument {
  title?: string;
  content?: JSONContent;
  goals?: Goals;
}

interface LibraryState {
  ready: boolean;
  docs: DocMeta[];
  /** The open document. `content` is what was loaded; live edits are tracked outside React state. */
  current: DocRecord | null;
  init(): Promise<void>;
  open(id: string): Promise<void>;
  create(input?: NewDocument): Promise<string>;
  /** Hold a document in memory only. For this window's whole life, nothing reaches the library. */
  openScratch(input: NewDocument): void;
  rename(title: string): void;
  /** Record the latest editor content; written to disk shortly after. */
  saveContent(content: JSONContent, summary: { preview: string; words: number }): void;
  /** Update what the list shows about the open document, without it counting as an edit. */
  setSummary(summary: Pick<DocMeta, 'issues' | 'score' | 'preview' | 'words'>): void;
  setGoals(goals: Goals): void;
  dismiss(issueId: string): void;
  restoreDismissed(): void;
  remove(id: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  flush(): Promise<void>;
}

const INDEX_KEY = 'ws:index';
const docKey = (id: string) => `ws:doc:${id}`;
const LAST_OPEN_KEY = 'wordsmith.lastDocument';

/** IndexedDB can be unavailable (private windows, locked-down profiles); fall back to memory. */
const memory = new Map<string, unknown>();
let persistent = true;

async function load<T>(key: string): Promise<T | undefined> {
  if (persistent) {
    try {
      return await get<T>(key);
    } catch {
      persistent = false;
    }
  }
  return memory.get(key) as T | undefined;
}

async function store(key: string, value: unknown): Promise<void> {
  if (persistent) {
    try {
      await set(key, value);
      return;
    } catch {
      persistent = false;
    }
  }
  memory.set(key, value);
}

async function erase(key: string): Promise<void> {
  if (persistent) {
    try {
      await del(key);
      return;
    } catch {
      persistent = false;
    }
  }
  memory.delete(key);
}

const newId = () =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const sortDocs = (docs: DocMeta[]) => [...docs].sort((a, b) => b.updatedAt - a.updatedAt);

function metaOf(doc: DocRecord, extra: Partial<DocMeta> = {}): DocMeta {
  return {
    id: doc.id,
    title: doc.title,
    preview: '',
    words: 0,
    issues: 0,
    score: null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...extra,
  };
}

/** Latest content of the open document, kept out of React state so typing does not re-render the app. */
let draft: JSONContent | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** The quick window shares this storage with the main window, and must leave it alone. */
let scratch = false;

export const useLibrary = create<LibraryState>()((setState, getState) => {
  const persistCurrent = async () => {
    const { current, docs } = getState();
    if (!current || scratch) return;
    const meta = docs.find((d) => d.id === current.id);
    const record: DocRecord = {
      ...current,
      content: draft ?? current.content,
      updatedAt: meta?.updatedAt ?? current.updatedAt,
    };
    await store(docKey(record.id), record);
    await store(INDEX_KEY, docs);
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistCurrent();
    }, 400);
  };

  const patchCurrent = (patch: Partial<DocRecord>, meta: Partial<DocMeta> = {}) => {
    const { current, docs } = getState();
    if (!current) return;
    const updatedAt = Date.now();
    setState({
      current: { ...current, ...patch, updatedAt },
      docs: sortDocs(docs.map((d) => (d.id === current.id ? { ...d, ...meta, updatedAt } : d))),
    });
    scheduleSave();
  };

  return {
    ready: false,
    docs: [],
    current: null,

    async init() {
      const docs = (await load<DocMeta[]>(INDEX_KEY)) ?? [];
      setState({ docs: sortDocs(docs) });
      if (docs.length === 0) {
        await getState().create({ title: SAMPLE_TITLE, content: paragraphsToDoc(SAMPLE_PARAGRAPHS) });
      } else {
        const last = localStorage.getItem(LAST_OPEN_KEY);
        const target = docs.find((d) => d.id === last) ?? sortDocs(docs)[0];
        await getState().open(target.id);
      }
      setState({ ready: true });
    },

    async open(id) {
      if (getState().current?.id === id) return;
      await getState().flush();
      const record = await load<DocRecord>(docKey(id));
      if (!record) {
        // The index pointed at a document that is gone: drop the stale entry.
        const docs = getState().docs.filter((d) => d.id !== id);
        setState({ docs });
        await store(INDEX_KEY, docs);
        return;
      }
      draft = null;
      setState({ current: record });
      localStorage.setItem(LAST_OPEN_KEY, id);
    },

    async create(input = {}) {
      await getState().flush();
      const now = Date.now();
      const record: DocRecord = {
        id: newId(),
        title: input.title ?? '',
        content: input.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
        goals: input.goals ?? useSettings.getState().defaultGoals,
        dismissed: [],
        createdAt: now,
        updatedAt: now,
      };
      const docs = sortDocs([metaOf(record), ...getState().docs]);
      draft = null;
      setState({ current: record, docs });
      localStorage.setItem(LAST_OPEN_KEY, record.id);
      await store(docKey(record.id), record);
      await store(INDEX_KEY, docs);
      return record.id;
    },

    openScratch(input) {
      scratch = true;
      draft = null;
      const now = Date.now();
      setState({
        ready: true,
        current: {
          id: newId(),
          title: input.title ?? '',
          content: input.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
          goals: input.goals ?? useSettings.getState().defaultGoals,
          dismissed: [],
          createdAt: now,
          updatedAt: now,
        },
      });
    },

    rename(title) {
      patchCurrent({ title }, { title });
    },

    saveContent(content, summary) {
      draft = content;
      const { current, docs } = getState();
      if (!current) return;
      const updatedAt = Date.now();
      // Only the list entry changes here; `current` keeps its identity so nothing else re-renders.
      setState({ docs: sortDocs(docs.map((d) => (d.id === current.id ? { ...d, ...summary, updatedAt } : d))) });
      scheduleSave();
    },

    setSummary(summary) {
      const { current, docs } = getState();
      if (!current) return;
      const entry = docs.find((d) => d.id === current.id);
      if (!entry) return;
      const changed = (Object.keys(summary) as Array<keyof typeof summary>).some((key) => entry[key] !== summary[key]);
      if (!changed) return;
      setState({ docs: docs.map((d) => (d.id === current.id ? { ...d, ...summary } : d)) });
      scheduleSave();
    },

    setGoals(goals) {
      patchCurrent({ goals });
    },

    dismiss(issueId) {
      const current = getState().current;
      if (!current || current.dismissed.includes(issueId)) return;
      patchCurrent({ dismissed: [...current.dismissed, issueId] });
    },

    restoreDismissed() {
      patchCurrent({ dismissed: [] });
    },

    async remove(id) {
      const wasCurrent = getState().current?.id === id;
      if (wasCurrent) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        draft = null;
      }
      const docs = getState().docs.filter((d) => d.id !== id);
      setState({ docs, current: wasCurrent ? null : getState().current });
      await erase(docKey(id));
      await store(INDEX_KEY, docs);
      if (wasCurrent) {
        if (docs.length) await getState().open(docs[0].id);
        else await getState().create();
      }
    },

    async duplicate(id) {
      await getState().flush();
      const source = await load<DocRecord>(docKey(id));
      if (!source) return;
      const meta = getState().docs.find((d) => d.id === id);
      const newDocId = await getState().create({
        title: source.title ? `${source.title} (copy)` : '',
        content: source.content,
        goals: source.goals,
      });
      if (meta) {
        setState({
          docs: getState().docs.map((d) =>
            d.id === newDocId ? { ...d, preview: meta.preview, words: meta.words } : d,
          ),
        });
        await store(INDEX_KEY, getState().docs);
      }
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      await persistCurrent();
    },
  };
});

/** The open document's latest content, including edits not yet written to disk. */
export function currentContent(): JSONContent | null {
  return draft ?? useLibrary.getState().current?.content ?? null;
}
