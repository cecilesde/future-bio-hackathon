// Shared Anthropic structured-output helper (server-only).
// Same pattern proven in lib/predict.ts: claude-opus-4-8 with a json_schema
// output_config, then parse the single text block.

import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-opus-4-8";
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

// Hard ceiling for a single generation's output budget. `effort` reasoning is
// drawn from the SAME max_tokens budget as the visible JSON, so a heavy-reasoning
// run can truncate the structured output mid-string ("Unterminated string in JSON"
// on JSON.parse). We detect that (stop_reason === "max_tokens", or a parse failure)
// and retry with a QUADRUPLED budget instead of surfacing a fatal parse error.
const MAX_OUTPUT_TOKENS = 32000;

export async function extract<T>(
  system: string,
  user: string,
  schema: object,
  opts: { maxTokens?: number; effort?: "low" | "medium" | "high" } = {}
): Promise<T> {
  const { maxTokens = 3000, effort = "low" } = opts;
  let budget = maxTokens;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: budget,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema }, effort },
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    const block = resp.content.find((b) => b.type === "text");
    const raw = block && "text" in block ? block.text : "";
    const truncated =
      (resp as unknown as { stop_reason?: string }).stop_reason === "max_tokens";

    if (truncated && budget < MAX_OUTPUT_TOKENS) {
      // Output was cut off before the JSON closed; quadruple the room and retry.
      lastErr = new Error(`extract truncated at max_tokens (${raw.length} chars, budget ${budget})`);
      budget = Math.min(budget * 4, MAX_OUTPUT_TOKENS);
      continue;
    }

    try {
      return JSON.parse(raw || "{}") as T;
    } catch (e) {
      // A parse failure on a non-truncated response is usually still a length
      // issue on the reasoning side; quadruple the budget and retry, then give up.
      lastErr = e;
      if (budget >= MAX_OUTPUT_TOKENS) break;
      budget = Math.min(budget * 4, MAX_OUTPUT_TOKENS);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("extract failed to produce parseable JSON");
}
