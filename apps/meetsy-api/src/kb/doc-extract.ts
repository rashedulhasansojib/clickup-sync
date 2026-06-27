/**
 * Document text extraction for the RAG knowledge base (Phase 2b). Turns an
 * uploaded file buffer into plain text plus a page count (when known). Kept thin
 * and side-effect-free apart from the PDF parse so it's easy to unit-test by
 * mocking `pdf-parse`.
 */
import pdfParse from "pdf-parse";

/** MIME types this extractor accepts. */
export type ExtractMime = "application/pdf" | "text/plain" | "text/markdown";

export interface ExtractResult {
  /** The extracted UTF-8 text. */
  text: string;
  /** Page count for paginated formats (PDF); `null` for flat text formats. */
  pageCount: number | null;
}

/** The supported MIME types, in a fixed order (also used in error messages). */
export const SUPPORTED_MIMES: ExtractMime[] = ["application/pdf", "text/plain", "text/markdown"];

/** Minimum trimmed text length for a PDF to be considered to have real content. */
const MIN_PDF_TEXT_CHARS = 10;

/** Narrowing guard: is `m` one of the supported MIME types? */
export function isSupportedMime(m: string): m is ExtractMime {
  return (SUPPORTED_MIMES as string[]).includes(m);
}

/**
 * Extract text from an uploaded document buffer.
 *
 *  - `text/plain` / `text/markdown` → decoded as UTF-8, `pageCount` is null.
 *  - `application/pdf` → parsed with `pdf-parse`; a near-empty result is treated
 *    as a scanned/image-only PDF and throws ("No extractable text ...").
 *  - Any other MIME type throws an "Unsupported document type" error.
 */
export async function extractText(buffer: Buffer, mimeType: string): Promise<ExtractResult> {
  if (!isSupportedMime(mimeType)) {
    throw new Error(
      `Unsupported document type: ${mimeType}. Supported: ${SUPPORTED_MIMES.join(", ")}`,
    );
  }

  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    return { text: buffer.toString("utf8"), pageCount: null };
  }

  // application/pdf
  const result = await pdfParse(buffer);
  const text = result.text ?? "";
  if (text.trim().length < MIN_PDF_TEXT_CHARS) {
    throw new Error("No extractable text (scanned or image-only PDF?)");
  }

  return { text, pageCount: result.numpages ?? null };
}
