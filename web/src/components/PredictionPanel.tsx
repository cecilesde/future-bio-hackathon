"use client";

import { useState } from "react";

interface PredictedTarget {
  symbol: string;
  rationale: string;
  evidence: "strong" | "moderate" | "weak";
}
interface Paper {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  urls: string[];
  citedByCount: number | null;
}
type Result =
  | { mode: "targets"; targets: PredictedTarget[]; summary: string; papers: Paper[] }
  | { mode: "evidence"; hasEvidence: boolean; confidence: string; verdict: string; mechanism: string; papers: Paper[] }
  | { mode: "none"; message: string }
  | { mode: "error"; error: string };

const evColor = (e: string) =>
  e === "strong" ? "var(--green)" : e === "moderate" ? "var(--amber)" : "var(--muted)";

export default function PredictionPanel({
  diseaseName,
  targetSymbol,
  drugNames,
  onSelectTarget,
}: {
  diseaseName: string;
  targetSymbol: string;
  drugNames: string[];
  onSelectTarget: (symbol: string) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  const drug = drugNames[0]?.toLowerCase() ?? "";
  const hasDrug = !!drug;
  const hasDisease = !!diseaseName.trim();
  const hasTarget = !!targetSymbol.trim();

  // which prediction applies
  const mode: "targets" | "evidence" | null =
    hasDrug && hasTarget ? "evidence" : hasDrug && hasDisease ? "targets" : null;
  if (!mode) return null;

  const label =
    mode === "targets"
      ? `Predict the targets ${drug} acts through in ${diseaseName}`
      : `Check the evidence that ${drug} interacts with ${targetSymbol}`;

  async function run() {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch("/api/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disease: diseaseName, target: targetSymbol, drug }),
      });
      setResult(await r.json());
    } catch {
      setResult({ mode: "error", error: "request failed" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel p-5 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow t-accent">Predict the missing input · Claude + Elicit</div>
          <h3 className="serif text-[18px] mt-1">{label}</h3>
        </div>
        <button
          onClick={run}
          disabled={loading}
          className="mono text-[12px] px-4 py-2 rounded-md"
          style={{
            background: loading ? "var(--bg-2)" : "var(--accent-dim)",
            border: "1px solid var(--accent)",
            color: "var(--accent)",
          }}
        >
          {loading ? "reading literature…" : mode === "targets" ? "predict targets" : "check evidence"}
        </button>
      </div>
      <p className="text-[11.5px] t-muted mt-2 leading-snug max-w-[86ch]">
        Claude reads the most relevant Elicit papers and{" "}
        {mode === "targets"
          ? "extracts the molecular targets the drug is reported to act through, grounded in the abstracts."
          : "judges whether the literature actually supports this drug–target interaction. If there is none, it says so."}
      </p>

      {result && (
        <div className="mt-4">
          {result.mode === "targets" && (
            <>
              <p className="text-[13px] t-dim leading-snug mb-3">{result.summary}</p>
              {result.targets.length === 0 ? (
                <div
                  className="rounded-md p-3 mono text-[12px]"
                  style={{ background: "var(--red-dim)", border: "1px solid var(--red)", color: "var(--red)" }}
                >
                  Not enough evidence to name a target for {drug} in {diseaseName}.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {result.targets.map((t) => (
                    <div
                      key={t.symbol}
                      className="rounded-md p-3 flex items-start justify-between gap-3"
                      style={{ background: "var(--bg-2)", border: "1px solid var(--line-2)" }}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="mono text-[14px] font-semibold">{t.symbol}</span>
                          <span className="mono text-[10px]" style={{ color: evColor(t.evidence) }}>
                            {t.evidence} evidence
                          </span>
                        </div>
                        <p className="text-[12.5px] t-muted mt-1 leading-snug">{t.rationale}</p>
                      </div>
                      <button
                        onClick={() => onSelectTarget(t.symbol)}
                        className="mono text-[11px] px-2.5 py-1 rounded flex-none"
                        style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}
                      >
                        use →
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <Papers papers={result.papers} />
            </>
          )}

          {result.mode === "evidence" && (
            <>
              <div
                className="rounded-md p-3"
                style={{
                  background: result.hasEvidence ? "var(--green-dim)" : "var(--red-dim)",
                  border: `1px solid ${result.hasEvidence ? "var(--green)" : "var(--red)"}`,
                }}
              >
                <div className="mono text-[12px]" style={{ color: result.hasEvidence ? "var(--green)" : "var(--red)" }}>
                  {result.hasEvidence
                    ? `Evidence found (${result.confidence} confidence)${result.mechanism ? ` · ${result.mechanism}` : ""}`
                    : "Not enough evidence for this interaction"}
                </div>
                <p className="text-[13px] t-dim mt-1 leading-snug">{result.verdict}</p>
              </div>
              <Papers papers={result.papers} />
            </>
          )}

          {result.mode === "error" && (
            <div className="mono text-[12px] t-red">Prediction failed: {result.error}</div>
          )}
        </div>
      )}
    </section>
  );
}

function Papers({ papers }: { papers: Paper[] }) {
  if (!papers?.length) return null;
  return (
    <details className="mt-3">
      <summary className="mono text-[11px] t-accent cursor-pointer select-none">
        {papers.length} papers Claude read
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {papers.map((p, i) => {
          const href = p.doi ? `https://doi.org/${p.doi}` : p.urls?.[0];
          return (
            <li key={i} className="text-[12px] leading-snug">
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="t-dim hover:underline">
                  {p.title}
                </a>
              ) : (
                <span className="t-dim">{p.title}</span>
              )}
              <span className="mono text-[10px] t-muted">
                {" "}
                {[p.authors[0], p.year].filter(Boolean).join(", ")}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
