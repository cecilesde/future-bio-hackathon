// Claude-assisted prediction over Elicit literature.
//
// - predictTargets: given a drug + disease, read the literature and extract the
//   molecular targets the drug acts through for that disease.
// - checkInteraction: given a drug + target, judge whether the literature
//   supports that interaction; "not enough evidence" when it doesn't.
//
// Uses the official Anthropic SDK (claude-opus-4-8) with structured outputs so
// the JSON is schema-validated. Runs server-side only.

import Anthropic from "@anthropic-ai/sdk";
import { searchPapers, type ElicitPaper } from "./elicit";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const MODEL = "claude-opus-4-8";

function paperContext(papers: ElicitPaper[]): string {
  return papers
    .map((p, i) => {
      const meta = [p.authors[0], p.year, p.venue].filter(Boolean).join(", ");
      const abs = (p.abstract ?? "").slice(0, 700);
      return `[${i + 1}] ${p.title}${meta ? ` (${meta})` : ""}\n${abs}`;
    })
    .join("\n\n");
}

// structured-output JSON, then parse the single text block
async function extract(system: string, user: string, schema: object, maxTokens = 2000) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    // structured outputs + low effort for interactive latency
    output_config: { format: { type: "json_schema", schema }, effort: "low" },
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);

  const text = resp.content.find((b) => b.type === "text");
  return JSON.parse(text && "text" in text ? text.text : "{}");
}

export interface PredictedTarget {
  symbol: string;
  rationale: string;
  evidence: "strong" | "moderate" | "weak";
}

export async function predictTargets(drug: string, disease: string) {
  const papers = await searchPapers(
    `${drug} mechanism of action molecular targets in ${disease}: which proteins does it act on`,
    8
  );
  if (papers.length === 0) {
    return { targets: [] as PredictedTarget[], summary: "No literature found for this drug in this disease.", papers };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["targets", "summary"],
    properties: {
      targets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "rationale", "evidence"],
          properties: {
            symbol: { type: "string", description: "Human gene/protein HGNC symbol, e.g. GLP1R" },
            rationale: { type: "string" },
            evidence: { type: "string", enum: ["strong", "moderate", "weak"] },
          },
        },
      },
      summary: { type: "string" },
    },
  };

  const system =
    "You are a pharmacology research assistant. From the provided literature abstracts, identify the specific human molecular targets (proteins/genes, by HGNC symbol) through which a drug produces its therapeutic effect in a disease. Use ONLY the provided literature. Include a target only if the abstracts give evidence the drug acts through it for this disease; do not add targets from prior knowledge alone. Rate each target's evidence strength. If the literature does not support any target, return an empty list.";
  const user = `Drug: ${drug}\nDisease: ${disease}\n\nLiterature (title + abstract):\n${paperContext(
    papers
  )}\n\nList the molecular targets through which ${drug} affects ${disease}, grounded strictly in the literature above.`;

  const data = await extract(system, user, schema);
  return { targets: (data.targets ?? []) as PredictedTarget[], summary: data.summary ?? "", papers };
}

export async function checkInteraction(drug: string, target: string) {
  const papers = await searchPapers(`${drug} ${target} direct interaction binding agonist antagonist inhibitor mechanism`, 8);
  if (papers.length === 0) {
    return {
      hasEvidence: false,
      confidence: "low" as const,
      verdict: `No literature was found describing an interaction between ${drug} and ${target}.`,
      mechanism: "",
      papers,
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["hasEvidence", "confidence", "verdict", "mechanism"],
    properties: {
      hasEvidence: { type: "boolean" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      verdict: { type: "string", description: "One or two sentences on what the literature shows." },
      mechanism: { type: "string", description: "The interaction type if any (agonist/antagonist/inhibitor/…), else empty." },
    },
  };

  const system =
    "You are a pharmacology assistant. Decide whether the provided literature supports a direct molecular interaction (binding, agonism, antagonism, inhibition, or a documented mechanism) between a drug and a specific target. Judge conservatively: only report evidence if the abstracts actually describe the drug acting on that target for a mechanistic effect. If there is no such evidence, set hasEvidence=false and say so plainly.";
  const user = `Drug: ${drug}\nTarget: ${target}\n\nLiterature:\n${paperContext(
    papers
  )}\n\nDoes the literature support that ${drug} interacts with ${target}?`;

  const data = await extract(system, user, schema);
  return {
    hasEvidence: !!data.hasEvidence,
    confidence: (data.confidence ?? "low") as "high" | "medium" | "low",
    verdict: data.verdict ?? "",
    mechanism: data.mechanism ?? "",
    papers,
  };
}
