import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBinaryModuleFromUrl, type BinaryModule } from 'harper.js';
import { Analyzer } from '@engine/analyze';
import {
  DEFAULT_ENGINE_SETTINGS,
  type AnalysisResult,
  type Block,
  type EngineSettings,
  type Fix,
  type Issue,
} from '@engine/types';

let binary: BinaryModule | null = null;

/**
 * Harper's WebAssembly binary, loaded from node_modules. Harper's own Node
 * loader mishandles Windows drive letters, so the bytes go through a blob URL.
 */
export function harperBinary(): BinaryModule {
  if (!binary) {
    const bytes = readFileSync(join(process.cwd(), 'node_modules/harper.js/dist/harper_wasm_slim_bg.wasm'));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
    binary = createBinaryModuleFromUrl(url, 'slim');
  }
  return binary;
}

export function settings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    ...DEFAULT_ENGINE_SETTINGS,
    ...overrides,
    goals: { ...DEFAULT_ENGINE_SETTINGS.goals, ...overrides.goals },
    options: { ...DEFAULT_ENGINE_SETTINGS.options, ...overrides.options },
    checks: { ...DEFAULT_ENGINE_SETTINGS.checks, ...overrides.checks },
  };
}

/** Split text on blank lines into paragraph blocks. */
export function paragraphs(text: string): Block[] {
  return text.split(/\n{2,}/).map((t) => ({ text: t, kind: 'paragraph' as const }));
}

/** An analyzer running only Wordsmith's built-in rules (no WebAssembly engine). */
export function rulesOnly(overrides: Partial<EngineSettings> = {}): Analyzer {
  const analyzer = new Analyzer();
  analyzer.configure(settings(overrides));
  return analyzer;
}

/** An analyzer with the full grammar engine. */
export function fullAnalyzer(overrides: Partial<EngineSettings> = {}): Analyzer {
  const analyzer = new Analyzer(harperBinary());
  analyzer.configure(settings(overrides));
  return analyzer;
}

export function applyFix(text: string, fix: Fix): string {
  return text.slice(0, fix.from) + fix.text + text.slice(fix.to);
}

export async function check(analyzer: Analyzer, text: string): Promise<AnalysisResult> {
  return analyzer.analyze({ blocks: paragraphs(text) });
}

export const rules = (result: AnalysisResult): string[] => result.issues.map((i) => i.ruleId);

export function find(result: AnalysisResult, ruleId: string): Issue | undefined {
  return result.issues.find((i) => i.ruleId === ruleId);
}

/** Apply the first fix of the first issue raised by `ruleId` and return the new text. */
export function fixed(result: AnalysisResult, text: string, ruleId: string, option = 0): string {
  const issue = find(result, ruleId);
  if (!issue) throw new Error(`no ${ruleId} issue in: ${text}\n  got: ${rules(result).join(', ') || '(none)'}`);
  const fix = issue.fixes[option];
  if (!fix) throw new Error(`${ruleId} has no fix #${option} in: ${text}`);
  return applyFix(text, fix);
}
