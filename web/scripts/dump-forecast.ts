// One-off: dump the authored forecast content (disease list + reports) to JSON
// so the Python loader can seed Supabase from the same source. Run:
//   cd web && npx --yes tsx scripts/dump-forecast.ts > ../data/seed/forecast.json
import { DISEASES, REPORTS } from "../src/lib/data";

const out = {
  diseases: DISEASES.map((d) => ({ id: d.id, name: d.name, synonym: d.synonym })),
  reports: REPORTS,
};
process.stdout.write(JSON.stringify(out, null, 1));
