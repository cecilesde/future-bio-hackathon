import { restQuery } from "./supabase";
import type { Disease, Report, TargetAssoc } from "./types";
import type { TrialDistribution, DiseaseStrat } from "./trials";

interface TargetRow {
  disease_id: string;
  symbol: string;
  name: string | null;
  association: number | string | null;
  evidence: string[] | null;
  rank: number | null;
}
interface StatRow {
  area: string;
  disease: string;
  trials: number;
  p1: number; p2: number; p3: number; p4: number; na: number;
  completed: number; ongoing: number; stopped: number; other: number;
  enrollment: number | string;
}

// ---- Forecast: diseases + Open Targets targets, and authored reports ----
export async function getDiseases(): Promise<Disease[]> {
  const [diseases, targets] = await Promise.all([
    restQuery<{ id: string; name: string; synonym: string | null; efo_id: string | null }>(
      "pg_diseases?select=id,name,synonym,efo_id&order=name"
    ),
    restQuery<TargetRow>(
      "pg_targets?select=disease_id,symbol,name,association,evidence,rank&order=rank.asc"
    ),
  ]);

  const byDisease = new Map<string, TargetAssoc[]>();
  for (const t of targets) {
    const arr = byDisease.get(t.disease_id) ?? [];
    arr.push({
      symbol: t.symbol,
      name: t.name ?? t.symbol,
      association: Number(t.association ?? 0),
      evidence: t.evidence ?? [],
    });
    byDisease.set(t.disease_id, arr);
  }

  return diseases.map((d) => ({
    id: d.id,
    name: d.name,
    synonym: d.synonym ?? "",
    efoId: d.efo_id ?? undefined,
    targets: byDisease.get(d.id) ?? [],
  }));
}

export async function getReports(): Promise<Record<string, Report>> {
  const rows = await restQuery<{ disease_id: string; symbol: string; report: Report }>(
    "pg_reports?select=disease_id,symbol,report"
  );
  const out: Record<string, Report> = {};
  for (const r of rows) out[`${r.disease_id}:${r.symbol}`] = r.report;
  return out;
}

// ---- Trial landscape: aggregate stats + meta -> the shape the UI renders ----
export async function getDistribution(): Promise<TrialDistribution> {
  const [stats, metaRows] = await Promise.all([
    restQuery<StatRow>("pg_trial_disease_stats?select=*"),
    restQuery<{
      total_unique: number; mapped: number; excluded_nondisease: number;
      unmapped_mentions: number; n_areas: number; note: string;
    }>("pg_trial_meta?select=*&id=eq.1"),
  ]);
  const meta = metaRows[0];

  const byArea = new Map<string, DiseaseStrat[]>();
  for (const s of stats) {
    const arr = byArea.get(s.area) ?? [];
    arr.push({
      disease: s.disease,
      trials: s.trials,
      phases: { P1: s.p1, P2: s.p2, P3: s.p3, P4: s.p4, NA: s.na },
      status: { completed: s.completed, ongoing: s.ongoing, stopped: s.stopped, other: s.other },
      enrollment: Number(s.enrollment ?? 0),
    });
    byArea.set(s.area, arr);
  }

  const areas = [...byArea.entries()].map(([area, diseases]) => {
    diseases.sort((a, b) => b.trials - a.trials);
    return { area, trials: diseases.reduce((s, d) => s + d.trials, 0), diseases };
  });
  areas.sort((a, b) => b.trials - a.trials);

  return {
    meta: {
      source: "AMASS trialcore (api.amass.tech) harvested cache",
      totalUniqueTrials: meta?.total_unique ?? 0,
      mappedTrials: meta?.mapped ?? 0,
      excludedNonDisease: meta?.excluded_nondisease ?? 0,
      unmappedConditionMentions: meta?.unmapped_mentions ?? 0,
      areas: meta?.n_areas ?? areas.length,
      note: meta?.note ?? "",
    },
    areas,
  };
}
