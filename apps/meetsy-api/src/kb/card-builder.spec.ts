import { buildTaskCard, type CommentCardInput, type TaskCardInput } from "./card-builder";

const baseTask: TaskCardInput = {
  taskId: "abc123",
  taskName: "Ship the export",
  description: "Build the styled Excel export.",
  status: "in progress",
  priority: "high",
  assigneesNames: "Sarah",
  listName: "Q3 Backlog",
  folderName: "Reporting",
  client: "Acme",
  department: "Engineering",
  sprintName: "S12",
  tags: "export,q3",
  updatedDate: new Date("2026-06-20T10:00:00Z"),
  commentsSyncedAt: null,
};

const comments: CommentCardInput[] = [
  { commentText: "First idea", userName: "Sarah", commentDate: new Date("2026-06-18T09:00:00Z") },
  { commentText: "Second idea", userName: "Tom", commentDate: new Date("2026-06-19T09:00:00Z") },
];

describe("buildTaskCard", () => {
  it("is deterministic: same input → same content + hash", () => {
    const a = buildTaskCard(baseTask);
    const b = buildTaskCard({ ...baseTask });
    expect(a.content).toBe(b.content);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("includes title, key fields, and description", () => {
    const { content } = buildTaskCard(baseTask);
    expect(content).toContain("Title: Ship the export");
    expect(content).toContain("Status: in progress");
    expect(content).toContain("Priority: high");
    expect(content).toContain("Client: Acme");
    expect(content).toContain("Description:");
    expect(content).toContain("Build the styled Excel export.");
  });

  it("changing a field changes the hash (incremental gate)", () => {
    const a = buildTaskCard(baseTask);
    const b = buildTaskCard({ ...baseTask, status: "done" });
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  describe("comment debounce on commentsSyncedAt", () => {
    it("OMITS comments while commentsSyncedAt is unset, even if comments are passed", () => {
      const { content, contentHash } = buildTaskCard(baseTask, comments);
      expect(content).not.toContain("Comments:");
      expect(content).not.toContain("First idea");
      // identical to building with no comments at all
      expect(contentHash).toBe(buildTaskCard(baseTask).contentHash);
    });

    it("FOLDS comments once commentsSyncedAt is set", () => {
      const synced = { ...baseTask, commentsSyncedAt: new Date("2026-06-20T11:00:00Z") };
      const { content } = buildTaskCard(synced, comments);
      expect(content).toContain("Comments:");
      expect(content).toContain("First idea");
      expect(content).toContain("Second idea");
    });

    it("re-embeds exactly once when comments arrive: hash flips once", () => {
      const before = buildTaskCard(baseTask, comments).contentHash; // unset → no comments
      const after = buildTaskCard(
        { ...baseTask, commentsSyncedAt: new Date() },
        comments,
      ).contentHash;
      expect(after).not.toBe(before);
    });
  });

  it("caps card size and drops OLDEST comments first", () => {
    const big: CommentCardInput[] = Array.from({ length: 50 }, (_, i) => ({
      commentText: `comment-${i} ` + "x".repeat(400),
      userName: "User",
      commentDate: new Date(2026, 0, i + 1),
    }));
    const synced = { ...baseTask, commentsSyncedAt: new Date() };
    const { content } = buildTaskCard(synced, big);
    expect(content.length).toBeLessThanOrEqual(6000);
    // Newest retained, oldest dropped.
    expect(content).toContain("comment-49");
    expect(content).not.toContain("comment-0 ");
  });
});
