import { approxTokens, chunkText } from "./chunk-text";

/** Lowercased word set of a string, for "no text lost" subset assertions. */
function wordSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length > 0),
  );
}

describe("approxTokens", () => {
  it("approximates ~4 chars per token (ceil)", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
  });
});

describe("chunkText", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  \t  \n ")).toEqual([]);
  });

  it("returns a single chunk (index 0) for short text", () => {
    const chunks = chunkText("Hello world. This is a short document.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].content).toContain("short document");
  });

  it("splits multi-paragraph text exceeding the budget into multiple contiguous chunks", () => {
    // Each paragraph ~600 chars; with a 400-token (~1600 char) budget we should
    // get several chunks once we have enough paragraphs.
    const para = "word ".repeat(120).trim(); // ~600 chars
    const text = Array.from({ length: 10 }, (_, i) => `Paragraph ${i}. ${para}`).join("\n\n");

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Indices are contiguous 0..N-1.
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("shares overlapping text between adjacent chunks", () => {
    const para = "alpha beta gamma delta epsilon zeta ".repeat(60).trim();
    const text = Array.from({ length: 6 }, (_, i) => `Section ${i}: ${para}`).join("\n\n");

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);

    // The start of chunk[1] should reproduce a slice taken from the END of chunk[0].
    const prevTail = chunks[0].content.slice(-60).trim();
    // Use a stable inner substring from that tail to avoid boundary brittleness.
    const probe = prevTail.split(/\s+/).slice(0, 4).join(" ");
    expect(probe.length).toBeGreaterThan(0);
    expect(chunks[1].content).toContain(probe);
  });

  it("hard-splits an oversized single paragraph without losing text", () => {
    // ~5000 chars, no blank lines → one paragraph far over the budget.
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`);
    const text = words.join(" "); // ~ several thousand chars, single paragraph

    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.index).toBe(i));

    // No text lost: every original word appears somewhere across the chunks.
    const union = new Set<string>();
    for (const c of chunks) for (const w of wordSet(c.content)) union.add(w);
    for (const w of wordSet(text)) expect(union.has(w)).toBe(true);
  });

  it("honors custom opts: smaller targetTokens yields more chunks", () => {
    const para = "lorem ipsum dolor sit amet ".repeat(50).trim();
    const text = Array.from({ length: 8 }, (_, i) => `Block ${i}. ${para}`).join("\n\n");

    const big = chunkText(text, { targetTokens: 400 });
    const small = chunkText(text, { targetTokens: 50 });
    expect(small.length).toBeGreaterThan(big.length);
    small.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("collapses 3+ blank lines and drops empty chunks", () => {
    const text = "First paragraph.\n\n\n\n\nSecond paragraph.";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("First paragraph.");
    expect(chunks[0].content).toContain("Second paragraph.");
  });
});
