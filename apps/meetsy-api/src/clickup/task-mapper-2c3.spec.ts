import { TaskMapperService, MappableTask } from "./task-mapper.service";

const base: MappableTask = { title: "T", description: "d", priority: "normal" };

describe("TaskMapperService — Phase 2c.3 client/points", () => {
  const svc = new TaskMapperService();

  it("omits custom_fields + points entirely when not configured (byte-identical to Phase 1)", () => {
    const p = svc.map(base);
    expect(p).not.toHaveProperty("custom_fields");
    expect(p).not.toHaveProperty("points");
  });

  it("sets the client dropdown custom field by option UUID when configured + confirmed", () => {
    const p = svc.map({ ...base, clientOptionId: "opt-uuid-ait" }, { clientFieldId: "field-123" });
    expect(p.custom_fields).toEqual([{ id: "field-123", value: "opt-uuid-ait" }]);
  });

  it("does NOT set custom_fields if the field id is missing (only the option)", () => {
    const p = svc.map({ ...base, clientOptionId: "opt-uuid-ait" });
    expect(p).not.toHaveProperty("custom_fields");
  });

  it("sets top-level points when provided (including 0)", () => {
    expect(svc.map({ ...base, points: 5 }).points).toBe(5);
    expect(svc.map({ ...base, points: 0 }).points).toBe(0);
  });

  it("omits points when null/undefined", () => {
    expect(svc.map({ ...base, points: null })).not.toHaveProperty("points");
    expect(svc.map(base)).not.toHaveProperty("points");
  });
});
