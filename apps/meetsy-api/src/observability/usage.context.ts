import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-run LLM usage accounting via AsyncLocalStorage.
 *
 * The pipeline makes several Azure calls across many stages. Rather than thread
 * a usage accumulator through every stage signature, we run the whole pipeline
 * inside an ALS context; AzureOpenAIService records each call's tokens into the
 * current context. This propagates across awaits with zero plumbing.
 */
export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

const storage = new AsyncLocalStorage<UsageTotals>();

/** Run `fn` in a fresh usage context and return its result + accumulated usage. */
export async function runWithUsage<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; usage: UsageTotals }> {
  const usage: UsageTotals = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const result = await storage.run(usage, fn);
  return { result, usage };
}

/** Add one LLM call's tokens to the current context (no-op outside a context). */
export function recordUsage(promptTokens: number, completionTokens: number): void {
  const totals = storage.getStore();
  if (!totals) return;
  totals.promptTokens += promptTokens;
  totals.completionTokens += completionTokens;
  totals.calls += 1;
}
