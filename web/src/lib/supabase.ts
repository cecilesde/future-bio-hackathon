// Direct PostgREST reads against Supabase (anon key, public-read RLS).
//
// We deliberately avoid @supabase/supabase-js here: its client spins up a
// realtime WebSocket layer that is unreliable under Node 20 and needs for none
// of our read-only queries. A plain fetch against the REST endpoint is lighter
// and dependency-free. Server-only (the anon key is never sent to the browser).

export async function restQuery<T = Record<string, unknown>>(path: string): Promise<T[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY");

  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase REST ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
}
