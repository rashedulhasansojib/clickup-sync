/**
 * Minimal ClickUp API shapes Meetsy's write-back needs. Mirrors the relevant
 * subset of Clicksy's `src/clickup/clickup.types.ts` (ClickUpMember) plus the
 * create-task payload Clicksy never had.
 */

/** A ClickUp team member (mirror of Clicksy's ClickUpMember). */
export interface ClickUpMember {
  user: {
    id: string | number;
    username?: string;
    email?: string;
    profilePicture?: string | null;
    color?: string | null;
    initials?: string | null;
  };
}

/** Payload for `POST /list/{list_id}/task`. Only the fields Phase 1 sends. */
export interface CreateTaskPayload {
  name: string;
  markdown_description?: string;
  /** ClickUp user ids (numeric). Omitted entirely when unassigned. */
  assignees?: number[];
  /** 1=urgent, 2=high, 3=normal, 4=low. */
  priority?: number;
  /** Epoch milliseconds. */
  due_date?: number;
  due_date_time?: boolean;
  /** Time estimate in epoch ms (hours × 3.6e6). */
  time_estimate?: number;
  tags?: string[];
  status?: string;
  /** Phase 2c.3 — dropdown custom field set by option UUID (e.g. client). */
  custom_fields?: Array<{ id: string; value: unknown }>;
  /** Phase 2c.3 — top-level sprint points. */
  points?: number;
}

/** Normalized create-task result returned to callers. */
export interface CreatedTask {
  id: string;
  url: string;
}

/** A list as shown in the target-list picker. */
export interface ClickUpListNode {
  id: string;
  name: string;
}

/** A folder + its lists. */
export interface ClickUpFolderNode {
  id: string;
  name: string;
  lists: ClickUpListNode[];
}

/** A space, its folders, and its folderless lists — shaped for a tree picker. */
export interface ClickUpSpaceNode {
  id: string;
  name: string;
  folders: ClickUpFolderNode[];
  /** Lists that live directly in the space (no folder). */
  lists: ClickUpListNode[];
}

/** A picker-ready assignable member entry stored in WorkspacePushConfig. */
export interface AssignableMember {
  clickupUserId: string;
  name: string;
  email?: string;
}
