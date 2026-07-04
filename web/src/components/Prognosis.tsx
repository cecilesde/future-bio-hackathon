"use client";

import { useState } from "react";
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
import { computeAttrition } from "@/lib/attrition";

// Map a typed disease label to an authored (modeled) disease id, or null.
function resolveDiseaseId(label: string | undefined): string | null {
  if (!label) return null;
  const n = label.toLowerCase();
  if (n.includes("obesity") || n.includes("overweight")) return "obesity";
  if (n.includes("alzheimer")) return "alzheimers";
  return null;
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
  const score = report
    ? computeAttrition({ report, target: selectedTarget, drugs, diseaseName })
    : null;

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
      {report && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-5">
          <span className="serif text-[24px]">{symbol}</span>
          {selectedTarget && <span className="t-muted text-[14px]">{selectedTarget.name}</span>}
          <span className="t-faint">·</span>
          <span className="mono text-[12px] t-muted">{diseaseName}</span>
          <span className="t-faint">·</span>
          <span className="pill" style={{ borderColor: "var(--line-2)" }}>
            {report.modality.modality}
          </span>
          {drugs.length > 0 && (
            <span className="mono text-[11px] t-accent">
              + {drugs.map((d) => d.name.toLowerCase()).join(", ")}
            </span>
          )}
        </div>
      )}

      {report && score ? (
        <div className="flex flex-col gap-10 pb-16" key={`${diseaseId}:${symbol}`}>
          <VerdictBand report={report} attrition={score.attrition} />
          <AttritionComposition score={score} />

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
        <NotModeled diseaseName={diseaseName} symbol={symbol} />
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

function NotModeled({ diseaseName, symbol }: { diseaseName: string; symbol: string }) {
  const both = diseaseName && symbol;
  return (
    <div className="panel p-8 text-center mb-16 rise">
      <div className="serif text-[22px] mb-2">
        {both ? `No modeled forecast for ${symbol} in ${diseaseName}` : "Enter a disease and a target"}
      </div>
      <p className="t-muted text-[14px] max-w-[62ch] mx-auto leading-relaxed">
        A full forecast is currently authored for a small demo set of pairs. For any other pair,
        the evidence engine (Elicit literature + AMASS trials) that assembles the reference class
        and resolves untyped inputs is in progress.
      </p>
      <p className="mono text-[12px] t-accent mt-4">
        Try Obesity + GLP1R, Obesity + MC4R, or Alzheimer&apos;s + BACE1.
      </p>
    </div>
  );
}
