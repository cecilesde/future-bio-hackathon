import { NextRequest, NextResponse } from "next/server";
import { restQuery } from "@/lib/supabase";
import { noteKey } from "@/lib/notes";
import { MAX_NOTE_AUTHOR, MAX_NOTE_BODY, type Note } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The (disease, drug) identity a note is filed under. diseaseId (efoId) is preferred
// for the key; diseaseName/drugName are the fallback + the display values.
function keyFrom(diseaseId: string, diseaseName: string, drugChembl: string, drugName: string): string | null {
  const diseaseKey = (diseaseId || diseaseName).trim();
  const drugKey = (drugChembl || drugName).trim();
  if (!diseaseKey || !drugKey) return null;
  return noteKey(diseaseKey, drugKey);
}

// GET /api/notes?diseaseId=&diseaseName=&drugChembl=&drugName= -> prior notes (newest first).
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const key = keyFrom(p.get("diseaseId") ?? "", p.get("diseaseName") ?? "", p.get("drugChembl") ?? "", p.get("drugName") ?? "");
  if (!key) return NextResponse.json({ error: "disease and drug are required" }, { status: 400 });
  try {
    const notes = await restQuery<Note>(
      `pg_notes?note_key=eq.${key}&select=author,body,created_at&order=created_at.desc&limit=50`
    );
    return NextResponse.json({ notes });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}

// POST /api/notes { diseaseId, diseaseName, drugChembl, drugName, author, body } -> creates a note.
export async function POST(req: NextRequest) {
  let body: {
    diseaseId?: string;
    diseaseName?: string;
    drugChembl?: string;
    drugName?: string;
    author?: string;
    body?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const diseaseName = (body.diseaseName ?? "").trim();
  const drugName = (body.drugName ?? "").trim();
  const drugChembl = (body.drugChembl ?? "").trim();
  const author = (body.author ?? "").trim().slice(0, MAX_NOTE_AUTHOR) || null;
  const text = (body.body ?? "").trim();
  if (!diseaseName || (!drugName && !drugChembl)) {
    return NextResponse.json({ error: "disease and drug are required" }, { status: 400 });
  }
  if (!text) return NextResponse.json({ error: "note body is empty" }, { status: 400 });
  if (text.length > MAX_NOTE_BODY) {
    return NextResponse.json({ error: `note exceeds ${MAX_NOTE_BODY} characters` }, { status: 400 });
  }

  const key = keyFrom((body.diseaseId ?? "").trim(), diseaseName, drugChembl, drugName)!;
  const url = process.env.SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return NextResponse.json({ error: "server not configured for writes" }, { status: 500 });

  try {
    const res = await fetch(`${url}/rest/v1/pg_notes`, {
      method: "POST",
      headers: {
        apikey: svc,
        Authorization: `Bearer ${svc}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        note_key: key,
        disease_id: (body.diseaseId ?? "").trim() || null,
        disease_name: diseaseName,
        drug_key: drugChembl || drugName,
        drug_name: drugName || drugChembl,
        author,
        body: text,
      }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as Note[];
    const note = rows[0] ?? { author, body: text, created_at: new Date().toISOString() };
    return NextResponse.json({ note });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}
