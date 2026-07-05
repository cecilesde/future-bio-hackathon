// Server-only helper for the shared researcher-notes feature. Notes are keyed by
// (disease, drug) ONLY: no target and no SCHEMA_VERSION, so they persist across
// forecast-cache bumps and are shared regardless of which target lens was used.
// Same drug + same indication => same key => same notes. Mirrors the sha1 keying
// style in forecast-cache.ts / evidence.keyOf.

import { createHash } from "crypto";

// diseaseKey: the resolved EFO id when known, else the disease name (lowercased).
// drugKey: the drug's chembl_id when known, else its name. Both are lowercased so
// casing differences ("Obesity" vs "obesity", a chembl id's case) never split notes.
export function noteKey(diseaseKey: string, drugKey: string): string {
  return createHash("sha1")
    .update(`${diseaseKey.trim().toLowerCase()}|${drugKey.trim().toLowerCase()}`)
    .digest("hex");
}
