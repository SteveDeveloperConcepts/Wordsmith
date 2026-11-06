/**
 * A stand-in for Office.js, used by the unit tests and, in a real browser, by
 * pane.e2e.mjs. It is plain JavaScript with one export so the browser run can serve
 * it in place of office.js.
 *
 * It keeps the rules that make the real API easy to misuse, because code that breaks
 * them here would break in Office, where these tests cannot go:
 * - reading a property before load and sync throws PropertyNotLoaded
 * - requests run at sync, in order, and values are a snapshot of that moment
 * - search takes Word's ^ notation, rejects anything over 255 characters, and treats
 *   straight and curly quotes and spaces as the same character, as Find does
 *
 * Paragraph spec: a string, or
 * { text, styleBuiltIn, isListItem, tableNestingLevel, outlineLevel, bold: [[from, to]],
 *   links: [[from, to, url]], fields: [[from, to]], revisions: [[from, to]], deleted: [[from, to]] }
 * `deleted` is text shown inline as a tracked deletion: it is in paragraph.text, but
 * search skips it, the shape of office-js 5874.
 */
export function installFakeOffice(target, config = {}) {
  const host = config.host ?? 'Word';
  const platform = config.platform ?? 'PC';
  const unsupported = new Set(config.unsupported ?? []);

  function officeError(code, message) {
    const error = new Error(message ?? code);
    error.code = code;
    return error;
  }

  const later = (work) => setTimeout(work, 0);
  const succeeded = (value) => ({ status: 'succeeded', value });
  const failed = (code, message) => ({ status: 'failed', error: { code, message } });

  /* ---------- Word ---------- */

  const toParagraph = (spec) => {
    const value = typeof spec === 'string' ? { text: spec } : spec;
    const bold = Array.from({ length: value.text.length }, () => false);
    for (const [from, to] of value.bold ?? []) bold.fill(true, from, to);
    return {
      text: value.text,
      bold,
      styleBuiltIn: value.styleBuiltIn ?? 'Normal',
      isListItem: value.isListItem ?? false,
      tableNestingLevel: value.tableNestingLevel ?? 0,
      outlineLevel: value.outlineLevel ?? 10,
      links: value.links ?? [],
      fields: value.fields ?? [],
      revisions: value.revisions ?? [],
      deleted: value.deleted ?? [],
    };
  };

  const word = {
    paragraphs: (config.word?.paragraphs ?? []).map(toParagraph),
    changeTrackingMode: config.word?.changeTrackingMode ?? 'Off',
    readOnly: config.word?.readOnly ?? false,
    selection: null,
    log: [],
    bodyReads: 0,
    /** The writer adds a paragraph while the pane is open. */
    addParagraph(spec, at = this.paragraphs.length) {
      this.paragraphs.splice(at, 0, toParagraph(spec));
    },
  };

  const NOTATION = { '^': '^', t: '\t', l: '\v', s: ' ', '~': '\u001E', '-': '\u001F' };

  function decodeQuery(query) {
    if (query.length === 0 || query.length > 255) throw officeError('SearchStringInvalidOrTooLong');
    let out = '';
    for (let i = 0; i < query.length; i++) {
      if (query[i] !== '^') {
        out += query[i];
        continue;
      }
      i++;
      if (!(query[i] in NOTATION)) throw officeError('InvalidArgument', `Unknown notation ^${query[i]}`);
      out += NOTATION[query[i]];
    }
    return out;
  }

  const sameChar = (haystack, needle) => {
    const quote = (ch) => (ch === '‘' || ch === '’' ? "'" : ch === '“' || ch === '”' ? '"' : ch);
    if (needle === ' ') return haystack === ' ' || haystack === ' ';
    return quote(haystack) === quote(needle);
  };

  function matchesAt(text, at, needle) {
    for (let i = 0; i < needle.length; i++) if (!sameChar(text[at + i], needle[i])) return false;
    return true;
  }

  function search(paragraph, from, to, needle) {
    const hits = [];
    let at = from;
    while (at + needle.length <= to) {
      const hidden = paragraph.deleted.some(([a, b]) => at >= a && at < b);
      if (!hidden && matchesAt(paragraph.text, at, needle)) {
        hits.push([at, at + needle.length]);
        at += needle.length;
      } else {
        at += 1;
      }
    }
    return hits;
  }

  class Context {
    constructor() {
      this.pending = [];
      this.ranges = new Set();
      this.document = new WordDocument(this);
    }
    enqueue(work) {
      this.pending.push(work);
    }
    async sync() {
      const pending = this.pending;
      this.pending = [];
      for (const work of pending) work();
    }
    /** Word keeps ranges alive across edits, so a write moves everything after it. */
    shift(paragraph, at, removed, added) {
      for (const range of this.ranges) {
        if (range.paragraph !== paragraph) continue;
        const move = (offset) => (offset >= at + removed ? offset + added - removed : Math.min(offset, at + added));
        range.from = move(range.from);
        range.to = move(range.to);
      }
    }
  }

  class ClientObject {
    constructor(context) {
      this.context = context;
      this.values = {};
    }
    load(properties = '') {
      const names = (Array.isArray(properties) ? properties : properties.split(',')).map((name) => name.trim()).filter(Boolean);
      this.context.enqueue(() => {
        for (const name of names) this.values[name] = this.read(name);
      });
      return this;
    }
    read(name) {
      throw new Error(`Fake has no property ${name}`);
    }
    get(name) {
      if (!(name in this.values)) throw officeError('PropertyNotLoaded', `${name} was read before load and sync`);
      return this.values[name];
    }
  }

  class Collection extends ClientObject {
    constructor(context, produce) {
      super(context);
      this.produce = produce;
      this.list = null;
    }
    load(properties = '') {
      const names = (Array.isArray(properties) ? properties : properties.split(',')).map((name) => name.trim()).filter(Boolean);
      this.context.enqueue(() => {
        this.list = this.produce();
        for (const item of this.list) {
          for (const name of names) if (name !== 'items') item.values[name] = item.read(name);
        }
      });
      return this;
    }
    get items() {
      if (this.list === null) throw officeError('PropertyNotLoaded', 'items was read before load and sync');
      return this.list;
    }
    getFirstOrNullObject() {
      const first = new Paragraph(this.context, null);
      this.context.enqueue(() => {
        first.model = this.produce()[0]?.model ?? null;
      });
      return first;
    }
  }

  class Range extends ClientObject {
    constructor(context, paragraph, from, to) {
      super(context);
      this.paragraph = paragraph;
      this.from = from;
      this.to = to;
      context.ranges.add(this);
    }
    get text() {
      return this.get('text');
    }
    get hyperlink() {
      return this.get('hyperlink');
    }
    get isNullObject() {
      return this.get('isNullObject');
    }
    read(name) {
      if (name === 'text') return this.paragraph.text.slice(this.from, this.to);
      if (name === 'hyperlink') {
        const link = this.paragraph.links.find(([a, b]) => this.from < b && this.to > a);
        return link ? link[2] : '';
      }
      if (name === 'isNullObject') return this.paragraph === null;
      return super.read(name);
    }
    search(query, options = {}) {
      return searchIn(this.context, () => [this.paragraph, this.from, this.to], query, options);
    }
    expandTo(other) {
      const whole = new Range(this.context, this.paragraph, 0, 0);
      this.context.enqueue(() => {
        whole.from = Math.min(this.from, other.from);
        whole.to = Math.max(this.to, other.to);
      });
      return whole;
    }
    intersectWithOrNullObject(other) {
      const overlap = new Range(this.context, null, 0, 0);
      this.context.enqueue(() => {
        const from = Math.max(this.from, other.from);
        const to = Math.min(this.to, other.to);
        if (this.paragraph === other.paragraph && from < to) {
          overlap.paragraph = this.paragraph;
          overlap.from = from;
          overlap.to = to;
        }
      });
      return overlap;
    }
    getTrackedChanges() {
      return new Collection(this.context, () =>
        this.paragraph.revisions
          .filter(([a, b]) => this.from < b && this.to > a)
          .map(() => new ClientObject(this.context)),
      );
    }
    write(at, removed, text, op) {
      if (word.readOnly) throw officeError('AccessDenied');
      const { paragraph } = this;
      const before = paragraph.text.slice(at, at + removed);
      const format = paragraph.bold[op === 'End' ? Math.max(at - 1, 0) : at] ?? false;
      paragraph.text = paragraph.text.slice(0, at) + text + paragraph.text.slice(at + removed);
      paragraph.bold.splice(at, removed, ...Array.from(text, () => format));
      this.context.shift(paragraph, at, removed, text.length);
      word.log.push({ op, before, text });
    }
    insertText(text, location) {
      this.context.enqueue(() => {
        if (location === 'Replace') this.write(this.from, this.to - this.from, text, 'Replace');
        else if (location === 'End') this.write(this.to, 0, text, 'End');
        else if (location === 'Start') this.write(this.from, 0, text, 'Start');
        else throw officeError('InvalidArgument', `Fake has no insert location ${location}`);
      });
      return this;
    }
    delete() {
      this.context.enqueue(() => this.write(this.from, this.to - this.from, '', 'Delete'));
    }
    select() {
      this.context.enqueue(() => {
        word.selection = this.paragraph.text.slice(this.from, this.to);
      });
    }
  }

  function searchIn(context, scope, query, options) {
    return new Collection(context, () => {
      const [paragraph, from, to] = scope();
      if (!options.matchCase) throw new Error('The add-in always searches with matchCase');
      return search(paragraph, from, to, decodeQuery(query)).map(([a, b]) => new Range(context, paragraph, a, b));
    });
  }

  class Paragraph extends ClientObject {
    constructor(context, model) {
      super(context);
      this.model = model;
    }
    read(name) {
      if (name === 'isNullObject') return this.model === null;
      return this.model[name];
    }
    get text() {
      return this.get('text');
    }
    get isNullObject() {
      return this.model === null;
    }
    get isListItem() {
      return this.get('isListItem');
    }
    get styleBuiltIn() {
      return this.get('styleBuiltIn');
    }
    get outlineLevel() {
      return this.get('outlineLevel');
    }
    get tableNestingLevel() {
      return this.get('tableNestingLevel');
    }
    get fields() {
      return new Collection(this.context, () =>
        this.model.fields.map(([from, to]) => {
          const field = new ClientObject(this.context);
          field.result = new Range(this.context, this.model, from, to);
          return field;
        }),
      );
    }
    search(query, options = {}) {
      return searchIn(this.context, () => [this.model, 0, this.model.text.length], query, options);
    }
  }

  class Body extends ClientObject {
    get paragraphs() {
      return new Collection(this.context, () => word.paragraphs.map((model) => new Paragraph(this.context, model)));
    }
    get text() {
      return this.get('text');
    }
    read(name) {
      if (name === 'text') {
        word.bodyReads++;
        return word.paragraphs.map((paragraph) => paragraph.text).join('\r');
      }
      return super.read(name);
    }
    getTrackedChanges() {
      return new Collection(this.context, () =>
        word.paragraphs.flatMap((paragraph) =>
          [...paragraph.revisions, ...paragraph.deleted].map(() => new ClientObject(this.context)),
        ),
      );
    }
  }

  class WordDocument extends ClientObject {
    constructor(context) {
      super(context);
      this.body = new Body(context);
    }
    get changeTrackingMode() {
      return this.get('changeTrackingMode');
    }
    read(name) {
      if (name === 'changeTrackingMode') return word.changeTrackingMode;
      return super.read(name);
    }
    getSelection() {
      return {
        paragraphs: new Collection(this.context, () =>
          word.paragraphs.slice(0, 1).map((model) => new Paragraph(this.context, model)),
        ),
      };
    }
  }

  const Word = {
    async run(batch) {
      const context = new Context();
      const result = await batch(context);
      await context.sync();
      return result;
    },
  };

  /* ---------- Outlook ---------- */

  const outlook = {
    body: config.outlook?.body ?? '',
    bodyType: config.outlook?.bodyType ?? 'html',
    subject: config.outlook?.subject ?? '',
    /** What getAsync returns in HostConfig mode when messages are grouped by conversation. */
    conversationBody: config.outlook?.conversationBody ?? null,
    hostName: config.outlook?.hostName ?? 'Outlook',
    compose: config.outlook?.compose ?? true,
    writes: [],
    bodyOptions: [],
    /** Reads that still return the old body after a write, as in office-js 5983. */
    staleReadsAfterWrite: config.outlook?.staleReadsAfterWrite ?? 0,
    /** Stands in for what a client does to a body it is given. */
    rewriteOnWrite: config.outlook?.rewriteOnWrite ?? null,
    /** Fails the body read this many reads from now, the shape of office-js 6800. */
    failReadIn: 0,
    previousBody: null,
    staleReadsLeft: 0,
    handlers: {},
  };

  const HOST_CONFIG = 1;

  const composeItem = () => ({
    subject: {
      getAsync(callback) {
        later(() => callback(succeeded(outlook.subject)));
      },
      setAsync(value, callback) {
        outlook.subject = value;
        outlook.writes.push({ subject: value });
        later(() => callback?.(succeeded()));
      },
    },
    body: {
      getTypeAsync(callback) {
        later(() => callback(succeeded(outlook.bodyType)));
      },
      getAsync(type, options, callback) {
        outlook.bodyOptions.push({ call: 'get', ...options });
        later(() => {
          if (outlook.failReadIn > 0 && --outlook.failReadIn === 0) {
            callback(failed(5001, 'An internal error has occurred.'));
          } else if (outlook.staleReadsLeft > 0) {
            outlook.staleReadsLeft--;
            callback(succeeded(outlook.previousBody));
          } else {
            const grouped = options?.bodyMode === HOST_CONFIG && outlook.conversationBody !== null;
            callback(succeeded(grouped ? outlook.conversationBody : outlook.body));
          }
        });
      },
      setAsync(data, options, callback) {
        outlook.bodyOptions.push({ call: 'set', ...options });
        later(() => {
          if (options?.coercionType === 'html' && outlook.bodyType === 'text') {
            callback(failed('InvalidFormatError', 'The body is plain text.'));
            return;
          }
          if (data.length > 1_000_000) {
            callback(failed('DataExceedsMaximumSize', 'Too long.'));
            return;
          }
          const stored = outlook.rewriteOnWrite ? outlook.rewriteOnWrite(data) : data;
          outlook.previousBody = outlook.body;
          outlook.staleReadsLeft = outlook.staleReadsAfterWrite;
          if (options?.bodyMode === HOST_CONFIG && outlook.conversationBody !== null) outlook.conversationBody = stored;
          else outlook.body = stored;
          outlook.writes.push({ body: data });
          callback(succeeded());
        });
      },
    },
  });

  const readItem = () => ({ subject: outlook.subject, body: {} });

  const mailbox = {
    item: outlook.compose ? composeItem() : readItem(),
    diagnostics: { hostName: outlook.hostName },
    addHandlerAsync(type, handler, callback) {
      outlook.handlers[type] = handler;
      callback?.(succeeded());
    },
    removeHandlerAsync(type, callback) {
      delete outlook.handlers[type];
      callback?.(succeeded());
    },
  };

  /** A pinned pane moves to another message. */
  outlook.switchItem = (next) => {
    Object.assign(outlook, { subject: '', body: '', conversationBody: null, writes: [], ...next });
    mailbox.item = outlook.compose === false ? readItem() : composeItem();
    outlook.handlers.olkItemSelectedChanged?.({});
  };

  /* ---------- PowerPoint and Excel ---------- */

  const selection = {
    text: config.selection?.text ?? '',
    writes: [],
    cellCount: config.selection?.cellCount ?? 1,
    formula: config.selection?.formula ?? '',
    failRead: config.selection?.failRead ?? false,
  };

  const settingsStore = { ...(config.settings ?? {}) };
  const saved = { count: 0 };

  const documentApi = {
    settings: {
      get: (name) => settingsStore[name] ?? null,
      set: (name, value) => {
        settingsStore[name] = value;
      },
      saveAsync(callback) {
        saved.count++;
        later(() => callback?.(succeeded()));
      },
    },
    getSelectedDataAsync(type, callback) {
      later(() => {
        if (selection.failRead) callback(failed(1001, 'The current selection is not supported.'));
        else callback(succeeded(selection.text));
      });
    },
    setSelectedDataAsync(data, options, callback) {
      later(() => {
        selection.text = data;
        selection.writes.push(data);
        callback?.(succeeded());
      });
    },
  };

  const Excel = {
    async run(batch) {
      const pending = [];
      const range = {
        load() {
          pending.push(() => {
            range.cellCount = selection.cellCount;
            range.formulas = [[selection.formula || selection.text]];
          });
        },
      };
      return batch({
        workbook: { getSelectedRange: () => range },
        async sync() {
          for (const work of pending.splice(0)) work();
        },
      });
    },
  };

  /* ---------- Office ---------- */

  const Office = {
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    CoercionType: { Text: 'text', Html: 'html' },
    EventType: { ItemChanged: 'olkItemSelectedChanged', OfficeThemeChanged: 'officeThemeChanged' },
    HostType: { Word: 'Word', Excel: 'Excel', PowerPoint: 'PowerPoint', Outlook: 'Outlook' },
    PlatformType: { PC: 'PC', Mac: 'Mac', OfficeOnline: 'OfficeOnline' },
    MailboxEnums: { BodyMode: { FullBody: 0, HostConfig: HOST_CONFIG } },
    context: {
      platform,
      partitionKey: config.partitionKey,
      officeTheme: config.theme,
      requirements: {
        isSetSupported: (name, version) => !unsupported.has(`${name} ${version}`),
      },
      document: documentApi,
      ...(host === 'Outlook' ? { mailbox } : {}),
    },
    onReady: () => Promise.resolve({ host, platform }),
  };

  target.Office = Office;
  target.Word = Word;
  target.Excel = Excel;
  return { word, outlook, selection, settings: settingsStore, saved, mailbox };
}
