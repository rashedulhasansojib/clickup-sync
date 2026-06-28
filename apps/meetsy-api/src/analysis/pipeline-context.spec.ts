import { buildContextQuery, formatContextForPrompt } from "./pipeline-context";
import type { KbContextHit } from "../kb/kb-search.service";

describe("pipeline-context helpers", () => {
  describe("buildContextQuery", () => {
    it("combines summary, topics, and task titles; drops empties", () => {
      const q = buildContextQuery("Energy reporting sync", ["dashboard", "PDF"], ["Build portal", "Fix export"]);
      expect(q).toContain("Energy reporting sync");
      expect(q).toContain("dashboard, PDF");
      expect(q).toContain("Build portal; Fix export");
    });
    it("returns empty string when everything is blank", () => {
      expect(buildContextQuery("  ", [], [])).toBe("");
    });
  });

  describe("formatContextForPrompt", () => {
    const hits: KbContextHit[] = [
      { sourceType: "clickup_task", sourceId: "t1", score: 0.9, snippet: "Title: Energy Audit  Web Portal" },
      { sourceType: "document", sourceId: "d1", score: 0.8, snippet: "Vendor payment policy" },
    ];
    it("returns '' for no hits (so callers leave the prompt untouched)", () => {
      expect(formatContextForPrompt([])).toBe("");
    });
    it("labels tasks vs docs and numbers them, collapsing whitespace", () => {
      const out = formatContextForPrompt(hits);
      expect(out).toContain("[1] (TASK) Title: Energy Audit Web Portal");
      expect(out).toContain("[2] (DOC) Vendor payment policy");
    });
  });
});
