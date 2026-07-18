import { MlConfigService } from "./ml-config.service";
import { DEFAULT_MODELS, DEFAULT_TUNABLES } from "./ml-config.defaults";
import type { RunSnapshotPayload } from "@ma/shared";

/**
 * v2 Phase 5 — `upsert` persists Owner-supplied tunables + models and
 * invalidates the learning-snapshot cache so gate-value edits take effect on
 * the next `/learning` read. `viewForWorkspace` decorates the DB row with the
 * `updatedBy` / `updatedAt` / `isDefault` provenance the UI needs.
 */
describe("MlConfigService — upsert + view", () => {
  const WS = "ws_test";
  const ORG = "org_test";
  const USER = "user_test";

  const candidate: RunSnapshotPayload = {
    tunables: { ...DEFAULT_TUNABLES, dupFlag: 0.85, dupSuggest: 0.75 },
    models: DEFAULT_MODELS,
  };

  function makeService(row: object | null) {
    const findUnique = jest.fn().mockResolvedValue(row);
    const upsert = jest.fn().mockImplementation((args: { create: { updatedBy: string } }) => ({
      workspaceId: WS,
      orgId: ORG,
      tunables: candidate.tunables,
      models: candidate.models,
      updatedBy: args.create.updatedBy,
      createdAt: new Date("2026-07-18T00:00:00Z"),
      updatedAt: new Date("2026-07-18T00:00:00Z"),
    }));
    const prisma = { workspaceMlConfig: { findUnique, upsert } };
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const cache = { invalidate };
    const service = new MlConfigService(prisma as never, cache as never);
    return { service, findUnique, upsert, invalidate };
  }

  describe("upsert", () => {
    it("persists the candidate config and invalidates the learning cache", async () => {
      const { service, upsert, invalidate } = makeService(null);
      const view = await service.upsert(WS, ORG, USER, candidate);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS } }),
      );
      expect(invalidate).toHaveBeenCalledWith(WS);
      expect(view.tunables.dupFlag).toBe(0.85);
      expect(view.updatedBy).toBe(USER);
      expect(view.isDefault).toBe(false);
    });

    it("passes both create + update variants (upsert path) so first PUT creates", async () => {
      const { service, upsert } = makeService(null);
      await service.upsert(WS, ORG, USER, candidate);
      const args = upsert.mock.calls[0][0];
      expect(args.create).toEqual(
        expect.objectContaining({ workspaceId: WS, orgId: ORG, updatedBy: USER }),
      );
      expect(args.update).toEqual(
        expect.objectContaining({ updatedBy: USER }),
      );
    });

    it("rejects a malformed payload via defensive re-parse", async () => {
      const { service } = makeService(null);
      // dupFlag > 1 fails the WorkspaceTunablesSchema constraint.
      const bad = {
        tunables: { ...candidate.tunables, dupFlag: 5 },
        models: candidate.models,
      };
      await expect(service.upsert(WS, ORG, USER, bad as never)).rejects.toThrow();
    });
  });

  describe("viewForWorkspace", () => {
    it("marks isDefault=true when the row is absent", async () => {
      const { service } = makeService(null);
      const view = await service.viewForWorkspace(WS);
      expect(view.isDefault).toBe(true);
      expect(view.updatedBy).toBeNull();
      expect(view.updatedAt).toBeNull();
      expect(view.tunables.dupFlag).toBe(DEFAULT_TUNABLES.dupFlag);
    });

    it("surfaces updatedBy + updatedAt from the persisted row", async () => {
      const row = {
        workspaceId: WS,
        orgId: ORG,
        tunables: candidate.tunables,
        models: candidate.models,
        updatedBy: USER,
        createdAt: new Date("2026-07-18T00:00:00Z"),
        updatedAt: new Date("2026-07-18T12:00:00Z"),
      };
      const { service } = makeService(row);
      const view = await service.viewForWorkspace(WS);
      expect(view.isDefault).toBe(false);
      expect(view.updatedBy).toBe(USER);
      expect(view.updatedAt).toBe("2026-07-18T12:00:00.000Z");
      expect(view.tunables.dupFlag).toBe(0.85);
    });
  });
});
