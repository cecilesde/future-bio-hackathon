import { NextRequest, NextResponse } from "next/server";
import { predictTargets, checkInteraction } from "@/lib/predict";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Claude call

// Fill two of {disease, target, drug}; this predicts / validates the rest.
// - drug + disease (no target) -> predict the targets the drug acts through
// - drug + target             -> check the interaction has literature evidence
export async function POST(req: NextRequest) {
  let body: { disease?: string; target?: string; drug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ mode: "error", error: "bad request" }, { status: 400 });
  }

  const disease = (body.disease ?? "").trim();
  const target = (body.target ?? "").trim();
  const drug = (body.drug ?? "").trim();

  try {
    if (drug && target) {
      const r = await checkInteraction(drug, target);
      return NextResponse.json({ mode: "evidence", ...r });
    }
    if (drug && disease && !target) {
      const r = await predictTargets(drug, disease);
      return NextResponse.json({ mode: "targets", ...r });
    }
    return NextResponse.json({
      mode: "none",
      message:
        "Add a drug plus a disease to predict the targets it acts through, or a drug plus a target to check the interaction.",
    });
  } catch (e) {
    return NextResponse.json({ mode: "error", error: String(e).slice(0, 300) }, { status: 502 });
  }
}
