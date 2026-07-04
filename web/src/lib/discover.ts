// Disease -> candidate drugs discovery (server-side).
//
// From a disease alone, produce a ranked list of candidate drugs (approved +
// experimental) with efficacy evidence, synthesized by Claude from three sources:
//   - Open Targets disease->drugs (structured, real ChEMBL ids + phase) — backbone
//   - AMASS patents (emerging compounds)
//   - Elicit literature (named drugs with reported efficacy)
// Each candidate is resolved to a real pg_drugs record. The whole list is cached
// per disease in pg_evidence, so AMASS/Elicit/Claude are spent at most once per
// disease.

import { extract } from "./llm";
import { searchPatents } from "./amass";
import { searchPapers, type ElicitPaper } from "./elicit";
import { resolveDisease, diseaseDrugCandidates, type DiseaseDrugRow } from "./opentargets";
import { keyOf, readCache, writeCache } from "./evidence";
import { restQuery } from "./supabase";
import type { DiscoveredDrug, Drug, Patent } from "./types";

async function resolveDrug(name: string, chemblId?: string): Promise<Drug | undefined> {
  const sel = "select=chembl_id,name,max_phase,molecule_type,first_approval";
  try {
    if (chemblId) {
      const byId = await restQuery<Drug>(`pg_drugs?chembl_id=eq.${encodeURIComponent(chemblId)}&${sel}&limit=1`);
      if (byId.length) return byId[0];
    }
    const safe = name.replace(/[,*()%\\.]/g, " ").trim();
    if (safe.length < 2) return undefined;
    const rows = await restQuery<Drug>(
      `pg_drugs?search_blob=ilike.*${encodeURIComponent(safe)}*&${sel}&order=max_phase.desc.nullslast,name.asc&limit=1`
    );
    return rows[0];
  } catch {
    return undefined;
  }
}

const APPROVED_STAGE = /PHASE_?4/i;

interface RawDiscovered {
  name: string;
  status?: "approved" | "experimental";
  rationale: string;
  evidenceSources: string[];
}

function otLines(rows: DiseaseDrugRow[]): string {
  return rows
    .slice(0, 40)
    .map((r) => `- ${r.name} (${r.drugType ?? "?"}, ${r.maxClinicalStage ?? "?"})`)
    .join("\n");
}
function patentLines(patents: Patent[]): string {
  if (!patents.length) return "(none)";
  return patents.map((p) => `- ${p.title}${p.assignee ? ` — ${p.assignee}` : ""}`).join("\n");
}
function paperLines(papers: ElicitPaper[]): string {
  return papers.map((p) => `- ${p.title}\n  ${(p.abstract ?? "").slice(0, 300)}`).join("\n");
}

export async function discoverDrugs(diseaseName: string): Promise<DiscoveredDrug[]> {
  const cacheKey = keyOf("discovery", diseaseName);
  const cached = await readCache<DiscoveredDrug>(cacheKey);
  if (cached) return cached;

  const disease = await resolveDisease(diseaseName).catch(() => null);
  const efoId = disease?.id ?? null;

  const [otDrugs, patentRes, papers] = await Promise.all([
    efoId ? diseaseDrugCandidates(efoId).catch(() => [] as DiseaseDrugRow[]) : Promise.resolve([] as DiseaseDrugRow[]),
    searchPatents(`${diseaseName} treatment therapeutic drug`, 8).catch(() => ({ patents: [] as Patent[], outOfCredits: false })),
    searchPapers(`named therapeutics (approved and experimental) with reported efficacy in ${diseaseName}: clinical outcomes`, 8).catch(
      () => [] as ElicitPaper[]
    ),
  ]);
  const patents = patentRes.patents;

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["drugs"],
    properties: {
      drugs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "rationale", "evidenceSources"],
          properties: {
            name: { type: "string", description: "the drug's common/INN name (not a code or structure)" },
            status: { type: "string", enum: ["approved", "experimental"] },
            rationale: { type: "string", description: "one sentence on its reported efficacy for this disease" },
            evidenceSources: {
              type: "array",
              items: { type: "string", enum: ["Open Targets", "literature", "patent"] },
            },
          },
        },
      },
    },
  };

  const system =
    "You are a drug-discovery analyst. From the provided evidence (an Open Targets list of drugs in clinical development or approved for a disease, a set of patents, and literature abstracts), produce a de-duplicated list of candidate DRUGS with reported or plausible efficacy for the disease. Include BOTH approved and experimental/clinical drugs. Use only named drugs (INN/common names), not compound codes or chemical structures. For each, give a one-sentence efficacy rationale and tag which sources support it. Prefer the Open Targets entries (they are the most reliable) and add named drugs from patents/literature that are not already in that list. Do not invent drugs. Return up to 20, most established first. Do not use em-dashes.";
  const user = `Disease: ${diseaseName}\n\nOpen Targets drugs (approved + clinical for this disease):\n${
    otDrugs.length ? otLines(otDrugs) : "(none)"
  }\n\nPatents (AMASS):\n${patentLines(patents)}\n\nLiterature (Elicit):\n${paperLines(papers)}\n\nProduce the candidate drug list.`;

  const data = await extract<{ drugs: RawDiscovered[] }>(system, user, schema, { effort: "low", maxTokens: 3500 });

  const otByName = new Map(otDrugs.map((r) => [r.name.toLowerCase(), r]));
  const seen = new Set<string>();
  const out: DiscoveredDrug[] = [];
  for (const d of data.drugs ?? []) {
    const key = d.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ot = otByName.get(key);
    const drug = await resolveDrug(d.name, ot?.chemblId ?? undefined);
    const approved =
      (drug?.max_phase ?? 0) >= 4 || (ot?.maxClinicalStage ? APPROVED_STAGE.test(ot.maxClinicalStage) : d.status === "approved");
    out.push({
      name: drug?.name ?? d.name,
      status: approved ? "approved" : "experimental",
      rationale: d.rationale,
      evidenceSources: d.evidenceSources?.length ? d.evidenceSources : ot ? ["Open Targets"] : [],
      chemblId: drug?.chembl_id ?? ot?.chemblId ?? undefined,
      drug,
    });
  }

  // rank: approved first, then by max_phase desc, then evidence-source count
  out.sort((a, b) => {
    if ((a.status === "approved" ? 1 : 0) !== (b.status === "approved" ? 1 : 0))
      return a.status === "approved" ? -1 : 1;
    const pa = a.drug?.max_phase ?? -1;
    const pb = b.drug?.max_phase ?? -1;
    if (pb !== pa) return pb - pa;
    return b.evidenceSources.length - a.evidenceSources.length;
  });

  if (out.length) await writeCache(cacheKey, "discovery", diseaseName, out);
  return out;
}
