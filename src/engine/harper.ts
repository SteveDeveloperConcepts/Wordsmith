/**
 * Thin wrapper around Harper (https://writewithharper.com), the open-source grammar
 * engine that runs locally as WebAssembly. Harper supplies spelling, agreement,
 * capitalization, and many usage checks; Wordsmith's own rules add the rest.
 */
import {
  Dialect as HarperDialect,
  LocalLinter,
  SuggestionKind,
  type BinaryModule,
  type LintConfig,
} from 'harper.js';
import type { Dialect } from './types';

export interface HarperSuggestion {
  kind: 'replace' | 'remove' | 'insert-after';
  text: string;
}

export interface HarperLint {
  from: number;
  to: number;
  rule: string;
  kind: string;
  message: string;
  suggestions: HarperSuggestion[];
}

export interface HarperOptions {
  dialect: Dialect;
  dictionary: string[];
  /** Harper rule names to switch off (without the "harper/" prefix). */
  disabledRules: string[];
  /** Flag contractions, for formal writing. */
  avoidContractions: boolean;
  oxfordComma: boolean;
}

const DIALECTS: Record<Dialect, HarperDialect> = {
  american: HarperDialect.American,
  british: HarperDialect.British,
  canadian: HarperDialect.Canadian,
  australian: HarperDialect.Australian,
  indian: HarperDialect.Indian,
};

/**
 * Harper rules Wordsmith replaces with its own goal-aware versions, or that are
 * too opinionated to enable for everyone.
 */
const ALWAYS_OFF = [
  'LongSentences', // Wordsmith's threshold depends on the audience goal
  'UseEllipsisCharacter', // "..." is fine
  'BoringWords', // covered by the engagement rules
  'UseTitleCase',
  'SpelledNumbers',
];

const MAX_CACHE = 4000;

export class HarperEngine {
  private linter: LocalLinter | null = null;
  private setupPromise: Promise<void> | null = null;
  private cache = new Map<string, HarperLint[]>();
  private applied = '';
  private options: HarperOptions = {
    dialect: 'american',
    dictionary: [],
    disabledRules: [],
    avoidContractions: false,
    oxfordComma: true,
  };
  /** Set when the WebAssembly engine could not be loaded. */
  error: string | null = null;

  constructor(private readonly binary: BinaryModule) {}

  get ready(): boolean {
    return this.linter !== null && this.error === null;
  }

  configure(options: HarperOptions): void {
    this.options = options;
  }

  /** Load and compile the engine. Safe to call repeatedly. */
  async setup(): Promise<void> {
    if (!this.setupPromise) {
      this.setupPromise = (async () => {
        try {
          const linter = new LocalLinter({ binary: this.binary, dialect: DIALECTS[this.options.dialect] });
          await linter.setup();
          this.linter = linter;
          this.error = null;
        } catch (err) {
          this.linter = null;
          this.error = err instanceof Error ? err.message : String(err);
        }
      })();
    }
    await this.setupPromise;
  }

  private async applyOptions(): Promise<void> {
    const linter = this.linter;
    if (!linter) return;
    const o = this.options;
    const key = JSON.stringify([o.dialect, o.dictionary, o.disabledRules, o.avoidContractions, o.oxfordComma]);
    if (key === this.applied) return;

    await linter.setDialect(DIALECTS[o.dialect]);

    const config: LintConfig = await linter.getDefaultLintConfig();
    for (const rule of ALWAYS_OFF) if (rule in config) config[rule] = false;
    if ('AvoidContractions' in config) config.AvoidContractions = o.avoidContractions;
    if ('OxfordComma' in config) config.OxfordComma = o.oxfordComma;
    for (const rule of o.disabledRules) if (rule in config) config[rule] = false;
    await linter.setLintConfig(config);

    await linter.clearWords();
    const words = o.dictionary.map((w) => w.trim()).filter(Boolean);
    if (words.length) await linter.importWords(words);

    this.cache.clear();
    this.applied = key;
  }

  /** Lint one block of plain text. Returns [] if the engine is unavailable. */
  async lint(text: string): Promise<HarperLint[]> {
    if (!text.trim()) return [];
    await this.setup();
    const linter = this.linter;
    if (!linter) return [];
    await this.applyOptions();

    const cached = this.cache.get(text);
    if (cached) return cached;

    const out: HarperLint[] = [];
    const organized = await linter.organizedLints(text, { language: 'plaintext' });
    for (const rule of Object.keys(organized)) {
      for (const lint of organized[rule]) {
        try {
          const span = lint.span();
          const from = span.start;
          const to = span.end;
          span.free();
          const suggestions: HarperSuggestion[] = [];
          for (const s of lint.suggestions()) {
            const k = s.kind();
            suggestions.push({
              kind: k === SuggestionKind.Remove ? 'remove' : k === SuggestionKind.InsertAfter ? 'insert-after' : 'replace',
              text: s.get_replacement_text(),
            });
            s.free();
          }
          out.push({ from, to, rule, kind: lint.lint_kind(), message: lint.message(), suggestions });
        } finally {
          lint.free();
        }
      }
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);

    if (this.cache.size >= MAX_CACHE) this.cache.clear();
    this.cache.set(text, out);
    return out;
  }

  /** Names of every rule the engine knows, for the settings screen. */
  async ruleNames(): Promise<string[]> {
    await this.setup();
    if (!this.linter) return [];
    return Object.keys(await this.linter.getDefaultLintConfig()).sort();
  }
}
