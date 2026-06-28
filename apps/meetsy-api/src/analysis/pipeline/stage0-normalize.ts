import { z } from "zod";
import type { Participant } from "@ma/shared";
import { AzureOpenAIService } from "../../azure/azure-openai.service";
import { normalize, type NormalizedTranscript } from "../vtt";

/**
 * Stage 0 — Normalize + roster.
 *
 * Runs at UPLOAD time so the user can confirm/edit the roster before the heavy
 * analysis. Two steps:
 *   1. normalizeTranscript(): deterministic — parses Zoom VTT into a clean,
 *      timestamped transcript and the real speaker labels (no LLM, no tokens).
 *   2. buildRoster(): turns speaker labels into a deduped roster. For VTT we
 *      feed the REAL labels to a light LLM pass that merges obvious variants
 *      ("Dan" / "Dan Leary") and picks a displayName. For plain text (no
 *      embedded speakers) we extract the roster from the transcript itself.
 */

export function normalizeTranscript(raw: string): NormalizedTranscript {
  return normalize(raw);
}

const RosterLLMSchema = z.object({
  participants: z.array(
    z.object({
      displayName: z.string(),
      aliases: z.array(z.string()),
    }),
  ),
});

const DEDUPE_SYSTEM = `You are given the raw speaker labels captured from a Zoom
meeting transcript. Produce a deduplicated participant roster. Merge labels that
clearly refer to the same person (e.g. "Dan" and "Dan Leary"), choosing the most
complete real name as displayName and listing the other forms as aliases. Keep
generic/account labels (e.g. "Nifty IT solution") as their own entry — do not
guess who they are; the user will correct them. Never invent participants.`;

const EXTRACT_SYSTEM = `You are a meeting-transcript analyst. Identify the distinct
human participants in a transcript and produce a deduplicated roster. Merge labels
that clearly refer to the same person. Prefer a real name for displayName; if only
a generic label is available, use it as displayName and list it as an alias too.
Do not invent participants who never speak.`;

export async function buildRoster(
  azure: AzureOpenAIService,
  normalized: NormalizedTranscript,
): Promise<Participant[]> {
  // VTT path: we already have the real speaker labels — just dedupe them.
  if (normalized.isVtt && normalized.speakers.length > 0) {
    const out = await azure.structured({
      system: DEDUPE_SYSTEM,
      user: `Speaker labels:\n${normalized.speakers.map((s) => `- ${s}`).join("\n")}`,
      schema: RosterLLMSchema,
      schemaName: "roster",
      reasoningEffort: "low",
    });
    return toParticipants(out.participants);
  }

  // Plain-text path: extract the roster from the transcript content.
  const out = await azure.structured({
    system: EXTRACT_SYSTEM,
    user: `Extract the participant roster from this transcript:\n\n${normalized.cleanTranscript}`,
    schema: RosterLLMSchema,
    schemaName: "roster",
    reasoningEffort: "low",
  });
  return toParticipants(out.participants);
}

function toParticipants(
  raw: Array<{ displayName: string; aliases: string[] }>,
): Participant[] {
  // Assign stable, deterministic ids (p1, p2, …). The LLM never sees ids.
  return raw.map((p, i) => ({
    id: `p${i + 1}`,
    displayName: p.displayName,
    aliases: p.aliases ?? [],
    // Suggested at meeting creation (AnalysisService.suggestClickupMembers),
    // confirmed by the user at the roster step.
    clickupUserId: null,
    clickupName: null,
  }));
}
