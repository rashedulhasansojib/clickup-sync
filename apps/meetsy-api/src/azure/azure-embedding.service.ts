import { Injectable, Logger } from "@nestjs/common";
import { OpenAI } from "openai";
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
 * Embeddings client — its OWN client instance, separate from chat.
 *
 * The chat and embedding endpoints are configured independently (AZURE_EMBED_*
 * vs AZURE_OPENAI_*). They may point at the same Azure AI Foundry "v1" resource
 * (current setup — text-embedding-3-large, dimensions=1024 honored) or at
 * different ones; keeping a distinct client lets them diverge without a refactor.
 *
 * The client is built LAZILY: the app boots without AZURE_EMBED_* set; embed()
 * throws a clear error only if it is actually called while unconfigured.
 */
@Injectable()
export class AzureEmbeddingService {
  private readonly logger = new Logger(AzureEmbeddingService.name);
  private client: OpenAI | null = null;
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
  private getClient(): OpenAI {
    if (this.client) return this.client;
    const endpoint = this.config.get("AZURE_EMBED_ENDPOINT");
    const apiKey = this.config.get("AZURE_EMBED_API_KEY");
    if (!endpoint || !apiKey) {
      throw new Error(
        "Embeddings not configured: set AZURE_EMBED_ENDPOINT and AZURE_EMBED_API_KEY.",
      );
    }
    // v1 OpenAI-compatible surface: AZURE_EMBED_ENDPOINT is the full base URL
    // (…/openai/v1); `model` (the deployment) routes; auth via the api-key header.
    this.client = new OpenAI({
      baseURL: endpoint,
      apiKey,
      defaultHeaders: { "api-key": apiKey },
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
        // On the v1 surface the `model` field IS the deployment name and routes
        // the request.
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
