import { NextRequest, NextResponse } from "next/server";
import { generateForecastTargetFree } from "@/lib/forecast";
import { drugKeyOf, forecastCacheKey, readForecastCache, writeForecastCache } from "@/lib/forecast-cache";
import { drugTargets } from "@/lib/opentargets";
import type { Drug } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// (disease + drug), NO target: target-free attrition dashboard. The score's
// validation term is the drug's efficacy evidence; the cohort is the disease's
// programs. No target is selected.
export async function POST(req: NextRequest) {
  let body: { disease?: string; drug?: Drug };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const disease = (body.disease ?? "").trim();
  const drug = body.drug;
  if (!disease || !drug || !drug.name) {
    return NextResponse.json({ error: "disease and a drug (with a name) are required" }, { status: 400 });
  }

  const drugKey = drugKeyOf([drug]);
  const key = forecastCacheKey(disease, "_DRUGFREE_", drugKey);

  const hit = await readForecastCache(key);
  if (hit) {
    const targets = drug.chembl_id ? await drugTargets(drug.chembl_id).catch(() => [] as string[]) : [];
    return NextResponse.json({ ...hit, cached: true, drugTargets: targets });
  }

  try {
    const result = await generateForecastTargetFree(disease, drug);
    await writeForecastCache(key, disease, "_DRUGFREE_", drugKey, result);
    const targets = drug.chembl_id ? await drugTargets(drug.chembl_id).catch(() => [] as string[]) : [];
    return NextResponse.json({ ...result, cached: false, drugTargets: targets });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 400) }, { status: 502 });
  }
}
