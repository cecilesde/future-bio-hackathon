// Elicit literature search (server-side). Papers + clinical trials only, not
// patents. Bearer auth. Docs: https://docs.elicit.com/
const BASE = "https://elicit.com/api/v1";

export interface ElicitPaper {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  doi: string | null;
  venue: string | null;
  citedByCount: number | null;
  urls: string[];
}

export async function searchPapers(query: string, maxResults = 8): Promise<ElicitPaper[]> {
  const key = process.env.ELICIT_API_KEY;
  if (!key) throw new Error("Missing ELICIT_API_KEY");

  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, maxResults, corpus: "elicit", searchMode: "semantic" }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Elicit ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  return (data.papers ?? []).map(
    (p: Record<string, unknown>): ElicitPaper => ({
      title: String(p.title ?? ""),
      authors: (p.authors as string[]) ?? [],
      year: (p.year as number) ?? null,
      abstract: (p.abstract as string) ?? null,
      doi: (p.doi as string) ?? null,
      venue: (p.venue as string) ?? null,
      citedByCount: (p.citedByCount as number) ?? null,
      urls: (p.urls as string[]) ?? [],
    })
  );
}
