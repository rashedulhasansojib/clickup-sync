import { rrfFuse, RRF_K } from "./rrf";

const hit = (sourceId: string) => ({ sourceId });

describe("rrfFuse", () => {
  it("ranks a document appearing high in both lists above single-list docs", () => {
    // A is #1 in both lists; B is #1 keyword only; C is #1 vector only.
    const vector = [hit("A"), hit("C"), hit("X")];
    const keyword = [hit("A"), hit("B"), hit("Y")];
    const fused = rrfFuse([vector, keyword], 10);
    expect(fused[0].sourceId).toBe("A");
    // A's score = 1/(60+1) + 1/(60+1)
    expect(fused[0].score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it("scores a doc by Σ 1/(k+rank) across the lists it appears in", () => {
    const vector = [hit("A"), hit("B")]; // B at rank 2
    const keyword = [hit("B"), hit("A")]; // B at rank 1
    const fused = rrfFuse([vector, keyword], 10);
    const b = fused.find((f) => f.sourceId === "B")!;
    expect(b.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10);
  });

  it("breaks score ties deterministically by sourceId", () => {
    // Z and A each appear once at rank 1 in different lists → equal scores.
    const fused = rrfFuse([[hit("Z")], [hit("A")]], 10);
    expect(fused.map((f) => f.sourceId)).toEqual(["A", "Z"]);
  });

  it("honors topK", () => {
    const list = [hit("A"), hit("B"), hit("C"), hit("D")];
    expect(rrfFuse([list], 2)).toHaveLength(2);
  });

  it("returns the first-seen record for a sourceId", () => {
    const v = [{ sourceId: "A", branch: "vector" }];
    const k = [{ sourceId: "A", branch: "keyword" }];
    const fused = rrfFuse([v, k], 10);
    expect(fused[0].hit.branch).toBe("vector");
  });
});
