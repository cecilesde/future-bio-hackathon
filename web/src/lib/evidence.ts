// Cache-through evidence layer for AMASS-sourced data (patents, per-drug trials).
//
// Why this exists: AMASS credits are scarce. The whole-forecast cache
// (forecast_cache) is keyed by (disease, target, drug-set), so changing the drug
// would otherwise re-spend a credit on identical patent data. This layer caches
// AMASS results at a finer grain in Supabase (pg_evidence) so a given patents
// query or drug-trials query spends a credit AT MOST ONCE, ever, and is reused
// across every forecast that needs it.
//
// On out-of-credits (403) we return [] and do NOT cache, so a later top-up
// retries cleanly rather than caching an empty result.

import { createHash } from "crypto";
import { restQuery } from "./supabase";
import { searchPatents, searchDrugTrials } from "./amass";
import { drugApprovalIndications, diseaseDescendants } from "./opentargets";
import type { Patent, TrialDetail } from "./types";

export function keyOf(kind: string, ref: string): string {
  return createHash("sha1").update(`${kind}|${ref.toLowerCase()}`).digest("hex");
}

export async function readCache<T>(cacheKey: string): Promise<T[] | null> {
  try {
    const rows = await restQuery<{ items: T[] }>(
      `pg_evidence?cache_key=eq.${cacheKey}&select=items&limit=1`
    );
    return rows.length ? rows[0].items ?? [] : null;
  } catch {
    return null;
  }
}

export async function writeCache(cacheKey: string, kind: string, ref: string, items: unknown): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return;
  try {
    await fetch(`${url}/rest/v1/pg_evidence`, {
      method: "POST",
      headers: {
        apikey: svc,
        Authorization: `Bearer ${svc}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ cache_key: cacheKey, kind, ref, items }),
      cache: "no-store",
    });
  } catch {
    /* best-effort */
  }
}

// Patents for a (disease, target). Cached; one AMASS credit at most, ever.
export async function getPatents(disease: string, target: string): Promise<Patent[]> {
  const ref = `${target} ${disease}`;
  const cacheKey = keyOf("patents", ref);
  const cached = await readCache<Patent>(cacheKey);
  if (cached) return cached;

  const { patents, outOfCredits } = await searchPatents(`${target} ${disease} therapeutic`, 6);
  if (!outOfCredits && patents.length) await writeCache(cacheKey, "patents", ref, patents);
  return patents;
}

// Clinical trials for a specific drug the user typed. Cached by drug name.
export async function getDrugTrials(drug: string): Promise<TrialDetail[]> {
  const ref = drug.trim();
  if (!ref) return [];
  const cacheKey = keyOf("drug_trials", ref);
  const cached = await readCache<TrialDetail>(cacheKey);
  if (cached) return cached;

  const { trials, outOfCredits } = await searchDrugTrials(ref, 15);
  if (!outOfCredits && trials.length) await writeCache(cacheKey, "drug_trials", ref, trials);
  return trials;
}

// Approved indication ids (EFO/MONDO) for a drug, cached by chemblId. OT is free
// (no credits), so this just avoids re-querying the same drug across forecasts.
export async function getDrugApprovals(chemblId: string): Promise<string[]> {
  const ref = chemblId.trim();
  if (!ref) return [];
  const cacheKey = keyOf("drug_approvals", ref);
  const cached = await readCache<string>(cacheKey);
  if (cached) return cached;

  const ids = await drugApprovalIndications(ref).catch(() => [] as string[]);
  if (ids.length) await writeCache(cacheKey, "drug_approvals", ref, ids);
  return ids;
}

// Descendant (subtype) ids for a disease EFO, cached by efoId.
export async function getDiseaseDescendants(efoId: string): Promise<string[]> {
  const ref = efoId.trim();
  if (!ref) return [];
  const cacheKey = keyOf("disease_descendants", ref);
  const cached = await readCache<string>(cacheKey);
  if (cached) return cached;

  const ids = await diseaseDescendants(ref).catch(() => [] as string[]);
  if (ids.length) await writeCache(cacheKey, "disease_descendants", ref, ids);
  return ids;
}
