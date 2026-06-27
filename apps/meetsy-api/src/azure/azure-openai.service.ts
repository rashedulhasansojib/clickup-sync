import { Injectable, Logger } from "@nestjs/common";
import { AzureOpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { ConfigService } from "../config/config.service";
import { recordUsage } from "../observability/usage.context";

export type ReasoningEffort = "low" | "medium" | "high";

export interface StructuredOpts<T> {
  /** System prompt — role + global instructions. */
  system: string;
  /** User prompt — the concrete task + input data. */
  user: string;
  /** Zod schema the model output must conform to (strict structured output). */
  schema: z.ZodType<T>;
  /** Name surfaced to the API for the JSON schema (e.g. "roster"). */
  schemaName: string;
  /** GPT-5.5 reasoning effort. Omit to use the deployment default. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Per-call deployment override (e.g. "gpt-5.4-mini"). When omitted the call
   * uses the configured chat deployment (AZURE_OPENAI_DEPLOYMENT). This is the
   * Azure routing target *and* the OpenAI `model` field. Lets later phases pick
   * a model per pipeline stage without re-constructing the service.
   *
   * NOTE: gpt-5.4-pro is Responses-API-only and cannot go through this
   * Chat-Completions path — route it via structuredViaResponses() instead.
   */
  deployment?: string;
}

/**
 * Provider-agnostic in shape, Azure-only in implementation.
 *
 * Wraps the openai SDK's AzureOpenAI client and exposes a single
 * `structured<T>()` helper that returns a Zod-validated object via OpenAI
 * structured outputs (`beta.chat.completions.parse` + `zodResponseFormat`).
 *
 * NOTE: GPT-5.5 is a reasoning model — we pass `reasoning_effort` and never
 * send `temperature`.
 */
@Injectable()
export class AzureOpenAIService {
  private readonly logger = new Logger(AzureOpenAIService.name);
  private readonly client: AzureOpenAI;
  private readonly deployment: string;

  constructor(private readonly config: ConfigService) {
    this.deployment = config.get("AZURE_OPENAI_DEPLOYMENT");
    this.client = new AzureOpenAI({
      endpoint: config.get("AZURE_OPENAI_ENDPOINT"),
      apiKey: config.get("AZURE_OPENAI_API_KEY"),
      apiVersion: config.get("AZURE_OPENAI_API_VERSION"),
      deployment: this.deployment,
    });
  }

  async structured<T>(opts: StructuredOpts<T>): Promise<T> {
    const { system, user, schema, schemaName, reasoningEffort } = opts;
    // Per-call deployment override; falls back to the configured chat deployment
    // so existing callers (which pass none) keep using AZURE_OPENAI_DEPLOYMENT.
    const deployment = opts.deployment ?? this.deployment;
    // Behavior driven entirely by .env so models can be swapped without code
    // changes. Reasoning models (gpt-5.5/o-series) take `reasoning_effort` and
    // reject `temperature`; gpt-4o is the inverse.
    const reasoning = this.config.get("AZURE_OPENAI_REASONING");
    const maxTokens = this.config.get("AZURE_OPENAI_MAX_COMPLETION_TOKENS");
    try {
      const completion = await this.client.beta.chat.completions.parse({
        // With AzureOpenAI the deployment is the routing target; `model` is the
        // deployment name.
        model: deployment,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: zodResponseFormat(schema, schemaName),
        ...(reasoning
          ? {
              reasoning_effort:
                reasoningEffort ?? this.config.get("AZURE_OPENAI_REASONING_EFFORT"),
            }
          : { temperature: this.config.get("AZURE_OPENAI_TEMPERATURE") }),
        ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
      });

      const message = completion.choices[0]?.message;
      // The model can refuse (safety) or hit a length cap — both leave parsed null.
      if (message?.refusal) {
        throw new Error(`Model refused request "${schemaName}": ${message.refusal}`);
      }
      const parsed = message?.parsed;
      if (parsed === null || parsed === undefined) {
        const finish = completion.choices[0]?.finish_reason ?? "unknown";
        throw new Error(
          `Structured output "${schemaName}" returned no parsed content (finish_reason=${finish}).`,
        );
      }
      // Observability: account tokens to the current run context + log per call.
      const usage = completion.usage;
      if (usage) {
        recordUsage(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
        this.logger.log(
          `LLM "${schemaName}": prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`,
        );
      }
      return parsed;
    } catch (err) {
      this.logger.error(
        `Azure structured call "${schemaName}" failed: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Responses-API path for gpt-5.4-pro (Responses-API-only — it cannot use Chat
   * Completions / `response_format`). Interface-only seam; NOT implemented.
   *
   * Intended shape when implemented:
   *   client.responses.create({
   *     model: opts.deployment ?? this.deployment,
   *     input: [{ role: "system", content: system }, { role: "user", content: user }],
   *     text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
   *     max_output_tokens: <cap>,
   *     reasoning: { effort: reasoningEffort },
   *   })
   * then validate response.output_text against the Zod schema and record
   * response.usage (input_tokens/output_tokens) via recordUsage().
   *
   * TODO(phase2): implement once a stage routes to gpt-5.4-pro.
   */
  async structuredViaResponses<T>(_opts: StructuredOpts<T>): Promise<T> {
    throw new Error("Responses API path not implemented yet (Phase 2+)");
  }
}
