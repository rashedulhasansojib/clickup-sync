import type { Neighbour } from "../../kb/prediction-prior";
import { sliceNeighbours } from "./analysis.processor";

/**
 * v2 Phase 2 (PR-H) — the kNN neighbours map is what `FieldPredictionService`
 * hands the processor per task, already sorted DESC by cosine (source: pgvector
 * `ORDER BY <=>` at field-prediction.service.ts:139). sliceNeighbours keeps only
 * the top-N per task, preserves order, and copies over shorter lists verbatim.
 */
describe("sliceNeighbours", () => {
  function n(taskId: string, sim: number): Neighbour {
    return {
      taskId,
      sim,
      client: null,
      sprint: null,
      assignee: null,
      estimation: null,
      createdDate: null,
      closedDate: null,
    };
  }

  it("truncates each task's neighbours to the top-N, in the source order", () => {
    const byTask: Record<string, Neighbour[]> = {
      t1: [n("A", 0.91), n("B", 0.85), n("C", 0.82), n("D", 0.79), n("E", 0.71), n("F", 0.66), n("G", 0.55)],
    };
    const out = sliceNeighbours(byTask, 5);
    expect(out.t1.map((v) => v.taskId)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("passes shorter arrays through unchanged", () => {
    const byTask: Record<string, Neighbour[]> = {
      t1: [n("A", 0.9), n("B", 0.8)],
    };
    const out = sliceNeighbours(byTask, 5);
    expect(out.t1).toHaveLength(2);
    expect(out.t1[0].taskId).toBe("A");
    expect(out.t1[1].taskId).toBe("B");
  });

  it("returns an empty map when the input is empty", () => {
    expect(sliceNeighbours({}, 5)).toEqual({});
  });

  it("does not mutate the source arrays (writes a fresh slice)", () => {
    const original = [n("A", 0.9), n("B", 0.85), n("C", 0.8)];
    const byTask = { t1: original };
    const out = sliceNeighbours(byTask, 2);
    expect(out.t1).not.toBe(original);
    expect(original).toHaveLength(3); // untouched
  });
});
