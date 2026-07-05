"use client";

import { useMemo, useState } from "react";
import type { Disease, Report, Paper, Patent, Drug, DiscoveredDrug } from "@/lib/types";
import Swimlanes from "./Swimlanes";
import DrugInput from "./DrugInput";
import PickerInput, { type PickItem } from "./PickerInput";
import PredictionPanel from "./PredictionPanel";
import {
  VerdictBand,
  HoldbackBanner,
  AttritionComposition,
  MechanismPanel,
  FailureModes,
  ModalityPanel,
  Adversarial,
  Derisking,
  CalibrationPanel,
  LiteraturePanel,
  PatentsPanel,
} from "./report-parts";
import { computeAttrition, type AttritionScore } from "@/lib/attrition";
import NotesPanel from "./NotesPanel";

type NoteContext = { diseaseId: string | null; diseaseName: string; drug: Drug };

function riskColor(x: number): string {
  if (x >= 0.66) return "var(--red)";
  if (x >= 0.4) return "var(--amber)";
  return "var(--green)";
}

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
  patents: Patent[];
  provenance: {
    associationFound: boolean;
    cohortSize: number;
    cohortSource: string;
    ensemblId: string | null;
    efoId: string | null;
    patentCount?: number;
    subjectDrugTrials?: number;
  };
  cached?: boolean;
  subjectKey: string; // the subject this result was computed for (client-tagged)
  targetFree?: boolean; // true for the drug+disease (no target) path
  drugTargets?: string[]; // informational: the drug's mechanism targets
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
  const drugKey = useMemo(() => drugs.map((d) => d.chembl_id || d.name).sort().join(","), [drugs]);
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

  // ---- disease-only drug discovery ----
  const [discovered, setDiscovered] = useState<{ key: string; drugs: DiscoveredDrug[] } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const discoveredForCurrent = discovered && discovered.key === diseaseName ? discovered.drugs : null;

  async function runDiscovery() {
    setDiscovering(true);
    setDiscoverError("");
    const dz = diseaseName;
    try {
      const res = await fetch("/api/discover-drugs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disease: dz }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "discovery failed");
      setDiscovered({ key: dz, drugs: (data.drugs ?? []) as DiscoveredDrug[] });
    } catch (e) {
      setDiscoverError(String(e instanceof Error ? e.message : e));
    } finally {
      setDiscovering(false);
    }
  }

  // ---- (disease + drug, no target) -> target-free forecast ----
  const [tfState, setTfState] = useState<{ drugKey: string; state: "loading" | "error"; error: string } | null>(null);
  const currentDrugKey = drugs[0] ? drugs[0].chembl_id || drugs[0].name : "";
  const tfForCurrent = tfState && tfState.drugKey === currentDrugKey ? tfState : null;

  async function runTargetFree(drug: Drug) {
    const dKey = drug.chembl_id || drug.name;
    setDrugs([drug]);
    setTargetSel(null);
    setTfState({ drugKey: dKey, state: "loading", error: "" });
    try {
      const res = await fetch("/api/forecast-by-drug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disease: diseaseName, drug }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "forecast failed");
      // Must match the render-time subjectKey exactly: `${diseaseName}|${symbol}|${drugKey}`.
      // Target-free means no target (symbol === ""), and drugKey is this drug's chembl_id
      // (or name). A stale `_DRUGFREE_` sentinel here never matched, so results never rendered.
      const key = `${diseaseName}||${drug.chembl_id || drug.name}`;
      setLive({ ...(data as LiveForecast), subjectKey: key, targetFree: true });
      setTfState(null);
    } catch (e) {
      setTfState({ drugKey: dKey, state: "error", error: String(e instanceof Error ? e.message : e) });
    }
  }

  // ---- unified Compute dispatch: pick the lens from whatever inputs are filled ----
  // disease + target (± drug) -> target lens; disease + drug (no target) -> target-free
  // lens; disease only -> discovery (ranked drug table). This is the single action
  // the user takes; the panels below just render whatever it produced.
  const computeMode: "none" | "discovery" | "target" | "targetfree" =
    !diseaseName ? "none" : symbol ? "target" : drugs.length > 0 ? "targetfree" : "discovery";
  const computeBusy = liveState === "loading" || discovering || tfForCurrent?.state === "loading";
  const computeHint =
    computeMode === "none"
      ? "Enter a disease to begin. Add a target for a target-based forecast, a drug for a target-free forecast, or neither to discover and rank candidate drugs."
      : computeMode === "discovery"
        ? `Disease only: discover and rank candidate drugs for ${diseaseName} (no target or drug needed).`
        : computeMode === "target"
          ? `Target lens: reference-class forecast for ${symbol} in ${diseaseName}${drugs.length ? ` (drug: ${drugs.map((d) => d.name).join(", ")})` : ""}.`
          : `Target-free lens: forecast for ${drugs.map((d) => d.name).join(", ")} in ${diseaseName}, no target.`;
  const computeLabel =
    computeMode === "discovery"
      ? "Discover drugs"
      : computeMode === "targetfree"
        ? "Run target-free forecast"
        : "Run forecast";

  function runCompute() {
    if (computeMode === "target") runLive();
    else if (computeMode === "targetfree" && drugs[0]) runTargetFree(drugs[0]);
    else if (computeMode === "discovery") runDiscovery();
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
              allowFreeText
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
        <div className="flex flex-wrap items-center justify-between gap-4 mt-4">
          <p className="text-[11.5px] t-muted leading-snug max-w-[70ch] flex-1 min-w-[240px]">
            {computeHint}
          </p>
          <button
            onClick={runCompute}
            disabled={computeMode === "none" || computeBusy}
            className="mono text-[13px] px-6 py-2.5 rounded-md disabled:opacity-50 flex-none"
            style={{
              background: computeMode === "none" ? "var(--bg-2)" : "var(--accent-dim)",
              border: "1px solid var(--accent)",
              color: "var(--accent)",
            }}
          >
            {computeBusy ? "Computing…" : `${computeLabel} →`}
          </button>
        </div>
      </section>

      {/* fill-two-predict-third: Claude + Elicit */}
      <PredictionPanel
        diseaseName={diseaseName}
        targetSymbol={symbol}
        drugNames={drugs.map((d) => d.name)}
        onSelectTarget={(s) => setTargetSel({ id: s, label: s })}
      />

      {/* disease-only drug discovery */}
      {diseaseName && drugs.length === 0 && (
        <DrugDiscoveryPanel
          diseaseName={diseaseName}
          drugs={discoveredForCurrent}
          loading={discovering}
          error={discoverError}
          onRun={runDiscovery}
          onPick={runTargetFree}
        />
      )}

      {/* selection summary */}
      {(report || liveForCurrent) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-5">
          <span className="serif text-[24px]">{symbol || drugs[0]?.name || diseaseName}</span>
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
          {liveForCurrent.targetFree && (
            <TargetFreeBanner drug={drugs[0]?.name ?? ""} drugTargets={liveForCurrent.drugTargets ?? []} />
          )}
          <LiveBanner live={liveForCurrent} />
          <ReportView
            report={liveForCurrent.report}
            score={liveForCurrent.score}
            papers={liveForCurrent.papers}
            patents={liveForCurrent.patents}
            live
            keyId={`live:${subjectKey}`}
            noteContext={
              drugs[0]
                ? { diseaseId: liveForCurrent.provenance.efoId, diseaseName, drug: drugs[0] }
                : undefined
            }
          />
        </>
      ) : tfForCurrent ? (
        <TargetFreeStatus state={tfForCurrent.state} error={tfForCurrent.error} drug={drugs[0]?.name ?? ""} />
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
  patents = [],
  live,
  keyId,
  noteContext,
}: {
  report: Report;
  score: AttritionScore;
  papers: Paper[];
  patents?: Patent[];
  live: boolean;
  keyId: string;
  noteContext?: NoteContext;
}) {
  return (
    <div className="flex flex-col gap-10 pb-16" key={keyId}>
      {report.holdback && <HoldbackBanner holdback={report.holdback} />}
      <VerdictBand report={report} attrition={score.attrition} approved={score.approved} />
      <AttritionComposition score={score} />
      <MechanismPanel mechanism={report.mechanism} />

      <div className="rise">
        <Swimlanes cohort={report.cohort} exitPhase={report.exitPhase} />
        {report.holdback && (
          <p className="text-[12.5px] mt-3 leading-snug max-w-[88ch]" style={{ color: "var(--amber)" }}>
            Reference class over the full history, shown for context. Programs that were decided only
            after {report.holdback.asOfDate} did <strong>not</strong> feed the blind attrition number
            (its precedent term counts only programs decided by the cutoff). Read this as what later
            happened to the class, not as an input the model saw.
          </p>
        )}
        <p className="text-[13px] t-muted mt-3 leading-snug max-w-[80ch]">{report.cohortSummary}</p>
        <p className="mono text-[11px] t-muted mt-1">
          Select any program above for its trials, dates, and why it stopped.
        </p>
      </div>

      <FailureModes modes={report.failureModes} />
      <ModalityPanel modality={report.modality} />
      <Adversarial bull={report.bull} bear={report.bear} />
      <Derisking steps={report.derisking} />
      {noteContext?.drug && <NotesPanel {...noteContext} />}
      <LiteraturePanel papers={papers} />
      <PatentsPanel patents={patents} />
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
        {typeof p.patentCount === "number" && (
          <>
            <span className="t-faint">·</span>
            <span className="t-muted">
              Patents: <span className="t-dim">{p.patentCount}</span> (AMASS)
            </span>
          </>
        )}
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
  void onRun; // action now lives on the unified Compute button in the input card
  const ready = !!(diseaseName && symbol);
  if (!ready) {
    return (
      <div className="panel p-8 text-center mb-16 rise">
        <div className="serif text-[22px] mb-2">Enter your inputs, then press Compute</div>
        <p className="t-muted text-[14px] max-w-[64ch] mx-auto leading-relaxed">
          Disease + target runs a target-based forecast; disease + drug (no target) runs a
          target-free forecast; a disease alone discovers and ranks candidate drugs. Non-authored
          pairs are assembled live from Open Targets clinical data and Elicit literature.
        </p>
      </div>
    );
  }
  return (
    <div className="panel p-8 text-center mb-16 rise">
      <div className="serif text-[22px] mb-2">
        {state === "loading" ? "Assembling forecast… (up to ~2 min)" : `Ready: ${symbol} in ${diseaseName}`}
      </div>
      <p className="t-muted text-[14px] max-w-[64ch] mx-auto leading-relaxed">
        This pair is not in the authored demo set. Press <span className="t-accent">Run forecast</span>{" "}
        above to assemble it live: the reference cohort is pulled from Open Targets clinical data,
        literature from Elicit, and the failure modes, modality feasibility and verdict are generated
        by Claude over that evidence. The attrition number is computed deterministically.
      </p>
      {state === "error" && (
        <p className="mono text-[12px] mt-4" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
      {state === "loading" && (
        <p className="mono text-[11px] t-muted mt-3">
          Resolving target · pulling cohort · curating analogues · scoring modality · computing
          attrition · writing verdict
        </p>
      )}
    </div>
  );
}

function DrugDiscoveryPanel({
  diseaseName,
  drugs,
  loading,
  error,
  onRun,
  onPick,
}: {
  diseaseName: string;
  drugs: DiscoveredDrug[] | null;
  loading: boolean;
  error: string;
  onRun: () => void;
  onPick: (drug: Drug) => void;
}) {
  const [hideApproved, setHideApproved] = useState(false);
  const approvedCount = drugs?.filter((d) => d.approvedForDisease).length ?? 0;
  const shown = drugs ? (hideApproved ? drugs.filter((d) => !d.approvedForDisease) : drugs) : null;
  return (
    <section className="panel p-5 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow t-accent">Start from the disease · Open Targets + patents + literature</div>
          <h3 className="serif text-[18px] mt-1">Candidate drugs for {diseaseName}</h3>
        </div>
        <div className="flex items-center gap-3">
          {approvedCount > 0 && (
            <label className="mono text-[11px] t-muted flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideApproved}
                onChange={(e) => setHideApproved(e.target.checked)}
                className="accent-current"
              />
              hide {approvedCount} already approved for this disease
            </label>
          )}
          {(loading || drugs) && (
            <button
              onClick={onRun}
              disabled={loading}
              className="mono text-[12px] px-4 py-2 rounded-md disabled:opacity-60"
              style={{ background: loading ? "var(--bg-2)" : "var(--accent-dim)", border: "1px solid var(--accent)", color: "var(--accent)" }}
            >
              {loading ? "searching…" : "refresh"}
            </button>
          )}
        </div>
      </div>
      <p className="text-[11.5px] t-muted mt-2 leading-snug max-w-[86ch]">
        {drugs || loading
          ? "Each drug's attrition is its full target-free forecast, ranked lowest first (drugs already approved for this indication are 0% by definition). The number shown is exactly what opens when you click a drug; the dashboard just adds the decomposition, cohort, and narrative."
          : "Press Discover drugs above to rank candidate drugs for this disease by target-free attrition estimate, lowest first."}
      </p>
      {error && <p className="mono text-[12px] mt-3" style={{ color: "var(--red)" }}>{error}</p>}
      {drugs && drugs.length === 0 && !loading && (
        <p className="t-muted text-[13px] mt-3">No candidate drugs found for this disease.</p>
      )}
      {shown && drugs && drugs.length > 0 && shown.length === 0 && (
        <p className="t-muted text-[13px] mt-3">
          All {drugs.length} candidates are already approved for this disease. Uncheck the filter to
          see them.
        </p>
      )}
      {shown && shown.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {shown.map((d) => (
            <div
              key={`${d.name}-${d.chemblId ?? ""}`}
              className="rounded-md p-3 flex items-start justify-between gap-3"
              style={{ background: "var(--bg-2)", border: "1px solid var(--line-2)" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold">{d.name}</span>
                  {d.approvedForDisease ? (
                    <span
                      className="pill mono uppercase"
                      style={{
                        fontSize: 9.5,
                        color: "var(--green)",
                        borderColor: "var(--green)",
                        background: "var(--green-dim)",
                      }}
                    >
                      approved · {diseaseName}
                    </span>
                  ) : (
                    <span
                      className="pill mono uppercase"
                      style={{
                        fontSize: 9.5,
                        color: d.status === "approved" ? "var(--green)" : "var(--amber)",
                        borderColor: d.status === "approved" ? "var(--green)" : "var(--amber)",
                        background: d.status === "approved" ? "var(--green-dim)" : "var(--amber-dim)",
                      }}
                    >
                      {d.status}
                    </span>
                  )}
                  {d.evidenceSources.map((s) => (
                    <span key={s} className="pill mono t-muted" style={{ fontSize: 9 }}>{s}</span>
                  ))}
                </div>
                <p className="text-[12.5px] t-muted mt-1 leading-snug">{d.rationale}</p>
              </div>
              <div className="flex-none flex items-center gap-3">
                {typeof d.attrition === "number" && (
                  <div className="text-right">
                    <div className="mono text-[16px] tabular-nums leading-none" style={{ color: d.approvedForDisease ? "var(--green)" : riskColor(d.attrition) }}>
                      {Math.round(d.attrition * 100)}%
                    </div>
                    <div className="mono t-muted" style={{ fontSize: 8.5 }}>{d.approvedForDisease ? "approved" : "est. attrition"}</div>
                  </div>
                )}
                {d.drug && (
                  <button
                    onClick={() => onPick(d.drug!)}
                    className="mono text-[11px] px-2.5 py-1 rounded"
                    style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}
                  >
                    forecast →
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TargetFreeBanner({ drug, drugTargets }: { drug: string; drugTargets: string[] }) {
  return (
    <div className="panel p-4 mb-6 rise" style={{ borderColor: "var(--line-2)" }}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="mono text-[10px] uppercase tracking-wider t-accent">Target-free forecast</span>
        <span className="serif text-[18px]">{drug.toLowerCase()}</span>
        <span className="t-muted text-[12px]">attrition computed from the drug and disease, no target</span>
      </div>
      {drugTargets.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="mono text-[10px] t-muted uppercase tracking-wider">acts via</span>
          {drugTargets.slice(0, 6).map((t) => (
            <span key={t} className="pill mono text-[11px] t-muted">{t}</span>
          ))}
        </div>
      )}
      <p className="text-[11px] t-muted mt-2 leading-snug max-w-[92ch]">
        The validation term is this drug&apos;s own efficacy evidence in this disease (its trials + literature),
        and the reference cohort is programmes developed for this disease. No single target drives the score.
      </p>
    </div>
  );
}

function TargetFreeStatus({ state, error, drug }: { state: "loading" | "error"; error: string; drug: string }) {
  return (
    <div className="panel p-8 text-center mb-16 rise">
      {state === "loading" ? (
        <>
          <div className="serif text-[22px] mb-2">Computing attrition for {drug.toLowerCase()}…</div>
          <p className="mono text-[11px] t-muted">
            assembling the disease cohort · grading efficacy evidence · scoring · writing the verdict
          </p>
        </>
      ) : (
        <>
          <div className="serif text-[20px] mb-2">Could not run the forecast</div>
          <p className="mono text-[12px]" style={{ color: "var(--red)" }}>{error}</p>
        </>
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
