import { decodePatternKey, patternKey } from "./learning-aggregate";

/**
 * v2 Phase 3 (PR-L) — the pattern key is a base64url slug of
 * `${field}|${predicted}|${confirmed}`, used as a URL path segment on
 * `/learning/patterns/:key/history`. Encoding/decoding must round-trip
 * losslessly across characters that URLs would otherwise corrupt (`/`,
 * `+`, `=`, unicode).
 */
describe("patternKey / decodePatternKey", () => {
  const cases: Array<{ label: string; field: string; predicted: string; confirmed: string }> = [
    { label: "ascii", field: "assignee", predicted: "Alice", confirmed: "Bob" },
    { label: "spaces", field: "assignee", predicted: "Alice Smith", confirmed: "Bob Jones" },
    {
      label: "slashes (sprint names carry `/`)",
      field: "sprint",
      predicted: "Team A / Sprint-24",
      confirmed: "Team A / Sprint-25",
    },
    {
      label: "unicode",
      field: "assignee",
      predicted: "Renée",
      confirmed: "François",
    },
  ];

  for (const c of cases) {
    it(`round-trips ${c.label}`, () => {
      const key = patternKey(c.field, c.predicted, c.confirmed);
      // URL-safe — no plus/slash/equals in the emitted slug.
      expect(key).not.toMatch(/[+/=]/);
      const decoded = decodePatternKey(key);
      expect(decoded).toEqual({
        field: c.field,
        predicted: c.predicted,
        confirmed: c.confirmed,
      });
    });
  }

  it("rejects malformed keys (missing separators)", () => {
    const bogus = Buffer.from("just_one_segment", "utf8").toString("base64");
    expect(() => decodePatternKey(bogus)).toThrow(/Malformed pattern key/);
  });

  it("rejects malformed keys (non-base64 chars)", () => {
    // `%%%` is neither base64 nor base64url — decode returns garbage that
    // doesn't split into 3 parts.
    expect(() => decodePatternKey("%%%")).toThrow();
  });
});
