import { rankOwners } from "./assignment-rank";
import type { Neighbour } from "./prediction-prior";

function nb(over: Partial<Neighbour>): Neighbour {
  return {
    taskId: "t", sim: 0.8, client: null, sprint: null, assignee: null,
    estimation: null, createdDate: null, closedDate: null, ...over,
  };
}

describe("rankOwners (assignment echo-breaker)", () => {
  // A mixed neighbour set: a majority area (Nifty AI, owned by a prolific
  // cross-area owner) + a minority area (AIT, owned by its real owner).
  const neighbours: Neighbour[] = [
    ...Array.from({ length: 9 }, (_, i) => nb({ taskId: `na${i}`, sim: 0.7, client: "Nifty AI", assignee: "Shoabur", closedDate: new Date("2026-01-01") })),
    ...Array.from({ length: 5 }, (_, i) => nb({ taskId: `ait${i}`, sim: 0.7, client: "AIT", assignee: "Ahmad", closedDate: new Date("2026-01-01") })),
  ];

  it("WITHOUT client conditioning the prolific majority owner wins (the base-rate echo)", () => {
    const r = rankOwners(neighbours, null);
    expect(r.conditionedOnClient).toBe(false);
    expect(r.owners[0].name).toBe("Shoabur");
  });

  it("WITH client=AIT it conditions on AIT neighbours → the minority owner wins (echo broken)", () => {
    const r = rankOwners(neighbours, "AIT");
    expect(r.conditionedOnClient).toBe(true);
    expect(r.owners[0].name).toBe("Ahmad");
    expect(r.owners.find((o) => o.name === "Shoabur")).toBeUndefined(); // Shoabur owned no AIT tasks
  });

  it("falls back to all qualifying when the predicted client has no matching neighbours", () => {
    const r = rankOwners(neighbours, "Bondcam"); // no Bondcam neighbours
    expect(r.conditionedOnClient).toBe(false);
    expect(r.owners[0].name).toBe("Shoabur");
  });

  it("drops neighbours below the similarity floor", () => {
    const r = rankOwners([nb({ assignee: "A", sim: 0.9 }), nb({ assignee: "B", sim: 0.3 })], null);
    expect(r.owners.map((o) => o.name)).toEqual(["A"]);
  });

  it("weights CLOSED precedent above open and collects evidence task ids", () => {
    const r = rankOwners(
      [
        nb({ taskId: "x1", assignee: "Closer", sim: 0.7, closedDate: new Date("2026-01-01") }),
        nb({ taskId: "x2", assignee: "Opener", sim: 0.7, closedDate: null }),
      ],
      null,
    );
    expect(r.owners[0].name).toBe("Closer"); // closed weighs 2x
    expect(r.owners[0].closedSimilar).toBe(1);
    expect(r.owners[0].evidenceTaskIds).toContain("x1");
  });

  it("returns no owners for an empty / owner-less neighbour set", () => {
    expect(rankOwners([], null).owners).toEqual([]);
    expect(rankOwners([nb({ assignee: null })], null).owners).toEqual([]);
  });
});
