import { TaskMapperService, MappableTask } from "./task-mapper.service";

describe("TaskMapperService", () => {
  const svc = new TaskMapperService();

  const base: MappableTask = {
    title: "Ship the export",
    description: "Build the styled Excel export.",
    acceptanceCriteria: ["Columns match the UI", "Handles empty rows"],
    evidence: [{ quote: "we need this by Friday", speaker: "Sarah", timestamp: "00:12:30" }],
    subtasks: ["Wire the button", "Add the worker"],
    dependencies: ["t3"],
    priority: "high",
    dueDate: "2026-07-01",
    tags: ["export", "q3"],
  };

  it("maps name + priority + tags", () => {
    const p = svc.map(base);
    expect(p.name).toBe("Ship the export");
    expect(p.priority).toBe(2); // high → 2
    expect(p.tags).toEqual(["export", "q3"]);
  });

  it("maps the full priority scale", () => {
    expect(svc.map({ ...base, priority: "urgent" }).priority).toBe(1);
    expect(svc.map({ ...base, priority: "high" }).priority).toBe(2);
    expect(svc.map({ ...base, priority: "normal" }).priority).toBe(3);
    expect(svc.map({ ...base, priority: "low" }).priority).toBe(4);
  });

  it("converts a bare date to NOON-UTC epoch ms with due_date_time:false", () => {
    // Anchored at noon UTC so a workspace timezone can't shift the date a day.
    const p = svc.map(base);
    expect(p.due_date).toBe(Date.parse("2026-07-01T12:00:00Z"));
    expect(p.due_date_time).toBe(false);
  });

  it("passes a full datetime due string through as-is", () => {
    const p = svc.map({ ...base, dueDate: "2026-07-01T09:30:00Z" });
    expect(p.due_date).toBe(Date.parse("2026-07-01T09:30:00Z"));
  });

  it("skips an unparseable/natural-language due date", () => {
    const p = svc.map({ ...base, dueDate: "end of sprint" });
    expect(p.due_date).toBeUndefined();
    expect(p.due_date_time).toBeUndefined();
  });

  it("skips a null due date", () => {
    const p = svc.map({ ...base, dueDate: null });
    expect(p.due_date).toBeUndefined();
  });

  it("omits assignees when unassigned", () => {
    expect(svc.map(base, {}).assignees).toBeUndefined();
    expect(svc.map(base, { clickupUserId: null }).assignees).toBeUndefined();
  });

  it("includes a numeric assignee when confirmed", () => {
    expect(svc.map(base, { clickupUserId: "42" }).assignees).toEqual([42]);
  });

  it("includes a status only when defaultStatus is given", () => {
    expect(svc.map(base, {}).status).toBeUndefined();
    expect(svc.map(base, { defaultStatus: "to do" }).status).toBe("to do");
  });

  it("composes markdown with description, criteria, evidence, subtasks, deps", () => {
    const md = svc.map(base).markdown_description ?? "";
    expect(md).toContain("Build the styled Excel export.");
    expect(md).toContain("## Acceptance criteria");
    expect(md).toContain("- Columns match the UI");
    expect(md).toContain("## Evidence");
    expect(md).toContain("> we need this by Friday — Sarah, 00:12:30");
    expect(md).toContain("## Subtasks");
    expect(md).toContain("- [ ] Wire the button");
    expect(md).toContain("## Dependencies");
    expect(md).toContain("- t3");
  });

  it("omits empty markdown sections", () => {
    const md = svc.map({
      ...base,
      acceptanceCriteria: [],
      evidence: [],
      subtasks: [],
      dependencies: [],
    }).markdown_description ?? "";
    expect(md).toBe("Build the styled Excel export.");
  });
});
