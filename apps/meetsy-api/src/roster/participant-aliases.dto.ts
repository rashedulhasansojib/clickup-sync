import { z } from "zod";

/**
 * v2 Phase 7 PR-D — DTOs for the /kb Participants tab endpoints. Kept local to
 * meetsy-api (same convention as kb.dto.ts) because these shapes are not consumed
 * by any shared package.
 */

/** POST body: seed or overwrite a mapping manually from the KB browser. */
export const CreateParticipantAliasSchema = z.object({
  aliasRaw: z.string().min(1).max(200),
  clickupUserId: z.string().min(1).max(64).nullable(),
});
export type CreateParticipantAliasBody = z.infer<typeof CreateParticipantAliasSchema>;

/** PATCH body: change the mapping target and/or the display text. */
export const UpdateParticipantAliasSchema = z
  .object({
    aliasRaw: z.string().min(1).max(200).optional(),
    clickupUserId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one of aliasRaw or clickupUserId must be provided",
  });
export type UpdateParticipantAliasBody = z.infer<typeof UpdateParticipantAliasSchema>;

/** Aggregate CSV import — Owner/Admin only. Each row (alias, clickupUserId?)
 * upserts a single mapping. Explicit null (or missing) clickupUserId = blocklist. */
export const BulkImportParticipantAliasSchema = z.object({
  rows: z
    .array(
      z.object({
        aliasRaw: z.string().min(1).max(200),
        clickupUserId: z.string().min(1).max(64).nullable().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type BulkImportParticipantAliasBody = z.infer<
  typeof BulkImportParticipantAliasSchema
>;

/** One row in the paginated list. `clickupName` is joined from the ClickUp
 * assignable-members list on the server so all roles can browse the KB even if
 * the raw `/clickup/members` endpoint is Owner/Admin gated. Null if the mapping
 * points at a departed member or if this is a blocklist row. */
export interface ParticipantAliasRow {
  id: string;
  workspaceId: string;
  alias: string;
  aliasRaw: string;
  clickupUserId: string | null;
  clickupName: string | null;
  source: "user_confirmed" | "user_corrected" | "user_blocklisted" | "admin_seeded";
  confirmations: number;
  lastSeenAt: string;
  createdAt: string;
  createdBy: string;
}

/** Keyset-cursored page — mirrors the /kb tasks tab pattern. */
export interface ParticipantAliasesPage {
  rows: ParticipantAliasRow[];
  nextCursor: string | null;
  total: number;
}

/** Summary returned by the bulk-import endpoint. */
export interface BulkImportResult {
  imported: number;
  updated: number;
  skipped: number;
}
