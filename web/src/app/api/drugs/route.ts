import { NextRequest, NextResponse } from "next/server";
import { restQuery } from "@/lib/supabase";
import type { Drug } from "@/lib/types";

export const dynamic = "force-dynamic";

// Type-ahead search over the ChEMBL drug universe (pg_drugs). Approved drugs
// (max_phase 4) rank first, then clinical-stage, then by name.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ drugs: [] });

  // strip characters that would break the PostgREST filter grammar
  const safe = q.replace(/[,*()%\\.]/g, " ").trim();
  if (!safe) return NextResponse.json({ drugs: [] });

  try {
    // match the primary name OR any synonym / brand name (search_blob), so
    // "mounjaro" / "ozempic" resolve, not just the ChEMBL preferred name.
    const drugs = await restQuery<Drug>(
      `pg_drugs?search_blob=ilike.*${encodeURIComponent(safe)}*` +
        `&select=chembl_id,name,max_phase,molecule_type,first_approval` +
        `&order=max_phase.desc.nullslast,name.asc&limit=12`
    );
    return NextResponse.json({ drugs });
  } catch {
    return NextResponse.json({ drugs: [], error: "search failed" }, { status: 502 });
  }
}
