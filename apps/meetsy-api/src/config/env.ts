import { z } from "zod";

/**
 * Zod-validated environment configuration. Fails fast at boot with a clear
 * message if any required var is missing/invalid (see loadEnv()).
 * Var names match the repo-root .env.example exactly.
 */
export const EnvSchema = z.object({
  // Database — the meetsy role on the shared `clickup_sync` Postgres. Matches the
  // `env("MEETSY_DATABASE_URL")` datasource in prisma/schema.prisma.
  MEETSY_DATABASE_URL: z.string().min(1, "MEETSY_DATABASE_URL is required"),

  // Redis (BullMQ queue + SSE pub/sub)
  REDIS_HOST: z.string().min(1).default("localhost"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  // Azure OpenAI (the only LLM provider)
  AZURE_OPENAI_ENDPOINT: z.string().url("AZURE_OPENAI_ENDPOINT must be a URL"),
  AZURE_OPENAI_API_KEY: z.string().min(1, "AZURE_OPENAI_API_KEY is required"),
  AZURE_OPENAI_DEPLOYMENT: z.string().min(1, "AZURE_OPENAI_DEPLOYMENT is required"),
  AZURE_OPENAI_API_VERSION: z.string().min(1, "AZURE_OPENAI_API_VERSION is required"),

  // Model behavior knobs — all controllable from .env, no code change needed.
  // Set REASONING=true for reasoning models (gpt-5.5 / o-series): the call then
  // sends `reasoning_effort` and omits `temperature`. Set false for gpt-4o etc.:
  // the call sends `temperature` and omits `reasoning_effort` (gpt-4o rejects it).
  AZURE_OPENAI_REASONING: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AZURE_OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  AZURE_OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  // Optional hard cap on output tokens; leave unset for the deployment default.
  AZURE_OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().optional(),

  // Azure OpenAI — embeddings. NOTE: embeddings live on a *different* Azure
  // resource than chat (verified: niftyocr.openai.azure.com / text-embedding-3-large,
  // dimensions=1024 honored). All OPTIONAL so the app boots without them —
  // embeddings are unused until Phase 2; AzureEmbeddingService constructs its
  // client lazily and only errors if embed() is actually called unconfigured.
  AZURE_EMBED_ENDPOINT: z.string().url("AZURE_EMBED_ENDPOINT must be a URL").optional(),
  AZURE_EMBED_API_KEY: z.string().min(1).optional(),
  AZURE_EMBED_DEPLOYMENT: z.string().min(1).default("text-embedding-3-large"),
  AZURE_EMBED_API_VERSION: z.string().min(1).default("2023-05-15"),

  // API
  API_PORT: z.coerce.number().int().positive().default(4000),
  // Comma-separated list of allowed CORS origins.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // Auth — Meetsy authenticates Clicksy's `clickup_sync_sid` cookie session
  // (read-only against public.sessions/public.users). No JWT, no Meetsy login.
  // Session lifetime knobs mirror Clicksy's defaults so validation agrees.
  SESSION_MAX_AGE_DAYS: z.coerce.number().int().positive().default(30),
  SESSION_IDLE_TIMEOUT_DAYS: z.coerce.number().int().positive().default(7),
  // Optional machine credential — mirrors Clicksy's x-admin-key → synthetic Owner.
  ADMIN_API_KEY: z.string().optional().default(""),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parsed, strongly-typed config exposed via ConfigService. */
export interface AppConfig extends Env {
  /** Parsed CORS_ORIGINS as an array. */
  corsOrigins: string[];
}

/**
 * Validate process.env. Throws a readable aggregate error on failure so the
 * process exits before any module tries to use a half-configured value.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  return {
    ...env,
    corsOrigins: env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
