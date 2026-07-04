import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { generateForecast, type ForecastResult } from "@/lib/forecast";
import { restQuery } from "@/lib/supabase";
import type { Drug } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // multi-stage agent (Fluid Compute)

function drugKeyOf(drugs: Drug[]): string {
  return drugs
    .map((d) => d.chembl_id)
    .filter(Boolean)
    .sort()
    .join(",");
}

function cacheKey(disease: string, target: string, drugKey: string): string {
  return createHash("sha1").update(`${disease.toLowerCase()}|${target.toUpperCase()}|${drugKey}`).digest("hex");
}

// Best-effort cache write with the service role (bypasses RLS). Never throws.
async function writeCache(key: string, disease: string, target: string, drugKey: string, r: ForecastResult) {
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
        provenance: r.provenance,
      }),
      cache: "no-store",
    });
  } catch {
    /* cache is best-effort */
  }
}

interface CacheRow {
  report: ForecastResult["report"];
  score: ForecastResult["score"];
  papers: ForecastResult["papers"];
  provenance: ForecastResult["provenance"];
}

export async function POST(req: NextRequest) {
  let body: { disease?: string; target?: string; drugs?: Drug[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const disease = (body.disease ?? "").trim();
  const target = (body.target ?? "").trim();
  const drugs = Array.isArray(body.drugs) ? body.drugs : [];
  if (!disease || !target) {
    return NextResponse.json({ error: "disease and target are both required" }, { status: 400 });
  }

  const drugKey = drugKeyOf(drugs);
  const key = cacheKey(disease, target, drugKey);

  // cache read (anon)
  try {
    const hit = await restQuery<CacheRow>(
      `forecast_cache?cache_key=eq.${key}&select=report,score,papers,provenance&limit=1`
    );
    if (hit.length) {
      return NextResponse.json({ ...hit[0], cached: true });
    }
  } catch {
    /* fall through to compute */
  }

  try {
    const result = await generateForecast({ diseaseName: disease, targetSymbol: target, drugs });
    await writeCache(key, disease, target, drugKey, result);
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 400) }, { status: 502 });
  }
}
