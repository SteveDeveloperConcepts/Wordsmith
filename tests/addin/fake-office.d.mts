export interface FakeParagraphSpec {
  text: string;
  styleBuiltIn?: string;
  isListItem?: boolean;
  tableNestingLevel?: number;
  outlineLevel?: number;
  bold?: Array<[number, number]>;
  links?: Array<[number, number, string]>;
  fields?: Array<[number, number]>;
  revisions?: Array<[number, number]>;
  deleted?: Array<[number, number]>;
}

export interface FakeConfig {
  host?: 'Word' | 'Outlook' | 'PowerPoint' | 'Excel';
  platform?: 'PC' | 'Mac' | 'OfficeOnline';
  unsupported?: string[];
  partitionKey?: string;
  theme?: { bodyBackgroundColor: string };
  settings?: Record<string, unknown>;
  word?: {
    paragraphs?: Array<string | FakeParagraphSpec>;
    changeTrackingMode?: 'Off' | 'TrackAll' | 'TrackMineOnly';
    readOnly?: boolean;
  };
  outlook?: {
    body?: string;
    bodyType?: 'html' | 'text';
    subject?: string;
    conversationBody?: string | null;
    hostName?: string;
    compose?: boolean;
    staleReadsAfterWrite?: number;
    rewriteOnWrite?: ((html: string) => string) | null;
  };
  selection?: { text?: string; cellCount?: number; formula?: string; failRead?: boolean };
}

export interface FakeParagraph {
  text: string;
  bold: boolean[];
}

export interface FakeHandles {
  word: {
    paragraphs: FakeParagraph[];
    selection: string | null;
    readOnly: boolean;
    log: Array<{ op: string; before: string; text: string }>;
    bodyReads: number;
    addParagraph(spec: string | FakeParagraphSpec, at?: number): void;
  };
  outlook: {
    body: string;
    subject: string;
    conversationBody: string | null;
    writes: Array<{ body?: string; subject?: string }>;
    bodyOptions: Array<{ call: string; bodyMode?: number; coercionType?: string }>;
    failReadIn: number;
    switchItem(next: Partial<FakeConfig['outlook']>): void;
  };
  selection: { text: string; writes: string[]; cellCount: number; formula: string };
  settings: Record<string, unknown>;
  saved: { count: number };
}

export function installFakeOffice(target: object, config?: FakeConfig): FakeHandles;
