/**
 * Paragraph-aware text chunker for the document RAG knowledge base (Phase 2b).
 *
 * Pure + deterministic so it can be unit-tested without any I/O. Splits a long
 * document into overlapping, roughly token-sized chunks suitable for embedding:
 *
 *  - Tokens are approximated as `ceil(chars / 4)` — the standard rule-of-thumb for
 *    English prose. So a `targetTokens` budget maps to `targetTokens * 4` chars.
 *  - Packing is paragraph-aware: paragraphs (blank-line separated) are greedily
 *    packed into a chunk until the next paragraph would exceed the char budget.
 *  - A single paragraph larger than the budget is hard-split on whitespace
 *    boundaries so no text is ever lost.
 *  - Adjacent chunks share a small overlap (the trailing slice of the previous
 *    chunk, trimmed to a word boundary) so context isn't severed mid-thought.
 */

export interface TextChunk {
  /** Contiguous position in the emitted sequence, 0-based. */
  index: number;
  /** The chunk text (trimmed, may include a leading overlap from the prior chunk). */
  content: string;
}

export interface ChunkOptions {
  /** Soft size budget per chunk, in approximate tokens. Default 400. */
  targetTokens?: number;
  /** Fraction of the target size re-shared with the next chunk as overlap. Default 0.15. */
  overlapRatio?: number;
}

const DEFAULT_TARGET_TOKENS = 400;
const DEFAULT_OVERLAP_RATIO = 0.15;
const CHARS_PER_TOKEN = 4;

/**
 * Approximate the token count of a string. We use the widely-cited heuristic of
 * ~4 characters per token for English text rather than pulling in a real BPE
 * tokenizer — the chunker only needs a rough, deterministic size signal.
 */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Take the trailing `maxChars` of `s`, then advance to the next word boundary so
 * the returned tail does not begin in the middle of a word. Returns "" when the
 * tail is a single unbroken token (nothing useful to share) or when `maxChars`
 * is non-positive.
 */
function tailAtWordBoundary(s: string, maxChars: number): string {
  if (maxChars <= 0 || s.length === 0) return "";
  const tail = s.slice(Math.max(0, s.length - maxChars));
  const firstWs = tail.search(/\s/);
  // No whitespace at all → it's one long token; don't emit a mid-word fragment.
  if (firstWs < 0) return "";
  return tail.slice(firstWs + 1).trim();
}

/**
 * Hard-split an oversized paragraph into sub-pieces of ~`targetChars`, preferring
 * whitespace boundaries at or before the budget and only cutting mid-word when no
 * boundary exists. Index-based so a single giant paragraph stays O(n), not O(n²).
 */
function hardSplitParagraph(para: string, targetChars: number): string[] {
  const pieces: string[] = [];
  const n = para.length;
  let start = 0;

  while (start < n) {
    let end = Math.min(start + targetChars, n);
    if (end < n) {
      // Back off to the last whitespace within the budget, if any beyond `start`.
      let boundary = para.lastIndexOf(" ", end);
      const nl = para.lastIndexOf("\n", end);
      if (nl > boundary) boundary = nl;
      if (boundary > start) end = boundary;
    }
    const piece = para.slice(start, end).trim();
    if (piece) pieces.push(piece);
    // Advance past the cut, skipping any whitespace so it isn't re-emitted.
    start = end;
    while (start < n && /\s/.test(para[start])) start++;
  }

  return pieces;
}

/**
 * Split `text` into overlapping, paragraph-aware chunks. Empty or whitespace-only
 * input yields []. Indices are contiguous 0..N after empty chunks are dropped.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapRatio = opts.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  const targetChars = Math.max(1, targetTokens * CHARS_PER_TOKEN);
  const overlapChars = Math.max(0, Math.floor(targetChars * overlapRatio));

  if (!text || !text.trim()) return [];

  // Normalize: collapse runs of 3+ blank lines (each optionally indented) down to
  // a single blank line so paragraph detection is stable.
  const normalized = text.replace(/(?:[ \t]*\n){3,}/g, "\n\n");

  const paragraphs = normalized.split(/\n\s*\n/);

  // Pass 1 — greedy paragraph packing into raw chunk bodies (no overlap yet).
  const rawBodies: string[] = [];
  let current = "";

  for (const rawPara of paragraphs) {
    const para = rawPara.trim();
    if (!para) continue;

    if (para.length > targetChars) {
      // Flush whatever is buffered, then hard-split the oversized paragraph.
      if (current) {
        rawBodies.push(current);
        current = "";
      }
      for (const piece of hardSplitParagraph(para, targetChars)) {
        rawBodies.push(piece);
      }
      continue;
    }

    if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= targetChars) {
      current += "\n\n" + para;
    } else {
      rawBodies.push(current);
      current = para;
    }
  }
  if (current) rawBodies.push(current);

  // Pass 2 — prepend each chunk with a word-boundary tail of the previously
  // emitted chunk's content, and re-number contiguously after dropping empties.
  const chunks: TextChunk[] = [];
  let prevContent = "";
  let index = 0;

  for (const body of rawBodies) {
    const trimmedBody = body.trim();
    if (!trimmedBody) continue;

    let content = trimmedBody;
    if (overlapChars > 0 && prevContent) {
      const tail = tailAtWordBoundary(prevContent, overlapChars);
      if (tail) content = tail + "\n\n" + content;
    }

    content = content.trim();
    if (!content) continue;

    chunks.push({ index: index++, content });
    prevContent = content;
  }

  return chunks;
}
