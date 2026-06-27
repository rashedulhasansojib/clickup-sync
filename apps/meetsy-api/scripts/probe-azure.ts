/**
 * Standalone Azure GPT-5.5 structured-output probe.
 *
 * Run this FIRST after putting real creds in the root .env — it exercises the
 * exact call shape the pipeline uses (AzureOpenAI + zodResponseFormat +
 * reasoning_effort, no temperature) in isolation, so you can confirm the Azure
 * surface works before debugging through upload → queue → worker → SSE.
 *
 *   pnpm --filter @ma/api probe:azure
 *
 * Expected: prints a small JSON object with a `participants` array. Any error
 * here is an Azure/config problem (endpoint format, deployment name, api-version,
 * key, or reasoning-model param support) — fix it before running the app.
 */
import { AzureOpenAI } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const Schema = z.object({
  participants: z.array(
    z.object({
      displayName: z.string(),
      aliases: z.array(z.string()),
    }),
  ),
});

async function main(): Promise<void> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;

  console.log("Config:", {
    endpoint,
    deployment,
    apiVersion,
    apiKey: apiKey ? `${apiKey.slice(0, 4)}…(${apiKey.length} chars)` : "(missing)",
  });
  if (!endpoint || !apiKey || !deployment || !apiVersion) {
    throw new Error("Missing AZURE_OPENAI_* env vars — check the root .env");
  }
  // The AzureOpenAI client wants the BARE resource URL, e.g.
  //   https://my-resource.openai.azure.com
  // NOT the full /openai/deployments/.../chat/completions?api-version=... URL.
  if (/\/openai\/deployments|chat\/completions|api-version=/.test(endpoint)) {
    console.warn(
      "⚠️  AZURE_OPENAI_ENDPOINT looks like a full deployment URL. Use only the bare resource URL (https://<resource>.openai.azure.com).",
    );
  }

  const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

  // Mirror the service's env-driven behavior: reasoning models take
  // reasoning_effort + no temperature; gpt-4o takes temperature + no effort.
  const reasoning = process.env.AZURE_OPENAI_REASONING === "true";
  console.log(`Mode: ${reasoning ? "reasoning (reasoning_effort)" : "standard (temperature)"}`);

  const completion = await client.beta.chat.completions.parse({
    model: deployment,
    messages: [
      { role: "system", content: "Extract the distinct participants from the transcript." },
      {
        role: "user",
        content:
          "[00:00] Alice: I'll own the report.\n[00:01] Bob: I'll build the deck.\n[00:02] Alice: thanks Bob.",
      },
    ],
    response_format: zodResponseFormat(Schema, "roster"),
    ...(reasoning
      ? { reasoning_effort: (process.env.AZURE_OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "medium" }
      : { temperature: Number(process.env.AZURE_OPENAI_TEMPERATURE ?? "0.2") }),
  });

  const msg = completion.choices[0]?.message;
  if (msg?.refusal) throw new Error(`Model refused: ${msg.refusal}`);
  console.log("\n✅ Structured output OK:\n", JSON.stringify(msg?.parsed, null, 2));
  console.log("\nUsage:", completion.usage);
}

main().catch((err) => {
  console.error("\n❌ Probe failed:", err?.message ?? err);
  process.exit(1);
});
