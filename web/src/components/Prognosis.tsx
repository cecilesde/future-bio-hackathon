"use client";

import { useMemo, useState } from "react";
import type { Disease, Report, TargetAssoc, Paper, Drug } from "@/lib/types";
import Swimlanes from "./Swimlanes";
import DrugInput from "./DrugInput";
import {
  VerdictBand,
  FailureModes,
  ModalityPanel,
  Adversarial,
  Derisking,
  CalibrationPanel,
  LiteraturePanel,
} from "./report-parts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function Prognosis({
  diseases,
  reports,
  literature,
}: {
  diseases: Disease[];
  reports: Record<string, Report>;
  literature: Record<string, Paper[]>;
}) {
  const getReport = (d: string, s: string): Report | null => reports[`${d}:${s}`] ?? null;
  // default to the highest-association target that has a modeled forecast
  const defaultSymbol = (d: Disease) => {
    if (!d?.targets?.length) return "";
    const sorted = [...d.targets].sort((a, b) => b.association - a.association);
    return (sorted.find((t) => getReport(d.id, t.symbol)) ?? sorted[0]).symbol;
  };

  const [diseaseId, setDiseaseId] = useState(diseases[0].id);
  const [symbol, setSymbol] = useState(() => defaultSymbol(diseases[0]));
  const [drugs, setDrugs] = useState<Drug[]>([]);

  const disease = useMemo(
    () => diseases.find((d) => d.id === diseaseId)!,
    [diseaseId, diseases]
  );
  const targets = useMemo(
    () => [...disease.targets].sort((a, b) => b.association - a.association),
    [disease]
  );
  const report = getReport(diseaseId, symbol);
  const selected = disease.targets.find((t) => t.symbol === symbol) ?? null;

  function pickDisease(id: string) {
    setDiseaseId(id);
    const d = diseases.find((x) => x.id === id)!;
    setSymbol(defaultSymbol(d));
  }

  return (
    <div className="max-w-[1120px] mx-auto px-4 sm:px-6">
      <Header />

      {/* pipeline breadcrumb */}
      <nav className="mono text-[11px] t-muted flex flex-wrap items-center gap-2 mb-4">
        <Crumb active label="Disease" />
        <span className="t-accent">›</span>
        <Crumb label="Targets · Open Targets" />
        <span className="t-accent">›</span>
        <Crumb label="Selected target" />
        <span className="t-accent">›</span>
        <Crumb label="Reference-class forecast" />
      </nav>

      {/* query: disease + target */}
      <section className="panel p-4 sm:p-5 mb-8">
        <div className="grid gap-5 md:grid-cols-[260px_1fr]">
          {/* disease */}
          <div>
            <label className="eyebrow block mb-2">Disease</label>
            <div className="flex flex-col gap-2">
              {diseases.map((d) => {
                const on = d.id === diseaseId;
                return (
                  <button
                    key={d.id}
                    onClick={() => pickDisease(d.id)}
                    className="text-left rounded-md px-3 py-2 transition-colors"
                    style={{
                      background: on ? "var(--accent-dim)" : "var(--bg-2)",
                      border: `1px solid ${on ? "var(--accent)" : "var(--line-2)"}`,
                    }}
                  >
                    <div className="text-[15px]" style={{ color: on ? "var(--accent)" : "var(--ink)" }}>
                      {d.name}
                    </div>
                    <div className="mono text-[10px] t-muted mt-0.5">{d.synonym}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-[11.5px] t-muted mt-3 leading-snug">
              Targets are ranked by Open Targets association. Pick one to forecast its clinical
              attrition against its historical reference class.
            </p>
          </div>

          {/* targets */}
          <div>
            <label className="eyebrow block mb-2">
              Targets for {disease.name} · ranked by association
            </label>
            <div className="grid gap-2">
              {targets.map((t) => (
                <TargetRow
                  key={t.symbol}
                  t={t}
                  selected={t.symbol === symbol}
                  modeled={!!getReport(diseaseId, t.symbol)}
                  onSelect={() => setSymbol(t.symbol)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* drug input (third input) */}
        <div className="mt-5 pt-5 hairline">
          <label className="eyebrow block mb-2">
            Drugs · optional · condition the forecast on specific compounds
          </label>
          <DrugInput selected={drugs} onChange={setDrugs} />
          <p className="text-[11.5px] t-muted mt-2 leading-snug max-w-[80ch]">
            Search approved or experimental drugs (ChEMBL, 16,784 compounds). Selecting a drug
            will condition the attrition forecast: a compound already in Phase 3 carries very
            different risk from a preclinical one. The scoring model that consumes this is in
            progress.
          </p>
        </div>
      </section>

      {/* selection summary */}
      {selected && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-5">
          <span className="serif text-[24px]">{selected.symbol}</span>
          <span className="t-muted text-[14px]">{selected.name}</span>
          <span className="t-faint">·</span>
          <span className="mono text-[12px] t-muted">{disease.name}</span>
          {report && (
            <>
              <span className="t-faint">·</span>
              <span className="pill" style={{ borderColor: "var(--line-2)" }}>
                {report.modality.modality}
              </span>
            </>
          )}
        </div>
      )}

      {report ? (
        <div className="flex flex-col gap-10 pb-16" key={`${diseaseId}:${symbol}`}>
          <VerdictBand report={report} />

          <div className="rise">
            <Swimlanes cohort={report.cohort} exitPhase={report.exitPhase} />
            <p className="text-[13px] t-muted mt-3 leading-snug max-w-[80ch]">
              {report.cohortSummary}
            </p>
            <details className="mt-3 group">
              <summary className="mono text-[12px] t-accent cursor-pointer select-none">
                cohort detail · why each program stopped
              </summary>
              <ul className="mt-3 flex flex-col gap-2">
                {report.cohort.map((c) => (
                  <li key={c.drug} className="grid sm:grid-cols-[220px_1fr] gap-x-4 text-[13px]">
                    <span className="t-dim">
                      {c.drug} <span className="mono text-[11px] t-muted">· {c.year}</span>
                    </span>
                    <span className="t-muted leading-snug">{c.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <FailureModes modes={report.failureModes} />
          <ModalityPanel modality={report.modality} />
          <Adversarial bull={report.bull} bear={report.bear} />
          <Derisking steps={report.derisking} />
          <LiteraturePanel papers={literature[`${diseaseId}:${symbol}`] ?? []} />
          <CalibrationPanel cal={report.calibration} />
        </div>
      ) : (
        <NotModeled symbol={symbol} disease={disease.name} note={selected?.note} />
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="pt-8 pb-8">
      <h1 className="serif text-[30px] sm:text-[40px] leading-[1.08] max-w-[22ch]">
        How will this target fail, and what kills the risk cheapest?
      </h1>
      <p className="text-[15px] t-muted mt-4 max-w-[72ch] leading-relaxed">
        A reference-class forecaster for drug-program attrition. Give it a disease, a target and a
        modality; it retrieves the historical programs most mechanistically like yours, shows how
        they died, names each failure mode, and prices the experiment that resolves it early. The
        score is earned on held-out history, not asserted.
      </p>
    </header>
  );
}

function Crumb({ label, active }: { label: string; active?: boolean }) {
  return (
    <span style={{ color: active ? "var(--accent)" : undefined }}>{label}</span>
  );
}

function TargetRow({
  t,
  selected,
  modeled,
  onSelect,
}: {
  t: TargetAssoc;
  selected: boolean;
  modeled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className="text-left rounded-md p-3 transition-colors"
      style={{
        background: selected ? "var(--accent-dim)" : "var(--bg-2)",
        border: `1px solid ${selected ? "var(--accent)" : "var(--line-2)"}`,
      }}
    >
      <div className="flex items-center gap-3">
        <span className="mono text-[14px] font-semibold w-16 flex-none" style={{ color: selected ? "var(--accent)" : "var(--ink)" }}>
          {t.symbol}
        </span>
        <span className="text-[13px] t-dim truncate flex-1 min-w-0">{t.name}</span>
        <div className="flex items-center gap-2 flex-none w-[130px]">
          <div className="meter flex-1">
            <span style={{ width: pct(t.association), background: "var(--accent)" }} />
          </div>
          <span className="mono text-[12px] tabular-nums t-muted w-8 text-right">
            {t.association.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2 pl-[76px]">
        {t.evidence.map((e) => (
          <span
            key={e}
            className="mono text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--line)", color: "var(--muted)" }}
          >
            {e}
          </span>
        ))}
        <span
          className="mono text-[10px] px-1.5 py-0.5 rounded ml-auto"
          style={{
            color: modeled ? "var(--green)" : "var(--faint)",
            border: `1px solid ${modeled ? "var(--green-dim)" : "var(--line)"}`,
          }}
        >
          {modeled ? "● modeled" : "○ not modeled"}
        </span>
      </div>
    </button>
  );
}

function NotModeled({ symbol, disease, note }: { symbol: string; disease: string; note?: string }) {
  return (
    <div className="panel p-8 text-center mb-16 rise">
      <div className="serif text-[22px] mb-2">
        No forecast yet for {symbol} in {disease}
      </div>
      <p className="t-muted text-[14px] max-w-[60ch] mx-auto leading-relaxed">
        Prognosis models a pair by retrieving its mechanistic reference class and its historical
        outcomes. This pair is outside the demo set, so no cohort has been assembled.
        {note ? ` Open Targets note: ${note}` : ""}
      </p>
      <p className="mono text-[12px] t-accent mt-4">
        Try GLP1R or MC4R (Obesity), or BACE1 (Alzheimer&apos;s).
      </p>
    </div>
  );
}
