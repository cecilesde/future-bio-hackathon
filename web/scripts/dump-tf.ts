// Dump a target-free forecast: number, confidence, cohort, per-program trials.
// Usage: tsx scripts/dump-tf.ts <chembl_id_or_name> "<disease>"
import { generateForecastTargetFree } from "../src/lib/forecast";
import type { Drug } from "../src/lib/types";

const ARG = process.argv[2] || "ketamine";
const DISEASE = process.argv[3] || "depression";

async function loadDrug(q: string): Promise<Drug> {
  const isId = /^CHEMBL\d+$/i.test(q);
  const filter = isId ? `chembl_id=eq.${q.toUpperCase()}` : `search_blob=ilike.*${encodeURIComponent(q.toLowerCase())}*`;
  const url = `${process.env.SUPABASE_URL}/rest/v1/pg_drugs?${filter}&select=*&order=max_phase.desc&limit=5`;
  const res = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY!}` },
  });
  const rows = (await res.json()) as Drug[];
  if (!rows.length) throw new Error(`no pg_drugs match for ${q}`);
  console.log(`matched: ${rows.map((r) => `${r.name}(${r.chembl_id},mp${r.max_phase})`).join(", ")}`);
  return rows[0];
}

async function main() {
  const drug = await loadDrug(ARG);
  console.log(`\n=== ${drug.name} (${drug.chembl_id}, mp${drug.max_phase}, ${drug.molecule_type}) in "${DISEASE}" ===\n`);
  const r = await generateForecastTargetFree(DISEASE, drug);

  console.log(`ATTRITION ${(r.score.attrition * 100).toFixed(1)}%  approved-override=${r.score.approved ?? false}`);
  console.log(`confidence: ${r.report.confidence} | reason: ${r.report.confidenceReason}`);
  console.log(`drivenBy: ${r.score.drivenBy} | exitPhase: ${r.report.exitPhase}`);
  console.log(`\nDecomposition:`);
  for (const c of r.score.components) {
    const v = c.kind === "factor" ? `x${c.value.toFixed(3)}` : `${(c.value * 100).toFixed(1)}%`;
    console.log(`  ${c.label}  [${v}]  <- ${c.input}`);
  }
  console.log(`\nprov: cohortSize=${r.provenance.cohortSize}, trialsAttached=${r.provenance.trialsAttached}, subjectDrugTrials=${r.provenance.subjectDrugTrials}, papers=${r.papers.length}, patents=${r.patents.length}`);

  console.log(`\n=== COHORT (${r.report.cohort.length}) ===`);
  for (const c of r.report.cohort) {
    console.log(`\n• ${c.drug} — outcome=${c.outcome}, reached ${c.reached}, death=${c.deathPhase ?? "-"}, yr ${c.year}, sim ${c.similarity}`);
    console.log(`  reason: ${c.reason}`);
    const trials = c.trials ?? [];
    console.log(`  trials: ${trials.length}`);
    for (const t of trials.slice(0, 8)) {
      console.log(`    [${t.phase || "?"}] ${t.status ?? "?"}${t.whyStopped ? ` WHY:${t.whyStopped}` : ""}${t.completionDate ? ` compl:${t.completionDate}` : ""} ${t.title ? "| " + t.title.slice(0, 55) : ""} <${t.source ?? "?"}>`);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
