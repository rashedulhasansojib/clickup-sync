import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import type { AssignableMember } from "../clickup/clickup.types";
import { AzureOpenAIService } from "../azure/azure-openai.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * v2 Phase 7 PR-E — LLM fallback for roster suggestions.
 *
 * Only fires when KB and heuristic both miss for a given participant name.
 * A small structured Azure call takes:
 *   - the transcript display name (+ any aliases we saw)
 *   - the workspace's ClickUp assignable members (allowlist)
 *   - a handful of high-confidence KB rows as few-shot exemplars (so the model
 *     can generalize the workspace's naming conventions)
 * and returns AT MOST ONE mapping from the allowlist, or explicit refusal.
 *
 * The mapping is NOT auto-written to the KB — the user still has to confirm
 * it at roster-time (that confirmation, if kept, triggers the normal PR-A
 * write via `learnFromConfirmation`). This keeps the LLM out of the training
 * loop unless a human validates it.
 *
 * Best-effort: any error (missing key, model refusal, timeout) returns null and
 * the resolver stays on `source="none"`.
 */
@Injectable()
export class RosterLlmService {
  private readonly logger = new Logger(RosterLlmService.name);

  constructor(
    private readonly azure: AzureOpenAIService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * @returns the picked clickupUserId (must be one of `members`), or null on
   * "no confident match".
   */
  async suggest(input: {
    workspaceId: string;
    displayName: string;
    aliases: readonly string[];
    members: readonly AssignableMember[];
  }): Promise<string | null> {
    if (input.members.length === 0) return null;
    if (!input.displayName.trim()) return null;

    // Pull a small set of high-confidence exemplars so the model learns the
    // workspace's convention ("Dan L." → Daniel Kim, "Fahim" → Md Fahim). We
    // ONLY sample user_confirmed / user_corrected rows with confirmations>=1
    // that point at a still-allowlisted member; blocklist rows are irrelevant
    // as few-shots and could poison the prompt.
    const memberIds = new Set(input.members.map((m) => m.clickupUserId));
    const nameById = new Map(input.members.map((m) => [m.clickupUserId, m.name]));
    let exemplars: Array<{ aliasRaw: string; clickupName: string }> = [];
    try {
      const rows = await this.prisma.participantAlias.findMany({
        where: {
          workspaceId: input.workspaceId,
          clickupUserId: { not: null },
          source: { in: ["user_confirmed", "user_corrected", "admin_seeded"] },
        },
        orderBy: [{ confirmations: "desc" }, { lastSeenAt: "desc" }],
        take: 20,
        select: { aliasRaw: true, clickupUserId: true },
      });
      exemplars = rows
        .filter((r) => r.clickupUserId && memberIds.has(r.clickupUserId))
        .map((r) => ({
          aliasRaw: r.aliasRaw,
          clickupName: nameById.get(r.clickupUserId!) ?? "",
        }))
        .filter((r) => r.clickupName)
        .slice(0, 8);
    } catch (err) {
      this.logger.warn(
        `KB few-shot lookup failed (workspace=${input.workspaceId}): ${(err as Error).message}`,
      );
      // Continue without exemplars — the model can still work off the raw
      // member list, just less accurately.
    }

    const aliasesLine = input.aliases.filter((a) => a.trim()).join(", ");
    const memberList = input.members
      .map((m) => `- ${m.name} [id=${m.clickupUserId}]`)
      .join("\n");
    const exemplarsBlock =
      exemplars.length > 0
        ? "Recent confirmed mappings in this workspace (for tone/convention):\n" +
          exemplars
            .map((e) => `- transcript "${e.aliasRaw}" → ${e.clickupName}`)
            .join("\n") +
          "\n\n"
        : "";
    const user =
      `${exemplarsBlock}Transcript participant name: "${input.displayName}"` +
      (aliasesLine ? `\nOther labels seen for this speaker: ${aliasesLine}` : "") +
      `\n\nAssignable ClickUp members (pick from THIS list only):\n${memberList}\n\n` +
      `Return the id of the single most likely member, or null if no member is a confident match.`;

    try {
      const parsed = await this.azure.structured({
        system: SYSTEM_PROMPT,
        user,
        schema: LlmSuggestionSchema,
        schemaName: "roster_llm_suggestion",
        reasoningEffort: "low",
      });
      if (!parsed.clickupUserId) return null;
      // Defend against the model hallucinating a member id outside the allowlist.
      if (!memberIds.has(parsed.clickupUserId)) {
        this.logger.warn(
          `LLM proposed clickupUserId="${parsed.clickupUserId}" not in allowlist for workspace=${input.workspaceId}`,
        );
        return null;
      }
      return parsed.clickupUserId;
    } catch (err) {
      this.logger.warn(
        `LLM roster fallback failed (workspace=${input.workspaceId}, name="${input.displayName}"): ${(err as Error).message}`,
      );
      return null;
    }
  }
}

const SYSTEM_PROMPT = [
  "You resolve meeting-transcript speaker names to a ClickUp workspace member.",
  "You get:",
  "  1. A transcript display name (possibly a nickname, first name, initials).",
  "  2. Optional additional labels seen for the same speaker.",
  "  3. The workspace's ALLOWED ClickUp members with their internal ids.",
  "  4. Optionally a few recent confirmed mappings to hint at naming conventions.",
  "Rules:",
  "  - Return the id of AT MOST ONE member.",
  "  - Only return an id from the given allowlist. If unsure, return null.",
  "  - Never fabricate an id. Never combine two members.",
  "  - Prefer high-confidence matches (unique first-name + matching last-initial",
  "    beats a generic ambiguous first name).",
  "  - A single mismatched letter (e.g. 'Sara' vs 'Sarah') is fine; a totally",
  "    different name is not.",
].join("\n");

const LlmSuggestionSchema = z.object({
  clickupUserId: z
    .string()
    .nullable()
    .describe(
      "The id of the picked ClickUp member from the given allowlist, or null if no confident match.",
    ),
  reasoning: z
    .string()
    .max(200)
    .describe("One sentence stating the match rationale, or why no match."),
});
