"use client";

import { useMemo, useState } from "react";
import {
  distribution,
  totalDiseases,
  PHASE_COLORS,
  PHASE_LABELS,
  type AreaStrat,
  type DiseaseStrat,
} from "@/lib/trials";

const PHASE_KEYS = ["P1", "P2", "P3", "P4", "NA"] as const;
const fmt = (n: number) => n.toLocaleString();

export default function TrialLandscape() {
  const { meta, areas } = distribution;
  const [mode, setMode] = useState<"area" | "flat">("area");
  const [selected, setSelected] = useState(areas[0].area);

  const maxArea = areas[0].trials;
  const area = areas.find((a) => a.area === selected) ?? areas[0];

  const flat = useMemo(() => {
    const rows = areas.flatMap((a) =>
      a.diseases.map((d) => ({ ...d, area: a.area }))
    );
    rows.sort((x, y) => y.trials - x.trials);
    return rows.slice(0, 40);
  }, [areas]);
  const maxFlat = flat.length ? flat[0].trials : 1;

  const mappedPct = Math.round((meta.mappedTrials / meta.totalUniqueTrials) * 100);

  return (
    <div className="max-w-[1120px] mx-auto px-4 sm:px-6 pb-16">
      <header className="pt-8 pb-6">
        <h1 className="serif text-[30px] sm:text-[40px] leading-[1.08] max-w-[24ch]">
          The AMASS trial landscape, by disease
        </h1>
        <p className="text-[15px] t-muted mt-4 max-w-[74ch] leading-relaxed">
          Every clinical trial harvested from the AMASS <span className="mono">trialcore</span> index,
          stratified first by therapeutic area, then by the disease within it. Counts come from MeSH
          condition terms, so the cut is the disease each trial actually studied, not the drug that
          surfaced it.
        </p>
      </header>

      {/* summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Tile label="Unique trials" value={fmt(meta.totalUniqueTrials)} sub="deduplicated by NCT ID" />
        <Tile label="Disease-classified" value={`${mappedPct}%`} sub={`${fmt(meta.mappedTrials)} trials mapped`} />
        <Tile label="Therapeutic areas" value={String(meta.areas)} sub={`${totalDiseases} diseases`} />
        <Tile label="Source" value="trialcore" sub="AMASS · api.amass.tech" mono />
      </div>

      {/* mode toggle */}
      <div className="flex items-center gap-1 p-1 rounded-full w-max mb-5" style={{ border: "1px solid var(--line-2)", background: "var(--bg-2)" }}>
        <Toggle active={mode === "area"} onClick={() => setMode("area")}>By area &rsaquo; disease</Toggle>
        <Toggle active={mode === "flat"} onClick={() => setMode("flat")}>All diseases</Toggle>
      </div>

      {mode === "area" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr] items-start">
          {/* LEFT: area distribution (the headline chart) */}
          <section className="panel p-4">
            <div className="eyebrow mb-3">Trials by therapeutic area</div>
            <div className="flex flex-col gap-1">
              {areas.map((a) => (
                <AreaBar
                  key={a.area}
                  a={a}
                  max={maxArea}
                  selected={a.area === selected}
                  onSelect={() => setSelected(a.area)}
                />
              ))}
            </div>
            <p className="mono text-[10px] t-muted mt-3 leading-snug">
              A trial studying several conditions is counted in each; area totals therefore exceed
              the unique-trial count.
            </p>
          </section>

          {/* RIGHT: diseases within the selected area */}
          <section className="panel p-5">
            <div className="flex items-baseline justify-between gap-3 mb-1">
              <h2 className="serif text-[24px]">{area.area}</h2>
              <span className="mono text-[13px] t-accent">{fmt(area.trials)} trials</span>
            </div>
            <div className="mb-4"><PhaseLegend /></div>
            <div className="flex flex-col gap-3">
              {area.diseases.map((d) => (
                <DiseaseRow key={d.disease} d={d} max={area.diseases[0].trials} />
              ))}
            </div>
          </section>
        </div>
      ) : (
        <section className="panel p-5">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <h2 className="serif text-[24px]">Top 40 diseases</h2>
            <span className="mono text-[13px] t-muted">across all areas</span>
          </div>
          <div className="mb-4"><PhaseLegend /></div>
          <div className="flex flex-col gap-3">
            {flat.map((d) => (
              <DiseaseRow key={`${d.area}:${d.disease}`} d={d} max={maxFlat} areaTag={d.area} />
            ))}
          </div>
        </section>
      )}

      <p className="text-[12px] t-muted leading-relaxed mt-6 max-w-[90ch]">
        <span className="mono t-accent">Method · </span>
        {meta.note} {fmt(meta.excludedNonDisease)} trials studied only non-disease conditions (e.g.
        healthy-volunteer PK) and are excluded from the disease cut.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- area bar */
function AreaBar({
  a,
  max,
  selected,
  onSelect,
}: {
  a: AreaStrat;
  max: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="group text-left rounded px-2 py-1.5 transition-colors"
      style={{ background: selected ? "var(--accent-dim)" : "transparent" }}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[13px] truncate" style={{ color: selected ? "var(--accent)" : "var(--ink)" }}>
          {a.area}
        </span>
        <span className="mono text-[11px] tabular-nums t-muted flex-none">{fmt(a.trials)}</span>
      </div>
      <div className="meter" style={{ height: 8 }}>
        <span
          style={{
            width: `${(a.trials / max) * 100}%`,
            background: selected ? "var(--accent)" : "var(--line-3)",
          }}
        />
      </div>
    </button>
  );
}

/* ------------------------------------------------------------- disease row */
function DiseaseRow({
  d,
  max,
  areaTag,
}: {
  d: DiseaseStrat;
  max: number;
  areaTag?: string;
}) {
  const total = PHASE_KEYS.reduce((s, k) => s + d.phases[k], 0) || 1;
  const widthPct = (d.trials / max) * 100;
  const st = d.status;
  const stTotal = st.completed + st.ongoing + st.stopped + st.other || 1;

  return (
    <div className="grid gap-x-3 gap-y-1 items-center" style={{ gridTemplateColumns: "minmax(120px, 200px) 1fr auto" }}>
      <div className="min-w-0">
        {areaTag && (
          <div className="mono text-[9px] uppercase tracking-wider t-muted truncate">{areaTag}</div>
        )}
        <div className="text-[13.5px] leading-tight truncate" title={d.disease}>{d.disease}</div>
      </div>

      {/* phase-stacked bar, width ∝ magnitude */}
      <div className="flex items-center h-[18px] rounded-sm overflow-hidden" style={{ width: `${widthPct}%`, minWidth: 3, background: "transparent" }}
        title={PHASE_KEYS.map((k) => `${PHASE_LABELS[k]}: ${d.phases[k]}`).join(" · ")}>
        {PHASE_KEYS.map((k) =>
          d.phases[k] > 0 ? (
            <span key={k} style={{ width: `${(d.phases[k] / total) * 100}%`, background: PHASE_COLORS[k], height: "100%" }} />
          ) : null
        )}
      </div>

      <div className="flex items-center gap-2 flex-none">
        <span className="mono text-[12px] tabular-nums t-dim w-10 text-right">{fmt(d.trials)}</span>
        {/* status micro-bar */}
        <div className="flex h-[8px] w-[46px] rounded-full overflow-hidden" style={{ background: "var(--panel-2)" }}
          title={`completed ${st.completed} · ongoing ${st.ongoing} · stopped ${st.stopped}`}>
          <span style={{ width: `${(st.completed / stTotal) * 100}%`, background: "var(--green)" }} />
          <span style={{ width: `${(st.ongoing / stTotal) * 100}%`, background: "var(--amber)" }} />
          <span style={{ width: `${(st.stopped / stTotal) * 100}%`, background: "var(--red)" }} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- legends */
function PhaseLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {PHASE_KEYS.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5 mono text-[10px] t-muted">
          <i className="dot" style={{ background: PHASE_COLORS[k], borderRadius: 2 }} /> {PHASE_LABELS[k]}
        </span>
      ))}
      <span className="w-px h-3 mx-1" style={{ background: "var(--line-2)" }} />
      <span className="inline-flex items-center gap-1.5 mono text-[10px] t-muted">
        <i className="dot" style={{ background: "var(--green)" }} /> completed
      </span>
      <span className="inline-flex items-center gap-1.5 mono text-[10px] t-muted">
        <i className="dot" style={{ background: "var(--amber)" }} /> ongoing
      </span>
      <span className="inline-flex items-center gap-1.5 mono text-[10px] t-muted">
        <i className="dot" style={{ background: "var(--red)" }} /> stopped
      </span>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  mono,
}: {
  label: string;
  value: string;
  sub: string;
  mono?: boolean;
}) {
  return (
    <div className="panel p-3">
      <div className="eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div className={`${mono ? "mono text-[20px]" : "serif text-[26px]"} leading-none mt-1`}>{value}</div>
      <div className="mono text-[10px] t-muted mt-1 truncate">{sub}</div>
    </div>
  );
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="mono text-[12px] px-3.5 py-1.5 rounded-full transition-colors"
      style={{ background: active ? "var(--accent-dim)" : "transparent", color: active ? "var(--accent)" : "var(--muted)" }}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
