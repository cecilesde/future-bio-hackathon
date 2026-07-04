"use client";

import { Fragment, useState } from "react";
import { PHASES } from "@/lib/types";
import type { CohortProgram, Phase, Outcome, TrialDetail } from "@/lib/types";

function outcomeColor(o: Outcome): string {
  if (o === "Approved") return "var(--green)";
  if (o === "Ongoing") return "var(--amber)";
  return "var(--red)";
}

function phaseIdx(p: Phase): number {
  return PHASES.indexOf(p);
}

// A program's "death index": where its survival track stops for KM purposes.
function dieIdx(p: CohortProgram): number {
  if (p.outcome === "Approved") return PHASES.length - 1;
  if (p.outcome === "Ongoing") return phaseIdx(p.reached);
  return p.deathPhase ? phaseIdx(p.deathPhase) : phaseIdx(p.reached);
}

const SHORT: Record<Phase, string> = {
  Preclinical: "Precl",
  "Phase 1": "Ph1",
  "Phase 2": "Ph2",
  "Phase 3": "Ph3",
  Filed: "Filed",
  Approved: "Appr",
};

// At-a-glance outcome badge: makes success/failure obvious without expanding.
function OutcomeBadge({ p }: { p: CohortProgram }) {
  const stopAt = SHORT[p.deathPhase ?? p.reached];
  const spec: Record<Outcome, { txt: string; c: string; bg: string }> = {
    Approved: { txt: "APPROVED", c: "var(--green)", bg: "var(--green-dim)" },
    Ongoing: { txt: `ONGOING · ${SHORT[p.reached]}`, c: "var(--amber)", bg: "var(--amber-dim)" },
    Failed: { txt: `FAILED · ${stopAt}`, c: "var(--red)", bg: "var(--red-dim)" },
    Discontinued: { txt: `DISC · ${stopAt}`, c: "var(--red)", bg: "var(--red-dim)" },
  };
  const s = spec[p.outcome];
  return (
    <span
      className="pill mono uppercase tracking-wide whitespace-nowrap"
      style={{ color: s.c, borderColor: s.c, background: s.bg, fontSize: 9.5 }}
    >
      {s.txt}
    </span>
  );
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const m = d.match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return d;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

function trialStatusColor(s: string | null): string {
  const u = (s ?? "").toUpperCase();
  if (/COMPLET|APPROV/.test(u)) return "var(--green)";
  if (/RECRUIT|ACTIVE|ONGOING|ENROLL|NOT_YET/.test(u)) return "var(--amber)";
  if (/TERMIN|WITHDRAW|SUSPEND|STOP/.test(u)) return "var(--red)";
  return "var(--muted)";
}

function TrialRow({ t }: { t: TrialDetail }) {
  const col = trialStatusColor(t.status);
  return (
    <div className="grid sm:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 py-1.5">
      <span
        className="pill mono self-start whitespace-nowrap"
        style={{ color: col, borderColor: col, fontSize: 9.5 }}
      >
        {(t.phase || "?").replace(/_/g, " ")} · {t.status ?? "?"}
      </span>
      <div className="min-w-0">
        {t.title &&
          (t.url ? (
            <a
              href={t.url}
              target="_blank"
              rel="noreferrer"
              className="t-accent text-[12.5px] leading-snug hover:underline block truncate"
              title={t.title}
            >
              {t.title}
            </a>
          ) : (
            <span className="t-dim text-[12.5px] leading-snug block truncate" title={t.title}>
              {t.title}
            </span>
          ))}
        <span className="mono text-[10.5px] t-muted">
          {fmtDate(t.startDate)} → {fmtDate(t.completionDate)}
          {t.nctId ? ` · ${t.nctId}` : ""}
        </span>
        {t.whyStopped && (
          <p className="text-[12px] t-muted leading-snug mt-0.5">stopped: {t.whyStopped}</p>
        )}
        {t.stopReasonCategories.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {t.stopReasonCategories.map((c) => (
              <span key={c} className="pill mono t-muted" style={{ fontSize: 9 }}>
                {c.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TrialDetailBody({ p }: { p: CohortProgram }) {
  if (p.trials && p.trials.length > 0) {
    return (
      <div>
        <div className="max-h-72 overflow-y-auto pr-1 divide-y" style={{ borderColor: "var(--line)" }}>
          {p.trials.map((t, i) => (
            <TrialRow key={t.nctId ?? i} t={t} />
          ))}
        </div>
        {p.reason && <p className="text-[12.5px] t-muted leading-snug mt-2">{p.reason}</p>}
      </div>
    );
  }
  // authored-pair fallback (assimilated from the removed Prognosis cohort-detail list)
  return (
    <div className="grid sm:grid-cols-[220px_1fr] gap-x-4 text-[13px]">
      <span className="t-dim">
        {p.drug} <span className="mono text-[11px] t-muted">· {p.year} · {p.outcome}</span>
      </span>
      <span className="t-muted leading-snug">{p.reason}</span>
    </div>
  );
}

export default function Swimlanes({
  cohort,
  exitPhase,
}: {
  cohort: CohortProgram[];
  exitPhase: Phase;
}) {
  const n = cohort.length;
  const cols = PHASES.length;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // KM-style survival fraction entering each phase column.
  const survival = PHASES.map((_, i) => {
    const alive = cohort.filter((p) => dieIdx(p) >= i).length;
    return alive / n;
  });

  const colW = 100;
  const W = cols * colW;
  const H = 100;
  const y = (frac: number) => 8 + (1 - frac) * (H - 16);

  let d = `M 0 ${y(1)}`;
  survival.forEach((s, i) => {
    const xEnd = (i + 1) * colW;
    d += ` L ${i * colW} ${y(s)} L ${xEnd} ${y(s)}`;
  });

  const exitX = (phaseIdx(exitPhase) + 0.5) * colW;

  return (
    <div className="panel p-0 overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-4 pb-3">
        <div>
          <div className="eyebrow">Reference cohort · survival</div>
          <h3 className="serif text-[19px] leading-tight mt-1">
            How programs like this one have died
          </h3>
        </div>
        <div className="hidden sm:flex items-center gap-3 text-[11px] mono t-muted">
          <span className="inline-flex items-center gap-1.5">
            <i className="dot" style={{ background: "var(--green)" }} /> approved
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="dot" style={{ background: "var(--amber)" }} /> ongoing
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="dot" style={{ background: "var(--red)" }} /> failed
          </span>
        </div>
      </div>

      {/* shared-axis grid: fixed gutter + track area. One master grid computes the
          two column widths once, so every row + the header + the KM curve align. */}
      <div className="px-4 pb-4">
        <div className="grid gap-x-3" style={{ gridTemplateColumns: "minmax(150px, 210px) 1fr" }}>
          {/* KM curve, spanning the track column */}
          <div />
          <div className="relative mb-2">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-16 block">
              <line
                x1={exitX}
                y1="0"
                x2={exitX}
                y2={H}
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                opacity="0.9"
              />
              <path
                d={`${d} L ${W} ${y(survival[cols - 1])}`}
                fill="none"
                stroke="var(--ink-dim)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {survival.map((s, i) => (
                <circle
                  key={i}
                  cx={(i + 0.5) * colW}
                  cy={y(s)}
                  r="2.5"
                  fill="var(--ink)"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            <div
              className="absolute top-0 mono text-[10px] t-accent -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${((phaseIdx(exitPhase) + 0.5) / cols) * 100}%` }}
            >
              likely failure
            </div>
          </div>

          {/* phase axis header */}
          <div className="eyebrow flex items-end pb-1">cohort</div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {PHASES.map((p) => (
              <div
                key={p}
                className="mono text-[10px] t-muted text-center px-0.5 pb-1 truncate"
                title={p}
              >
                {p === "Preclinical" ? "Precl." : p}
              </div>
            ))}
          </div>

          {/* one row per program — gutter button, track, and (when open) a
              full-bleed detail panel spanning both columns */}
          {cohort.map((p, ri) => {
            const key = `${p.drug}-${ri}`;
            const isOpen = open.has(key);
            const panelId = `sw-panel-${ri}`;
            const reachedIndex = phaseIdx(p.reached);
            const death = p.outcome === "Failed" || p.outcome === "Discontinued";
            const deathIndex = p.deathPhase ? phaseIdx(p.deathPhase) : reachedIndex;
            const color = outcomeColor(p.outcome);
            return (
              <Fragment key={key}>
                {/* gutter: name + similarity + outcome badge, a real toggle button */}
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  className="min-w-0 py-1.5 pr-2 text-left w-full"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="mono text-[9px] t-muted transition-transform flex-none"
                      style={{ transform: isOpen ? "rotate(90deg)" : "none" }}
                    >
                      ▶
                    </span>
                    <span className="text-[13px] leading-tight truncate" title={p.drug}>
                      {p.drug}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 pl-[15px]">
                    <span className="mono text-[10px] t-muted truncate">{p.sponsor}</span>
                    <span
                      className="mono text-[10px] tabular-nums flex-none"
                      style={{ color: "var(--accent)" }}
                      title="mechanistic similarity to the subject program"
                    >
                      {p.similarity.toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-1 pl-[15px]">
                    <OutcomeBadge p={p} />
                  </div>
                </button>

                {/* track */}
                <div className="py-1.5 self-center cursor-pointer" onClick={() => toggle(key)}>
                  <div className="track">
                    {PHASES.map((_, ci) => {
                      const filled = ci <= reachedIndex;
                      const isDeath = death && ci === deathIndex;
                      return (
                        <div key={ci} className="track-cell">
                          {filled && (
                            <div
                              className="absolute inset-0"
                              style={{ background: color, opacity: isDeath ? 0.9 : 0.5 }}
                            />
                          )}
                          {isDeath && (
                            <div
                              className="absolute inset-0 grid place-items-center mono font-semibold"
                              style={{ color: "var(--bg)", fontSize: 12, lineHeight: 1 }}
                            >
                              ×
                            </div>
                          )}
                          {p.outcome === "Ongoing" && ci === reachedIndex && (
                            <div
                              className="absolute inset-0 grid place-items-center mono"
                              style={{ color: "var(--bg)", fontSize: 11 }}
                            >
                              ›
                            </div>
                          )}
                          {p.outcome === "Approved" && ci === cols - 1 && (
                            <div
                              className="absolute inset-0 grid place-items-center mono"
                              style={{ color: "var(--bg)", fontSize: 11 }}
                            >
                              ✓
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* full-bleed detail panel */}
                {isOpen && (
                  <div
                    id={panelId}
                    style={{ gridColumn: "1 / -1" }}
                    className="mt-1 mb-2 pt-3 border-t"
                  >
                    <div
                      className="border-l-2 pl-3"
                      style={{ borderColor: color }}
                    >
                      <TrialDetailBody p={p} />
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
