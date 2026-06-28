import { buildScopeWhere } from "./kb.processor";

describe("buildScopeWhere", () => {
  it("returns an empty filter for an absent scope", () => {
    expect(buildScopeWhere(undefined)).toEqual({});
  });

  it("returns an empty filter when every axis is empty/omitted", () => {
    expect(buildScopeWhere({ spaceIds: [], folderNames: [], listIds: [], clients: [] })).toEqual({});
  });

  it("maps each axis to its real ClickupTask column", () => {
    expect(buildScopeWhere({ spaceIds: ["s1"] })).toEqual({ spaceId: { in: ["s1"] } });
    expect(buildScopeWhere({ folderNames: ["Sprint A"] })).toEqual({ folderName: { in: ["Sprint A"] } });
    expect(buildScopeWhere({ listIds: ["l1"] })).toEqual({ listId: { in: ["l1"] } });
    expect(buildScopeWhere({ clients: ["Acme"] })).toEqual({ client: { in: ["Acme"] } });
  });

  it("ANDs multiple axes together and omits the empty ones", () => {
    expect(
      buildScopeWhere({ spaceIds: ["s1", "s2"], folderNames: [], clients: ["Acme"] }),
    ).toEqual({
      spaceId: { in: ["s1", "s2"] },
      client: { in: ["Acme"] },
    });
  });
});
