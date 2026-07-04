// Shared forecast_cache helpers, used by both /api/forecast and
// /api/forecast-by-drug so the whole-forecast cache stays consistent.

import { createHash } from "crypto";
import { restQuery } from "./supabase";
import type { Drug } from "./types";
import type { ForecastResult } from "./forecast";

// Bump when the cached report shape changes so old rows miss and regenerate.
export const SCHEMA_VERSION = "v5"; // v5: target-free (drug+disease) path; stale tournament rows miss

export function drugKeyOf(drugs: Drug[]): string {
  return drugs
    .map((d) => d.chembl_id)
    .filter(Boolean)
    .sort()
    .join(",");
}

export function forecastCacheKey(disease: string, target: string, drugKey: string): string {
  return createHash("sha1")
    .update(`${SCHEMA_VERSION}|${disease.toLowerCase()}|${target.toUpperCase()}|${drugKey}`)
    .digest("hex");
}

export interface ForecastCacheRow {
  report: ForecastResult["report"];
  score: ForecastResult["score"];
  papers: ForecastResult["papers"];
  patents: ForecastResult["patents"];
  provenance: ForecastResult["provenance"];
}

export async function readForecastCache(key: string): Promise<ForecastCacheRow | null> {
  try {
    const hit = await restQuery<ForecastCacheRow>(
      `forecast_cache?cache_key=eq.${key}&select=report,score,papers,patents,provenance&limit=1`
    );
    return hit.length ? hit[0] : null;
  } catch {
    return null;
  }
}

// Best-effort write with the service role (bypasses RLS). Never throws.
export async function writeForecastCache(
  key: string,
  disease: string,
  target: string,
  drugKey: string,
  r: ForecastResult
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return;
  try {
    await fetch(`${url}/rest/v1/forecast_cache`, {
      method: "POST",
      headers: {
        apikey: svc,
        Authorization: `Bearer ${svc}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        cache_key: key,
        disease_name: disease,
        target_symbol: target,
        drug_key: drugKey,
        report: r.report,
        score: r.score,
        papers: r.papers,
        patents: r.patents,
        provenance: r.provenance,
      }),
      cache: "no-store",
    });
  } catch {
    /* best-effort */
  }
}
