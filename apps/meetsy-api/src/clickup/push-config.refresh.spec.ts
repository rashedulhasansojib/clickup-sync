import { PushConfigService } from "./push-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { ClickUpClient } from "./clickup.client";

describe("PushConfigService.refreshFields", () => {
  function setup(fields: unknown[], tree: unknown[]) {
    const update = jest.fn().mockImplementation(async ({ data }) => ({
      workspaceId: "ws1", targetListId: "L1", targetListName: null, assignableMembers: [],
      defaultStatus: null, pointsEnabled: false, updatedAt: new Date(), updatedBy: null, ...data,
    }));
    const prisma = {
      workspacePushConfig: {
        findUnique: jest.fn().mockResolvedValue({ workspaceId: "ws1", targetListId: "L1" }),
        update,
      },
    } as unknown as PrismaService;
    const client = {
      getListCustomFields: jest.fn().mockResolvedValue(fields),
      getSpaceTree: jest.fn().mockResolvedValue(tree),
    } as unknown as ClickUpClient;
    return { svc: new PushConfigService(prisma, client), update };
  }

  it("picks the dropdown named like 'client' and maps its options to {optionId,name}", async () => {
    const { svc } = setup(
      [
        { id: "f-status", name: "Status", type: "drop_down", options: [{ id: "s1", name: "Open" }] },
        { id: "f-client", name: "Client", type: "drop_down", options: [{ id: "u-ait", name: "AIT" }, { id: "u-er", name: "Energy Reporting" }] },
      ],
      [{ id: "sp1", name: "Space", lists: [{ id: "L1", name: "Default" }], folders: [{ id: "fo1", name: "Sprints", lists: [{ id: "L9", name: "Sprint 9" }] }] }],
    );
    const out = await svc.refreshFields("ws1");
    expect(out.clientFieldId).toBe("f-client");
    expect(out.clientOptions).toEqual([{ optionId: "u-ait", name: "AIT" }, { optionId: "u-er", name: "Energy Reporting" }]);
    // sprint lists flatten folderless + foldered (with folder prefix).
    expect(out.sprintLists).toEqual([{ listId: "L1", name: "Default" }, { listId: "L9", name: "Sprints / Sprint 9" }]);
  });

  it("leaves clientField null when no dropdown exists", async () => {
    const { svc } = setup([{ id: "f-text", name: "Notes", type: "text", options: [] }], []);
    const out = await svc.refreshFields("ws1");
    expect(out.clientFieldId).toBeNull();
    expect(out.clientOptions).toEqual([]);
  });
});
