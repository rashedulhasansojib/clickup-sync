import type { KbContextHit } from "../kb/kb-search.service";

/**
 * Phase 2c.1 — pure helpers for grounding the analysis pipeline in KB history.
 * Kept separate from the processor so the query construction + prompt formatting
 * are unit-testable without Redis/Prisma/Azure.
 */

/**
 * Build the retrieval query for a meeting. Keyed on the SUMMARY + topics + task
 * titles (concise, fully embeddable) — NOT the raw transcript, which overflows
 * the embedding token limit and is noisy. (See the 2c spec / advisor note.)
 */
export function buildContextQuery(summary: string, topics: string[], taskTitles: string[]): string {
  return [summary, topics.join(", "), taskTitles.join("; ")]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Format retrieved hits into a compact, labelled block for prompt injection.
 * Returns "" when there are no hits, so callers leave the prompt untouched.
 */
export function formatContextForPrompt(hits: KbContextHit[]): string {
  if (hits.length === 0) return "";
  return hits
    .map((h, i) => {
      const label = h.sourceType === "document" ? "DOC" : "TASK";
      const snippet = h.snippet.replace(/\s+/g, " ").trim();
      return `[${i + 1}] (${label}) ${snippet}`;
    })
    .join("\n");
}
