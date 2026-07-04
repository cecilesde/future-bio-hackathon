import { NextRequest, NextResponse } from "next/server";
import { generateForecast } from "@/lib/forecast";
import { drugKeyOf, forecastCacheKey, readForecastCache, writeForecastCache } from "@/lib/forecast-cache";
import type { Drug } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // multi-stage agent (Fluid Compute)

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
  const key = forecastCacheKey(disease, target, drugKey);

  const hit = await readForecastCache(key);
  if (hit) return NextResponse.json({ ...hit, cached: true });

  try {
    const result = await generateForecast({ diseaseName: disease, targetSymbol: target, drugs });
    await writeForecastCache(key, disease, target, drugKey, result);
    return NextResponse.json({ ...result, cached: false });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 400) }, { status: 502 });
  }
}
