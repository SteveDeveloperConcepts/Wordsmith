import { clarityRules } from './clarity';
import type { RawIssue, RuleContext } from './context';
import { deliveryRules } from './delivery';
import { engagementRules } from './engagement';
import { grammarRules } from './grammar';
import { punctuationRules } from './punctuation';
import { sentenceRules } from './sentences';

/** Run every built-in rule over one block. */
export function runBlockRules(ctx: RuleContext): RawIssue[] {
  const out: RawIssue[] = [];
  if (ctx.kind === 'code' || !ctx.text.trim()) return out;
  grammarRules(ctx, out);
  punctuationRules(ctx, out);
  sentenceRules(ctx, out);
  clarityRules(ctx, out);
  engagementRules(ctx, out);
  deliveryRules(ctx, out);
  return out;
}

export { overusedWords } from './engagement';
export { buildProfile, makeContext } from './context';
export type { Profile, RawIssue, RuleContext } from './context';
