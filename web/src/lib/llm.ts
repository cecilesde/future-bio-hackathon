// Shared Anthropic structured-output helper (server-only).
// Same pattern proven in lib/predict.ts: claude-opus-4-8 with a json_schema
// output_config, then parse the single text block.

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-4-8";
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

export async function extract<T>(
  system: string,
  user: string,
  schema: object,
  opts: { maxTokens?: number; effort?: "low" | "medium" | "high" } = {}
): Promise<T> {
  const { maxTokens = 3000, effort = "low" } = opts;
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema }, effort },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);

  const text = resp.content.find((b) => b.type === "text");
  return JSON.parse(text && "text" in text ? text.text : "{}") as T;
}
