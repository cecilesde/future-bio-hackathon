import { NextRequest, NextResponse } from "next/server";
import { discoverDrugs } from "@/lib/discover";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Disease alone -> candidate drugs (Open Targets + AMASS patents + Elicit lit).
export async function POST(req: NextRequest) {
  let body: { disease?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const disease = (body.disease ?? "").trim();
  if (!disease) return NextResponse.json({ error: "disease is required" }, { status: 400 });

  try {
    const drugs = await discoverDrugs(disease);
    return NextResponse.json({ drugs });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}
