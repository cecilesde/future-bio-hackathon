import { discoverDrugs } from "../src/lib/discover";
const DISEASE = process.argv[2] || "Depression";
async function main() {
  const out = await discoverDrugs(DISEASE);
  console.log(`discovered ${out.length} candidates for "${DISEASE}"`);
  for (const d of out) {
    const a = d.attrition == null ? "  -" : `${(d.attrition * 100).toFixed(1)}%`;
    console.log(`  ${a.padStart(6)}  ${d.name}${d.approvedForDisease ? " [approved-for-disease]" : ""}`);
  }
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
