import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AzureOpenAIService } from "../azure/azure-openai.service";
import type { KbFacts } from "./summary.types";

/** Deployment for the single narrative pass (spec: gpt-5.4-mini, low effort). */
const NARRATIVE_DEPLOYMENT = "gpt-5.4-mini";

const NarrativeSchema = z.object({
  narrative: z.string(),
});

const SYSTEM_PROMPT = [
  "You write a short onboarding 'what we learned' profile of a software team,",
  "based ONLY on the structured facts and sample task titles provided.",
  "Write 1-2 short paragraphs describing what this team works on, who drives which",
  "areas, the throughput/volume trend, and where work tends to get stuck.",
  "Hard rules: summarize ONLY the provided facts and titles. Do NOT invent, infer,",
  "or introduce ANY numbers, names, dates, percentages, or metrics that are not",
  "present in the input. The numbers live in the facts object (the source of truth);",
  "your job is readable prose, not new figures. Be concise and concrete.",
].join(" ");

/**
 * ONE gpt-5.4-mini pass that turns the exact `KbFacts` + sampled titles into a
 * short prose profile. Isolated from `SummaryFactsService` so the facts carry NO
 * LLM dependency. The system prompt forbids new numbers; the model only summarizes.
 */
@Injectable()
export class NarrativeService {
  constructor(private readonly azure: AzureOpenAIService) {}

  async generate(facts: KbFacts, sampleTitles: string[]): Promise<string> {
    const user = [
      "FACTS (the only source of truth — do not add numbers beyond these):",
      JSON.stringify(facts),
      "",
      "SAMPLE TASK TITLES (recent + high-volume areas):",
      sampleTitles.map((t) => `- ${t}`).join("\n"),
    ].join("\n");

    const result = await this.azure.structured({
      system: SYSTEM_PROMPT,
      user,
      schema: NarrativeSchema,
      schemaName: "kb_summary_narrative",
      reasoningEffort: "low",
      deployment: NARRATIVE_DEPLOYMENT,
    });
    return result.narrative;
  }
}
