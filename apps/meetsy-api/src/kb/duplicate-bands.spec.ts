import { classifyDuplicates, DUP_FLAG, DUP_SUGGEST } from "./duplicate-bands";

describe("classifyDuplicates", () => {
  it("flags >= flag band, suggests [suggest, flag), ignores below suggest", () => {
    const out = classifyDuplicates(
      [
        { taskId: "a", sim: 0.75 }, // >= flag (0.72)
        { taskId: "b", sim: 0.68 }, // in [suggest, flag)
        { taskId: "c", sim: 0.6 }, // < suggest (0.64)
        { taskId: "d", sim: DUP_FLAG },
        { taskId: "e", sim: DUP_SUGGEST },
      ],
      undefined,
      10,
    );
    const byId = Object.fromEntries(out.map((h) => [h.taskId, h.band]));
    expect(byId.a).toBe("flag");
    expect(byId.d).toBe("flag");
    expect(byId.b).toBe("suggest");
    expect(byId.e).toBe("suggest");
    expect(byId.c).toBeUndefined();
  });

  it("sorts by score desc and caps the count", () => {
    const out = classifyDuplicates(
      [
        { taskId: "a", sim: 0.83 },
        { taskId: "b", sim: 0.99 },
        { taskId: "c", sim: 0.91 },
        { taskId: "d", sim: 0.88 },
      ],
      undefined,
      2,
    );
    expect(out.map((h) => h.taskId)).toEqual(["b", "c"]);
  });

  it("returns [] when nothing clears the suggest band", () => {
    expect(classifyDuplicates([{ taskId: "a", sim: 0.5 }])).toEqual([]);
  });

  it("respects per-call band overrides (v2 Phase 5)", () => {
    // Neighbour at 0.60: under default DUP_SUGGEST=0.64 it's below the floor,
    // but a candidate config with dupSuggest=0.55 should classify it as
    // "suggest" and DUP_FLAG=0.72 lowered to 0.58 should turn it into "flag".
    const relaxed = classifyDuplicates(
      [{ taskId: "a", sim: 0.6 }],
      { dupFlag: 0.58, dupSuggest: 0.55 },
    );
    expect(relaxed).toEqual([{ taskId: "a", score: 0.6, band: "flag" }]);

    // Same neighbour under a tighter candidate config → nothing surfaces.
    const tight = classifyDuplicates(
      [{ taskId: "a", sim: 0.6 }],
      { dupFlag: 0.9, dupSuggest: 0.7 },
    );
    expect(tight).toEqual([]);
  });
});
