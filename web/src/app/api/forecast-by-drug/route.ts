import { NextRequest, NextResponse } from "next/server";
import { generateForecast, forecastByDrug, type BestTargetResult } from "@/lib/forecast";
import { drugKeyOf, forecastCacheKey, readForecastCache, writeForecastCache } from "@/lib/forecast-cache";
import { keyOf, readCache, writeCache } from "@/lib/evidence";
import type { Drug } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// (disease + drug), NO target: pick the best target via the tournament, then run
// the full dashboard for the winner. Caches the tournament (pg_evidence) and the
// winner's forecast (forecast_cache), so a later manual pick of that target hits.
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
  const bestKey = keyOf("best_target", `${disease}|${drug.chembl_id || drug.name}`);

  try {
    // 1) tournament cache hit -> winner known; only compute the winner's forecast on miss
    const bestCached = await readCache<BestTargetResult>(bestKey);
    if (bestCached && bestCached.length) {
      const { winner, candidates } = bestCached[0];
      const fcKey = forecastCacheKey(disease, winner, drugKey);
      const fc = await readForecastCache(fcKey);
      if (fc) {
        return NextResponse.json({ ...fc, candidateTargets: candidates, autoTarget: winner, cached: true });
      }
      const result = await generateForecast({ diseaseName: disease, targetSymbol: winner, drugs: [drug] });
      await writeForecastCache(fcKey, disease, winner, drugKey, result);
      return NextResponse.json({ ...result, candidateTargets: candidates, autoTarget: winner, cached: false });
    }

    // 2) cold: run the full tournament + winner forecast
    const result = await forecastByDrug(disease, drug);
    if (!result) {
      return NextResponse.json(
        { error: `Could not derive a target for ${drug.name} in ${disease}; enter a target manually.` },
        { status: 422 }
      );
    }
    await writeCache(bestKey, "best_target", `${disease}|${drug.chembl_id || drug.name}`, [
      { winner: result.autoTarget, candidates: result.candidateTargets },
    ]);
    await writeForecastCache(forecastCacheKey(disease, result.autoTarget, drugKey), disease, result.autoTarget, drugKey, result);
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 400) }, { status: 502 });
  }
}
