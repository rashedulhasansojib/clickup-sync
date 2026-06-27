import { Injectable, Logger } from "@nestjs/common";
import { AzureOpenAI } from "openai";
import { ConfigService } from "../config/config.service";
import { recordUsage } from "../observability/usage.context";

export interface EmbedOpts {
  /**
   * Output vector dimensionality. text-embedding-3-large honors this (verified
   * down to 1024). Omit for the model's native size.
   */
  dimensions?: number;
}

/**
 * Embeddings client — DISTINCT Azure resource from chat.
 *
 * Chat lives on niftyai.openai.azure.com; embeddings live on a *separate*
 * resource (niftyocr.openai.azure.com / text-embedding-3-large) with its own
 * endpoint + key + api-version. This service therefore holds its own
 * AzureOpenAI instance rather than reusing AzureOpenAIService's client.
 *
 * The client is built LAZILY: Phase 0 boots without AZURE_EMBED_* set (the
 * pipeline does not embed until Phase 2). embed() throws a clear error only if
 * it is actually called while unconfigured.
 */
@Injectable()
export class AzureEmbeddingService {
  private readonly logger = new Logger(AzureEmbeddingService.name);
  private client: AzureOpenAI | null = null;
  private readonly deployment: string;

  constructor(private readonly config: ConfigService) {
    this.deployment = config.get("AZURE_EMBED_DEPLOYMENT");
  }

  /** True when AZURE_EMBED_ENDPOINT + AZURE_EMBED_API_KEY are both present. */
  get isConfigured(): boolean {
    return Boolean(
      this.config.get("AZURE_EMBED_ENDPOINT") && this.config.get("AZURE_EMBED_API_KEY"),
    );
  }

  /** Build the embedding client on first use; cache it. Throws if unconfigured. */
  private getClient(): AzureOpenAI {
    if (this.client) return this.client;
    const endpoint = this.config.get("AZURE_EMBED_ENDPOINT");
    const apiKey = this.config.get("AZURE_EMBED_API_KEY");
    if (!endpoint || !apiKey) {
      throw new Error(
        "Embeddings not configured: set AZURE_EMBED_ENDPOINT and AZURE_EMBED_API_KEY.",
      );
    }
    this.client = new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion: this.config.get("AZURE_EMBED_API_VERSION"),
      deployment: this.deployment,
    });
    return this.client;
  }

  /**
   * Embed one or many strings. Returns a vector per input, in input order.
   * Token usage is recorded into the current run context (like the chat path)
   * and logged.
   */
  async embed(input: string | string[], opts: EmbedOpts = {}): Promise<number[][]> {
    const client = this.getClient();
    const inputs = Array.isArray(input) ? input : [input];
    try {
      const res = await client.embeddings.create({
        // With AzureOpenAI the deployment is the routing target; `model` is the
        // deployment name.
        model: this.deployment,
        input: inputs,
        ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
      });

      // Observability: embeddings only consume prompt/input tokens (no
      // completion). Account them like the chat path so per-run totals stay true.
      const usage = res.usage;
      if (usage) {
        recordUsage(usage.prompt_tokens ?? 0, 0);
        this.logger.log(
          `Embeddings "${this.deployment}": inputs=${inputs.length} prompt=${usage.prompt_tokens} total=${usage.total_tokens}`,
        );
      }

      // Preserve input order (API returns an `index` per item).
      return res.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (err) {
      this.logger.error(`Azure embeddings call failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
