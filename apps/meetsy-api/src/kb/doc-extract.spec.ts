import pdfParse from "pdf-parse";
import { extractText, isSupportedMime, SUPPORTED_MIMES } from "./doc-extract";

// Auto-mock pdf-parse to a jest.fn so PDF tests need no real binary.
jest.mock("pdf-parse", () => jest.fn());

const mockPdfParse = pdfParse as unknown as jest.Mock;

describe("isSupportedMime", () => {
  it("returns true for supported types", () => {
    for (const m of SUPPORTED_MIMES) expect(isSupportedMime(m)).toBe(true);
  });

  it("returns false for unsupported types", () => {
    expect(isSupportedMime("application/msword")).toBe(false);
    expect(isSupportedMime("image/png")).toBe(false);
    expect(isSupportedMime("")).toBe(false);
  });
});

describe("extractText", () => {
  beforeEach(() => mockPdfParse.mockReset());

  it("decodes text/plain as UTF-8 with null pageCount", async () => {
    const result = await extractText(Buffer.from("Hello, plain text", "utf8"), "text/plain");
    expect(result.text).toBe("Hello, plain text");
    expect(result.pageCount).toBeNull();
    expect(mockPdfParse).not.toHaveBeenCalled();
  });

  it("decodes text/markdown as UTF-8 with null pageCount", async () => {
    const result = await extractText(Buffer.from("# Title\n\nBody", "utf8"), "text/markdown");
    expect(result.text).toBe("# Title\n\nBody");
    expect(result.pageCount).toBeNull();
  });

  it("throws for unsupported MIME types", async () => {
    await expect(extractText(Buffer.from("x"), "application/zip")).rejects.toThrow(
      "Unsupported document type: application/zip",
    );
  });

  it("extracts PDF text and page count via pdf-parse", async () => {
    mockPdfParse.mockResolvedValue({ text: "Hello world from PDF", numpages: 3 });
    const result = await extractText(Buffer.from("%PDF-fake"), "application/pdf");
    expect(result.text).toBe("Hello world from PDF");
    expect(result.pageCount).toBe(3);
    expect(mockPdfParse).toHaveBeenCalledTimes(1);
  });

  it("rejects a scanned/image-only PDF with 'No extractable text'", async () => {
    mockPdfParse.mockResolvedValue({ text: "   ", numpages: 1 });
    await expect(extractText(Buffer.from("%PDF-fake"), "application/pdf")).rejects.toThrow(
      /^No extractable text/,
    );
  });
});
