import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OT = "https://api.platform.opentargets.org/api/v4/graphql";

// Free-form target lookup via Open Targets. Returns gene suggestions, but the
// caller may also accept any typed string (the UI allows free text).
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ items: [] });

  const query = `query($q:String!){
    search(queryString:$q, entityNames:["target"], page:{index:0,size:10}){
      hits{ id name entity object{ ... on Target { approvedSymbol approvedName } } }
    }
  }`;

  try {
    const r = await fetch(OT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { q } }),
      cache: "no-store",
    });
    const d = await r.json();
    const hits = d?.data?.search?.hits ?? [];
    const items = hits.map((h: {
      id: string;
      name: string;
      object?: { approvedSymbol?: string; approvedName?: string };
    }) => ({
      id: h.object?.approvedSymbol || h.name,
      label: h.object?.approvedSymbol || h.name,
      sub: h.object?.approvedName || h.name,
    }));
    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: [], error: "search failed" }, { status: 502 });
  }
}
