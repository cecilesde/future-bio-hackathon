import { NextRequest, NextResponse } from "next/server";
import { restQuery } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Type-ahead over the AMASS disease universe (MeSH condition terms), ranked by
// how many harvested trials studied each disease.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ items: [] });
  const safe = q.replace(/[,*()%\\.]/g, " ").trim();
  if (!safe) return NextResponse.json({ items: [] });

  try {
    const rows = await restQuery<{ term: string; n_trials: number }>(
      `pg_disease_terms?search_blob=ilike.*${encodeURIComponent(safe)}*` +
        `&select=term,n_trials&order=n_trials.desc&limit=12`
    );
    return NextResponse.json({
      items: rows.map((r) => ({ id: r.term, label: r.term, sub: `${r.n_trials.toLocaleString()} trials` })),
    });
  } catch {
    return NextResponse.json({ items: [], error: "search failed" }, { status: 502 });
  }
}
