// AMASS runtime client (server-side). Patents (patentcore) and per-drug clinical
// trials (trialcore) fetched live at request time.
//
// SPARING BY DESIGN: single query per call, small limits, never a bulk
// search_union. Callers must cache results (see lib/evidence.ts) so a given
// query spends an AMASS credit at most once. Degrades gracefully to [] on a
// missing key or a 403 (out of credits), so the forecast still works AMASS-free.

import type { Patent, TrialDetail } from "./types";

const DEFAULT_BASE = "https://api.amass.tech/api/v1";
const MAX_LIMIT = 300; // server ceiling; we stay well under it

interface AmassResult<T> {
  ok: boolean;
  data: T[];
  outOfCredits: boolean;
}

async function amassSearch(core: string, query: string, limit: number): Promise<AmassResult<Record<string, unknown>>> {
  const key = process.env.AMASS_API_KEY;
  const base = (process.env.AMASS_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
  if (!key || !query.trim()) return { ok: false, data: [], outOfCredits: false };

  const url = `${base}/cores/${core}/records?query=${encodeURIComponent(query)}&limit=${Math.min(limit, MAX_LIMIT)}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (res.status === 403) return { ok: false, data: [], outOfCredits: true }; // out of credits
    if (!res.ok) return { ok: false, data: [], outOfCredits: false };
    const body = await res.json();
    const data = Array.isArray(body?.data) ? (body.data as Record<string, unknown>[]) : [];
    return { ok: true, data, outOfCredits: false };
  } catch {
    return { ok: false, data: [], outOfCredits: false };
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function googlePatentUrl(pub: string | null): string | null {
  if (!pub) return null;
  return `https://patents.google.com/patent/${pub.replace(/-/g, "")}`;
}

// Patents for a (disease, target) or (drug, target) query. Sparing: default 6.
export async function searchPatents(query: string, limit = 6): Promise<{ patents: Patent[]; outOfCredits: boolean }> {
  const r = await amassSearch("patentcore", query, limit);
  const patents: Patent[] = r.data.map((p) => {
    const pub = str(p.publicationNumber);
    return {
      title: str(p.title) ?? "",
      abstract: str(p.abstract),
      assignee: arr(p.assignees)[0] ?? null,
      number: pub,
      date: str(p.publicationDate) ?? str(p.filingDate),
      url: googlePatentUrl(pub),
    };
  });
  return { patents, outOfCredits: r.outOfCredits };
}

const AMASS_STAGE: Record<string, string> = {
  EARLY_PHASE1: "PHASE_1", PHASE1: "PHASE_1", PHASE2: "PHASE_2", PHASE3: "PHASE_3", PHASE4: "PHASE_4",
};

// Clinical trials for a specific drug (the subject drug a user typed). Sparing:
// default 15. Maps to the shared TrialDetail shape so it composes with the UI.
export async function searchDrugTrials(drug: string, limit = 15): Promise<{ trials: TrialDetail[]; outOfCredits: boolean }> {
  const r = await amassSearch("trialcore", drug, limit);
  const seen = new Set<string>();
  const trials: TrialDetail[] = [];
  for (const t of r.data) {
    const nctId = str(t.nctId) ?? str(t.registryId);
    const key = nctId ?? `${str(t.briefTitle) ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawPhase = (str(t.phase) ?? "").toUpperCase().replace(/\s+/g, "");
    trials.push({
      phase: AMASS_STAGE[rawPhase] ?? (str(t.phase) ?? ""),
      status: str(t.overallStatus),
      startDate: str(t.startDate),
      completionDate: str(t.completionDate),
      whyStopped: str(t.whyStopped),
      stopReasonCategories: [],
      title: str(t.briefTitle),
      url: str(t.sourceUrl),
      nctId,
    });
  }
  return { trials, outOfCredits: r.outOfCredits };
}
