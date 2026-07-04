import { PHASES } from "@/lib/types";
import type { CohortProgram, Phase, Outcome } from "@/lib/types";

function outcomeColor(o: Outcome): string {
  if (o === "Approved") return "var(--green)";
  if (o === "Ongoing") return "var(--amber)";
  return "var(--red)";
}

function phaseIdx(p: Phase): number {
  return PHASES.indexOf(p);
}

// A program's "death index": where its survival track stops for KM purposes.
// Approved -> survives to the end; Ongoing -> censored at furthest reached;
// Failed/Discontinued -> the phase it died in.
function dieIdx(p: CohortProgram): number {
  if (p.outcome === "Approved") return PHASES.length - 1;
  if (p.outcome === "Ongoing") return phaseIdx(p.reached);
  return p.deathPhase ? phaseIdx(p.deathPhase) : phaseIdx(p.reached);
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

  // KM-style survival fraction entering each phase column.
  const survival = PHASES.map((_, i) => {
    const alive = cohort.filter((p) => dieIdx(p) >= i).length;
    return alive / n;
  });

  // SVG geometry: 6 equal columns of width 100, height 100.
  const colW = 100;
  const W = cols * colW;
  const H = 100;
  const y = (frac: number) => 8 + (1 - frac) * (H - 16);

  // stepped KM path
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

      {/* shared-axis grid: fixed gutter + track area */}
      <div className="px-4 pb-4">
        <div
          className="grid gap-x-3"
          style={{ gridTemplateColumns: "minmax(150px, 210px) 1fr" }}
        >
          {/* KM curve, spanning the track column */}
          <div />
          <div className="relative mb-2">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="w-full h-16 block"
            >
              {/* subject predicted-exit marker */}
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
              predicted exit
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

          {/* one row per program */}
          {cohort.map((p, ri) => {
            const reachedIndex = phaseIdx(p.reached);
            const death = p.outcome === "Failed" || p.outcome === "Discontinued";
            const deathIndex = p.deathPhase ? phaseIdx(p.deathPhase) : reachedIndex;
            const color = outcomeColor(p.outcome);
            return (
              <div key={ri} className="contents">
                {/* gutter: name + similarity */}
                <div className="min-w-0 py-1.5 pr-2">
                  <div className="text-[13px] leading-tight truncate" title={p.drug}>
                    {p.drug}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="mono text-[10px] t-muted truncate">{p.sponsor}</span>
                    <span
                      className="mono text-[10px] tabular-nums"
                      style={{ color: "var(--accent)" }}
                      title="mechanistic similarity to the subject program"
                    >
                      {p.similarity.toFixed(2)}
                    </span>
                  </div>
                </div>
                {/* track */}
                <div className="py-1.5 self-center">
                  <div className="track">
                    {PHASES.map((_, ci) => {
                      const filled = ci <= reachedIndex;
                      const isDeath = death && ci === deathIndex;
                      return (
                        <div key={ci} className="track-cell">
                          {filled && (
                            <div
                              className="absolute inset-0"
                              style={{
                                background: color,
                                opacity: isDeath ? 0.9 : 0.5,
                              }}
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
