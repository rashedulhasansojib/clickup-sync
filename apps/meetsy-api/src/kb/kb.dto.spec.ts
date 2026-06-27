import { hasCoverageGap, lookbackDaysForRange, windowStart, KbRangeSchema } from "./kb.dto";

describe("lookbackDaysForRange", () => {
  it("maps each preset to its day count", () => {
    expect(lookbackDaysForRange("3m")).toBe(90);
    expect(lookbackDaysForRange("6m")).toBe(180);
    expect(lookbackDaysForRange("12m")).toBe(365);
    expect(lookbackDaysForRange("24m")).toBe(730);
    expect(lookbackDaysForRange("36m")).toBe(1095);
    expect(lookbackDaysForRange("all")).toBe(36_500);
  });

  it("covers every enum member", () => {
    for (const r of KbRangeSchema.options) {
      expect(lookbackDaysForRange(r)).toBeGreaterThan(0);
    }
  });
});

describe("windowStart", () => {
  it("is now − lookbackDays", () => {
    const now = new Date("2026-06-28T00:00:00Z");
    const start = windowStart("3m", now);
    expect(start.toISOString().slice(0, 10)).toBe("2026-03-30"); // 90 days back
  });
});

describe("hasCoverageGap", () => {
  it("is true when the mirrored window is narrower than requested", () => {
    expect(hasCoverageGap(365, 90)).toBe(true); // requested 12m, mirrored 3m
    expect(hasCoverageGap(365, 0)).toBe(true); // nothing mirrored
    expect(hasCoverageGap(365, null)).toBe(true);
    expect(hasCoverageGap(365, undefined)).toBe(true);
  });

  it("is false when the mirrored window already covers the request", () => {
    expect(hasCoverageGap(90, 365)).toBe(false); // mirrored wider
    expect(hasCoverageGap(90, 90)).toBe(false); // equal
  });

  it("tolerates day-boundary slack so it does not re-trigger on rounding", () => {
    expect(hasCoverageGap(91, 90)).toBe(false); // within 1-day slack
    expect(hasCoverageGap(92, 90)).toBe(true); // beyond slack
  });
});
