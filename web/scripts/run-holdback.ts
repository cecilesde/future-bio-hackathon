// Standalone runner: compute the blind retrospective forecast for a registered
// holdback case and print the deterministic number + term-by-term decomposition.
// Usage: tsx scripts/run-holdback.ts <chembl_id> "<disease>" [--no-censor-cohort]
import { generateForecastTargetFree, rawFailFraction } from "../src/lib/forecast";
import { holdbackFor, censorCandidates, type HoldbackConfig } from "../src/lib/holdback";
import { diseaseCohortCandidates, resolveDisease } from "../src/lib/opentargets";
import type { Drug } from "../src/lib/types";

const CHEMBL = process.argv[2] || "CHEMBL520733";
const DISEASE = process.argv[3] || "Alzheimer disease";
const noCensorCohort = process.argv.includes("--no-censor-cohort");

async function loadDrug(chemblId: string): Promise<Drug> {
  const url = `${process.env.SUPABASE_URL}/rest/v1/pg_drugs?chembl_id=eq.${chemblId}&select=*&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY!}` },
  });
  const rows = (await res.json()) as Drug[];
  if (!rows.length) throw new Error(`drug ${chemblId} not in pg_drugs`);
  return rows[0];
}

async function main() {
  const drug = await loadDrug(CHEMBL);
  const base = holdbackFor(CHEMBL, DISEASE);
  if (!base) throw new Error(`no holdback case for ${CHEMBL} / ${DISEASE}`);
  const cfg: HoldbackConfig = { ...base, censorCohort: noCensorCohort ? false : base.censorCohort };

  console.log(`\n=== BLIND FORECAST: ${drug.name} in "${DISEASE}" ===`);
  console.log(`as-of ${cfg.asOfDate}, base-rate phase ${cfg.asOfPhase}, censorCohort=${cfg.censorCohort ?? false}`);
  console.log(`observed (real) outcome: ${base.observedOutcome}\n`);

  // Show the deterministic censored precedent that now drives the number.
  const dz = await resolveDisease(DISEASE).catch(() => null);
  if (dz?.id) {
    const raw = await diseaseCohortCandidates(dz.id).catch(() => []);
    const censored = censorCandidates(raw, cfg);
    const ff = rawFailFraction(censored);
    console.log(`deterministic censored precedent: fail fraction = ${ff == null ? "null (neutral)" : (ff * 100).toFixed(1) + "%"} over ${censored.length} candidates\n`);
  }

  const r = await generateForecastTargetFree(DISEASE, drug, cfg);

  console.log(`ATTRITION = ${(r.score.attrition * 100).toFixed(1)}%   (PoS ${(r.score.pos * 100).toFixed(1)}%)`);
  console.log(`driven by: ${r.score.drivenBy}`);
  console.log(`exit phase: ${r.report.exitPhase} | confidence: ${r.report.confidence}\n`);
  console.log("Decomposition:");
  for (const c of r.score.components) {
    const v = c.kind === "factor" ? `x${c.value.toFixed(3)}` : `${(c.value * 100).toFixed(1)}%`;
    console.log(`  - ${c.label}\n      ${c.kind.toUpperCase()} ${v}  <- ${c.input}`);
  }
  console.log(`\nCohort size (curated): ${r.report.cohort.length}`);
  const failed = r.report.cohort.filter((c) => c.outcome === "Failed" || c.outcome === "Discontinued").length;
  const decided = r.report.cohort.filter((c) => c.outcome !== "Ongoing").length;
  console.log(`  decided ${decided}, failed/discontinued ${failed}`);
  console.log(`\nEfficacy grade (blind): sift components above.`);
  console.log(`\nVERDICT PROSE (NOT outcome-blind, LLM parametric knowledge):`);
  console.log(`  ${r.report.verdict}`);
  console.log(`\nCohort programs:`);
  for (const c of r.report.cohort.slice(0, 12)) {
    console.log(`  - ${c.drug} [${c.outcome}] reached ${c.reached} (${c.year || "?"})`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
