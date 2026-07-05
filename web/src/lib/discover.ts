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
import {
  resolveDisease,
  diseaseDrugCandidates,
  isApprovedForIndication,
  type DiseaseDrugRow,
} from "./opentargets";
import { keyOf, readCache, writeCache, getDrugApprovals, getDiseaseDescendants } from "./evidence";
import { generateForecastTargetFree } from "./forecast";
import { forecastCacheKey, drugKeyOf, readForecastCache, writeForecastCache } from "./forecast-cache";
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

// OT's approved indication stage string is the literal "APPROVAL" (not "PHASE_4").
const APPROVED_STAGE = /APPROVAL/i;

interface RawDiscovered {
  name: string;
  status?: "approved" | "experimental";
  rationale: string;
  evidenceSources: string[];
}

// OT returns disease-drugs in no useful order (roughly alphabetical), so an
// unranked slice is dominated by off-label/adjunct noise (e.g. depression's list
// begins ACETAMINOPHEN, AIR MEDICAL, ALTEPLASE, AMLODIPINE, ASPIRIN...). Rank by
// clinical stage so the most-developed real drugs lead.
const OT_STAGE_RANK: Record<string, number> = {
  APPROVAL: 6, PHASE_4: 6, PHASE4: 6, PHASE_3: 5, PHASE3: 5, PHASE_2: 4, PHASE2: 4,
  PHASE_1: 3, PHASE1: 3, EARLY_PHASE_1: 2, PRECLINICAL: 1,
};
function rankOtDrugs(rows: DiseaseDrugRow[]): DiseaseDrugRow[] {
  return [...rows].sort(
    (a, b) =>
      (OT_STAGE_RANK[(b.maxClinicalStage ?? "").toUpperCase()] ?? 0) -
      (OT_STAGE_RANK[(a.maxClinicalStage ?? "").toUpperCase()] ?? 0)
  );
}

// For BACKFILL we want the NON-approved clinical-stage drugs first (Phase 3 > 2 > 1),
// because those are the new-discovery candidates. Approved-for-this-disease drugs are
// already well covered by the LLM (the standard of care), and piling on obscure
// approved entries (zimeldine, glaziovine...) just crowds out the experimental ones
// and leaves nothing after the "hide approved" filter.
const OT_BACKFILL_RANK: Record<string, number> = {
  PHASE_3: 6, PHASE3: 6, PHASE_2: 5, PHASE2: 5, PHASE_1: 4, PHASE1: 4, EARLY_PHASE_1: 3,
  APPROVAL: 2, PHASE_4: 2, PHASE4: 2, PRECLINICAL: 1,
};
function rankOtForBackfill(rows: DiseaseDrugRow[]): DiseaseDrugRow[] {
  return [...rows].sort(
    (a, b) =>
      (OT_BACKFILL_RANK[(b.maxClinicalStage ?? "").toUpperCase()] ?? 0) -
      (OT_BACKFILL_RANK[(a.maxClinicalStage ?? "").toUpperCase()] ?? 0)
  );
}
function otLines(rows: DiseaseDrugRow[]): string {
  return rankOtDrugs(rows)
    .slice(0, 120)
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
  const cacheKey = keyOf("discovery_v11", diseaseName); // v11: experimental-first backfill + real cached forecast per non-approved (matches click)
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
    "You are a drug-discovery analyst. From the provided evidence (an Open Targets list of drugs in clinical development or approved for a disease, a set of patents, and literature abstracts), produce a de-duplicated list of candidate DRUGS with reported or plausible efficacy for the disease. Include BOTH approved and experimental/clinical drugs. Use only named drugs (INN/common names), not compound codes or chemical structures. For each, give a one-sentence efficacy rationale and tag which sources support it. Prefer the Open Targets entries (they are the most reliable) and add named drugs from patents/literature that are not already in that list. The Open Targets list may include off-label or adjunct entries; keep the ones plausibly used or studied FOR this disease and skip clearly unrelated ones, but do NOT be overly restrictive: aim for a broad, deep shortlist. This list is used to surface NEW discovery candidates, so include a good number of EXPERIMENTAL / investigational agents (Phase 1-3, not yet approved for this disease), not only the established approved drugs. Do not invent drugs. Return 30 to 40 drugs (fewer only if the evidence genuinely supports fewer), most established first. Do not use em-dashes.";
  const user = `Disease: ${diseaseName}\n\nOpen Targets drugs (approved + clinical for this disease):\n${
    otDrugs.length ? otLines(otDrugs) : "(none)"
  }\n\nPatents (AMASS):\n${patentLines(patents)}\n\nLiterature (Elicit):\n${paperLines(papers)}\n\nProduce the candidate drug list.`;

  const data = await extract<{ drugs: RawDiscovered[] }>(system, user, schema, { effort: "medium", maxTokens: 6000 });

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

  // Safety-net backfill from the OT backbone. The LLM sometimes returns very few
  // candidates from a noisy OT list (e.g. depression's list is dominated by
  // off-label/adjunct entries and the model over-filters). OT disease-drugs are the
  // reliable backbone (real ChEMBL ids, each linked to THIS disease), so top up from
  // the highest-staged OT drugs not already present until the table is usable. Only
  // include drugs that resolve to a real pg_drugs record (this also drops OT names
  // outside our ChEMBL universe). Also makes discovery robust to an Elicit outage.
  // Target ~40 so that after the "hide approved for this indication" filter there is
  // still a deep pool of experimental candidates for new-discovery.
  const TARGET_MIN = 40;
  if (out.length < TARGET_MIN && otDrugs.length) {
    for (const r of rankOtForBackfill(otDrugs)) {
      if (out.length >= TARGET_MIN) break;
      const key = r.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const drug = await resolveDrug(r.name, r.chemblId ?? undefined);
      if (!drug) continue;
      const approved =
        (drug.max_phase ?? 0) >= 4 || (r.maxClinicalStage ? APPROVED_STAGE.test(r.maxClinicalStage) : false);
      out.push({
        name: drug.name,
        status: approved ? "approved" : "experimental",
        rationale: `In clinical development or approved with trials recorded for ${diseaseName} (Open Targets).`,
        evidenceSources: ["Open Targets"],
        chemblId: drug.chembl_id ?? r.chemblId ?? undefined,
        drug,
      });
    }
  }

  // Approved-for-THIS-disease flag (drug-centric OT indications, subtype-aware).
  // Distinct from the drug-level `status` (approved for anything). Cached + free.
  const descendants = efoId ? await getDiseaseDescendants(efoId).catch(() => [] as string[]) : [];
  if (efoId) {
    await Promise.all(
      out.map(async (d) => {
        const chembl = d.drug?.chembl_id;
        if (!chembl) return;
        const approvals = await getDrugApprovals(chembl).catch(() => [] as string[]);
        d.approvedForDisease = isApprovedForIndication(approvals, efoId, descendants);
      })
    );
  }

  // Run the AUTHORITATIVE forecast for each candidate up front and cache it, so the
  // ranked-table number is EXACTLY the number clicking "forecast" shows. The full
  // forecast has nondeterministic LLM steps (cohort curation, modality, judge), so a
  // cheap re-derivation would diverge on click. Instead we compute the real forecast
  // once and share its cached result with the click via forecast_cache (the same key
  // the /api/forecast-by-drug route reads). Bounded concurrency; each result cached,
  // so this is a one-time cost per (disease, drug).
  const CONCURRENCY = 5;
  const MAX_FORECASTS = 24; // bound the real-forecast work so no disease times out
  let cursor = 0;
  let forecasted = 0;
  async function warmOne(): Promise<void> {
    while (cursor < out.length) {
      const d = out[cursor++];
      // Approved for THIS indication => attrition 0 by definition. The click returns
      // 0 for these too (approvedForIndication short-circuit), so the table matches
      // WITHOUT running a forecast. Skipping them is what keeps this fast: only the
      // non-approved candidates (the ones that matter for new-discovery, and the ones
      // a user would click) get a real forecast.
      if (d.approvedForDisease) {
        d.attrition = 0;
        continue;
      }
      if (!d.drug) continue;
      // Cap the number of real forecasts so a disease with many experimental
      // candidates cannot exceed the request budget. Over-cap ones keep an undefined
      // estimate (sorted last); clicking one still computes + caches it on demand.
      if (forecasted >= MAX_FORECASTS) continue;
      forecasted++;
      const drugKey = drugKeyOf([d.drug]);
      const fkey = forecastCacheKey(diseaseName, "_DRUGFREE_", drugKey);
      try {
        let hit = await readForecastCache(fkey);
        if (!hit) {
          const result = await generateForecastTargetFree(diseaseName, d.drug);
          await writeForecastCache(fkey, diseaseName, "_DRUGFREE_", drugKey, result);
          hit = result;
        }
        d.attrition = hit.score.attrition;
      } catch {
        /* leave attrition undefined -> sorts last */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, out.length) }, warmOne));

  // rank by attrition ascending (lowest = most promising); undefined last, then
  // approved-first as a tiebreak
  out.sort((a, b) => {
    const aa = a.attrition ?? Infinity;
    const ba = b.attrition ?? Infinity;
    if (aa !== ba) return aa - ba;
    return (a.status === "approved" ? 0 : 1) - (b.status === "approved" ? 0 : 1);
  });

  if (out.length) await writeCache(cacheKey, "discovery_v11", diseaseName, out);
  return out;
}
