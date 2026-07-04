"use client";

import { useMemo, useState } from "react";
import type { Disease, Report, Paper, Drug } from "@/lib/types";
import Swimlanes from "./Swimlanes";
import DrugInput from "./DrugInput";
import PickerInput, { type PickItem } from "./PickerInput";
import PredictionPanel from "./PredictionPanel";
import {
  VerdictBand,
  AttritionComposition,
  FailureModes,
  ModalityPanel,
  Adversarial,
  Derisking,
  CalibrationPanel,
  LiteraturePanel,
} from "./report-parts";
import { computeAttrition, type AttritionScore } from "@/lib/attrition";

// Map a typed disease label to an authored (modeled) disease id, or null.
function resolveDiseaseId(label: string | undefined): string | null {
  if (!label) return null;
  const n = label.toLowerCase();
  if (n.includes("obesity") || n.includes("overweight")) return "obesity";
  if (n.includes("alzheimer")) return "alzheimers";
  return null;
}

interface LiveForecast {
  report: Report;
  score: AttritionScore;
  papers: Paper[];
  provenance: {
    associationFound: boolean;
    cohortSize: number;
    cohortSource: string;
    ensemblId: string | null;
    efoId: string | null;
  };
  cached?: boolean;
  subjectKey: string; // the subject this result was computed for (client-tagged)
}

interface LivePending {
  key: string;
  state: "loading" | "error";
  error: string;
}

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

  const [diseaseSel, setDiseaseSel] = useState<PickItem | null>({ id: "Obesity", label: "Obesity" });
  const [targetSel, setTargetSel] = useState<PickItem | null>({ id: "GLP1R", label: "GLP1R" });
  const [drugs, setDrugs] = useState<Drug[]>([]);

  const diseaseId = resolveDiseaseId(diseaseSel?.label);
  const authoredDisease = diseases.find((d) => d.id === diseaseId) ?? null;
  const symbol = (targetSel?.id ?? "").toUpperCase();
  const diseaseName = diseaseSel?.label ?? "";

  const report = diseaseId && symbol ? getReport(diseaseId, symbol) : null;
  const selectedTarget =
    authoredDisease?.targets.find((t) => t.symbol.toUpperCase() === symbol) ?? null;
  const authoredScore = report
    ? computeAttrition({ report, target: selectedTarget, drugs, diseaseName })
    : null;

  // ---- live forecast (non-authored pairs) ----
  const drugKey = useMemo(() => drugs.map((d) => d.chembl_id).sort().join(","), [drugs]);
  const subjectKey = `${diseaseName}|${symbol}|${drugKey}`;
  const [live, setLive] = useState<LiveForecast | null>(null);
  const [pending, setPending] = useState<LivePending | null>(null);

  // Derive current-subject views instead of resetting via an effect: a result or
  // pending state only applies if it was computed for the current subject.
  const liveForCurrent = live && live.subjectKey === subjectKey ? live : null;
  const pendingForCurrent = pending && pending.key === subjectKey ? pending : null;
  const liveState: "idle" | "loading" | "error" = pendingForCurrent?.state ?? "idle";
  const liveError = pendingForCurrent?.error ?? "";

  async function runLive() {
    const key = subjectKey;
    setPending({ key, state: "loading", error: "" });
    try {
      const res = await fetch("/api/forecast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disease: diseaseName, target: symbol, drugs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "forecast failed");
      setLive({ ...(data as LiveForecast), subjectKey: key });
      setPending((p) => (p?.key === key ? null : p));
    } catch (e) {
      const error = String(e instanceof Error ? e.message : e);
      setPending((p) => (p?.key === key ? { key, state: "error", error } : p));
    }
  }

  return (
    <div className="max-w-[1120px] mx-auto px-4 sm:px-6">
      <Header />

      {/* pipeline breadcrumb */}
      <nav className="mono text-[11px] t-muted flex flex-wrap items-center gap-2 mb-4">
        <span className="t-accent">Disease</span>
        <span className="t-faint">·</span>
        <span className="t-accent">Target</span>
        <span className="t-faint">·</span>
        <span className="t-accent">Drug</span>
        <span className="t-accent">›</span>
        <span>predict the third</span>
        <span className="t-accent">›</span>
        <span>reference-class forecast</span>
      </nav>

      {/* three typed inputs */}
      <section className="panel p-4 sm:p-5 mb-8">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className="eyebrow block mb-2">Disease</label>
            <PickerInput
              value={diseaseSel}
              onSelect={setDiseaseSel}
              endpoint="/api/diseases"
              placeholder="Type a disease…"
            />
            <p className="mono text-[10px] mt-1" style={{ color: diseaseId ? "var(--green)" : "var(--faint)" }}>
              {diseaseId ? "● modeled disease" : "AMASS disease set · autocomplete"}
            </p>
          </div>
          <div>
            <label className="eyebrow block mb-2">Target</label>
            <PickerInput
              value={targetSel}
              onSelect={setTargetSel}
              endpoint="/api/targets"
              placeholder="Type a target, any gene…"
              allowFreeText
            />
            <p className="mono text-[10px] t-muted mt-1">Open Targets · or any gene, free-form</p>
          </div>
          <div>
            <label className="eyebrow block mb-2">Drug(s)</label>
            <DrugInput selected={drugs} onChange={setDrugs} />
            <p className="mono text-[10px] t-muted mt-1">ChEMBL · approved + experimental</p>
          </div>
        </div>
        <p className="text-[11.5px] t-muted mt-4 leading-snug max-w-[92ch]">
          Fill any two of disease · target · drug and the third is predicted (the evidence engine
          that resolves untyped inputs from Elicit + AMASS is in progress). The drug&apos;s
          development stage conditions the attrition base rate.
        </p>
      </section>

      {/* fill-two-predict-third: Claude + Elicit */}
      <PredictionPanel
        diseaseName={diseaseName}
        targetSymbol={symbol}
        drugNames={drugs.map((d) => d.name)}
        onSelectTarget={(s) => setTargetSel({ id: s, label: s })}
      />

      {/* selection summary */}
      {(report || liveForCurrent) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-5">
          <span className="serif text-[24px]">{symbol}</span>
          {selectedTarget && <span className="t-muted text-[14px]">{selectedTarget.name}</span>}
          <span className="t-faint">·</span>
          <span className="mono text-[12px] t-muted">{diseaseName}</span>
          <span className="t-faint">·</span>
          <span className="pill" style={{ borderColor: "var(--line-2)" }}>
            {(report ?? liveForCurrent!.report).modality.modality}
          </span>
          {drugs.length > 0 && (
            <span className="mono text-[11px] t-accent">
              + {drugs.map((d) => d.name.toLowerCase()).join(", ")}
            </span>
          )}
        </div>
      )}

      {report && authoredScore ? (
        <ReportView
          report={report}
          score={authoredScore}
          papers={literature[`${diseaseId}:${symbol}`] ?? []}
          live={false}
          keyId={`${diseaseId}:${symbol}`}
        />
      ) : liveForCurrent ? (
        <>
          <LiveBanner live={liveForCurrent} />
          <ReportView
            report={liveForCurrent.report}
            score={liveForCurrent.score}
            papers={liveForCurrent.papers}
            live
            keyId={`live:${subjectKey}`}
          />
        </>
      ) : (
        <LiveForecastPrompt
          diseaseName={diseaseName}
          symbol={symbol}
          state={liveState}
          error={liveError}
          onRun={runLive}
        />
      )}
    </div>
  );
}

// The rendered forecast, shared by authored and live paths.
function ReportView({
  report,
  score,
  papers,
  live,
  keyId,
}: {
  report: Report;
  score: AttritionScore;
  papers: Paper[];
  live: boolean;
  keyId: string;
}) {
  return (
    <div className="flex flex-col gap-10 pb-16" key={keyId}>
      <VerdictBand report={report} attrition={score.attrition} />
      <AttritionComposition score={score} />

      <div className="rise">
        <Swimlanes cohort={report.cohort} exitPhase={report.exitPhase} />
        <p className="text-[13px] t-muted mt-3 leading-snug max-w-[80ch]">{report.cohortSummary}</p>
        {report.cohort.length > 0 && (
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
        )}
      </div>

      <FailureModes modes={report.failureModes} />
      <ModalityPanel modality={report.modality} />
      <Adversarial bull={report.bull} bear={report.bear} />
      <Derisking steps={report.derisking} />
      <LiteraturePanel papers={papers} />
      {!live && <CalibrationPanel cal={report.calibration} />}
    </div>
  );
}

function LiveBanner({ live }: { live: LiveForecast }) {
  const { provenance: p } = live;
  return (
    <div className="panel p-4 mb-6 rise" style={{ borderColor: "var(--line-2)" }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className="mono text-[10px] uppercase tracking-wider t-accent">Live forecast</span>
        <span className="t-muted">
          Reference cohort: <span className="t-dim">{p.cohortSize} program{p.cohortSize === 1 ? "" : "s"}</span> from Open Targets
        </span>
        <span className="t-faint">·</span>
        <span className="t-muted">
          Association: <span className="t-dim">{p.associationFound ? "Open Targets" : "neutral prior (no OT row)"}</span>
        </span>
        <span className="t-faint">·</span>
        <span className="t-muted">Narrative generated by Claude over retrieved evidence</span>
        {live.cached && <><span className="t-faint">·</span><span className="mono text-[10px] t-muted">cached</span></>}
      </div>
      <p className="text-[11.5px] t-muted mt-2 leading-snug max-w-[92ch]">
        The attrition number is computed deterministically from the same decomposition used for the
        authored pairs; the cohort is real Open Targets clinical data; the qualitative sections are
        model-generated from that evidence and are not verified clinical fact. Calibration backtest
        is shown only for the authored pairs (this model is not yet fitted).
      </p>
    </div>
  );
}

function LiveForecastPrompt({
  diseaseName,
  symbol,
  state,
  error,
  onRun,
}: {
  diseaseName: string;
  symbol: string;
  state: "idle" | "loading" | "error";
  error: string;
  onRun: () => void;
}) {
  const ready = !!(diseaseName && symbol);
  if (!ready) {
    return (
      <div className="panel p-8 text-center mb-16 rise">
        <div className="serif text-[22px] mb-2">Enter a disease and a target</div>
        <p className="t-muted text-[14px] max-w-[62ch] mx-auto leading-relaxed">
          Pick any disease and any target. If it is not one of the authored demo pairs, a live
          forecast is assembled from Open Targets clinical data and Elicit literature.
        </p>
      </div>
    );
  }
  return (
    <div className="panel p-8 text-center mb-16 rise">
      <div className="serif text-[22px] mb-2">
        Live forecast for {symbol} in {diseaseName}
      </div>
      <p className="t-muted text-[14px] max-w-[64ch] mx-auto leading-relaxed">
        This pair is not in the authored demo set. Assemble a forecast live: the reference cohort is
        pulled from Open Targets clinical data, literature from Elicit, and the failure modes,
        modality feasibility and verdict are generated by Claude over that evidence. The attrition
        number is computed deterministically.
      </p>
      {state === "error" && (
        <p className="mono text-[12px] mt-4" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
      <button
        onClick={onRun}
        disabled={state === "loading"}
        className="mt-5 pill mono text-[13px] px-5 py-2 disabled:opacity-60"
        style={{ borderColor: "var(--accent)", color: "var(--accent)" }}
      >
        {state === "loading" ? "Assembling forecast… (up to ~2 min)" : "Run live forecast"}
      </button>
      {state === "loading" && (
        <p className="mono text-[11px] t-muted mt-3">
          Resolving target · pulling cohort · curating analogues · scoring modality · computing
          attrition · writing verdict
        </p>
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
        drug; it retrieves the historical programs most mechanistically like yours, shows how they
        died, names each failure mode, and prices the experiment that resolves it early. The score
        is earned on held-out history, not asserted.
      </p>
    </header>
  );
}
