import {
  buildThroughputWeeks,
  isStale,
  isoWeekStart,
  lastIsoWeeks,
  parseAssignees,
  parseList,
  primaryComponent,
  topCounts,
} from "./summary.util";

describe("parseList", () => {
  it("splits, trims, and drops empties", () => {
    expect(parseList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parseList(null)).toEqual([]);
    expect(parseList("")).toEqual([]);
  });
});

describe("parseAssignees", () => {
  it("zips aligned names + emails into distinct assignees", () => {
    const r = parseAssignees("Sarah, Tom", "sarah@x.com, tom@x.com");
    expect(r).toEqual([
      { name: "Sarah", email: "sarah@x.com", key: "sarah@x.com" },
      { name: "Tom", email: "tom@x.com", key: "tom@x.com" },
    ]);
  });

  it("falls back to email as name when a name slot is missing", () => {
    const r = parseAssignees("", "only@x.com");
    expect(r).toEqual([{ name: "only@x.com", email: "only@x.com", key: "only@x.com" }]);
  });

  it("tolerates mismatched lengths (extra name has null email)", () => {
    const r = parseAssignees("A, B, C", "a@x.com, b@x.com");
    expect(r).toHaveLength(3);
    expect(r[2]).toEqual({ name: "C", email: null, key: "c" });
  });

  it("keys by lowercased email so dedup is case-insensitive", () => {
    expect(parseAssignees("Sarah", "Sarah@X.com")[0].key).toBe("sarah@x.com");
  });

  it("returns nothing for empty input", () => {
    expect(parseAssignees(null, null)).toEqual([]);
  });
});

describe("primaryComponent", () => {
  it("prefers list, then folder, then first tag", () => {
    expect(primaryComponent({ listName: "L", folderName: "F", tags: "t1,t2" })).toBe("L");
    expect(primaryComponent({ listName: null, folderName: "F", tags: "t1" })).toBe("F");
    expect(primaryComponent({ listName: " ", folderName: "", tags: "t1,t2" })).toBe("t1");
    expect(primaryComponent({ listName: null, folderName: null, tags: null })).toBeNull();
  });
});

describe("topCounts", () => {
  it("returns top-N desc, ties broken by label", () => {
    const m = new Map([
      ["a", 1],
      ["b", 3],
      ["c", 3],
    ]);
    expect(topCounts(m, 2)).toEqual([
      { component: "b", taskCount: 3 },
      { component: "c", taskCount: 3 },
    ]);
  });
});

describe("isoWeekStart / lastIsoWeeks", () => {
  it("returns the Monday of the week (UTC)", () => {
    // 2026-06-28 is a Sunday → Monday is 2026-06-22.
    expect(isoWeekStart(new Date("2026-06-28T12:00:00Z"))).toBe("2026-06-22");
    // 2026-06-22 is a Monday → itself.
    expect(isoWeekStart(new Date("2026-06-22T00:00:00Z"))).toBe("2026-06-22");
  });

  it("produces n consecutive week-starts oldest→newest ending at now's week", () => {
    const weeks = lastIsoWeeks(new Date("2026-06-28T00:00:00Z"), 3);
    expect(weeks).toEqual(["2026-06-08", "2026-06-15", "2026-06-22"]);
  });
});

describe("buildThroughputWeeks", () => {
  it("zero-fills missing weeks and merges created/closed", () => {
    const now = new Date("2026-06-28T00:00:00Z");
    const out = buildThroughputWeeks(
      [{ week: "2026-06-22", count: 5 }],
      [{ week: "2026-06-15", count: 2 }],
      now,
      3,
    );
    expect(out).toEqual([
      { week: "2026-06-08", created: 0, closed: 0 },
      { week: "2026-06-15", created: 0, closed: 2 },
      { week: "2026-06-22", created: 5, closed: 0 },
    ]);
  });
});

describe("isStale", () => {
  it("is fresh when counts are equal", () => {
    expect(isStale(100, 100)).toBe(false);
  });
  it("is fresh for sub-2% drift", () => {
    expect(isStale(100, 101)).toBe(false); // 1 <= floor(101*0.02)=2
  });
  it("is stale once drift exceeds 2% (min 1 task)", () => {
    expect(isStale(100, 110)).toBe(true);
    expect(isStale(50, 0)).toBe(true);
    // A single-task move is not material (min threshold of 1).
    expect(isStale(0, 1)).toBe(false);
  });
});
