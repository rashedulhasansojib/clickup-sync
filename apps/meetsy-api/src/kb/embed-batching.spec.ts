import { embedInBatches, toVectorLiteral } from "./kb.processor";

describe("embedInBatches", () => {
  it("calls the embedder once per ≤batchSize chunk and preserves sourceId→vector alignment", async () => {
    const calls: string[][] = [];
    const embedder = {
      embed: async (input: string[], opts: { dimensions: number }) => {
        expect(opts.dimensions).toBe(1024);
        calls.push(input);
        // Echo a tiny deterministic vector derived from the content length.
        return input.map((c) => [c.length, 0, 0]);
      },
    };
    const cards = Array.from({ length: 5 }, (_, i) => ({
      sourceId: `t${i}`,
      content: "x".repeat(i + 1),
    }));

    const out = await embedInBatches(embedder, cards, 2);

    // 5 items / batch 2 → 3 calls (2,2,1)
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(out.size).toBe(5);
    expect(out.get("t0")).toEqual([1, 0, 0]);
    expect(out.get("t4")).toEqual([5, 0, 0]);
  });

  it("returns an empty map for no inputs (no embedder call)", async () => {
    const embed = jest.fn();
    const out = await embedInBatches({ embed }, [], 256);
    expect(out.size).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("toVectorLiteral", () => {
  it("formats a number array as a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, -0.3])).toBe("[0.1,0.2,-0.3]");
  });
});
