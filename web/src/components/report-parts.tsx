import type {
  Report,
  FailureMode,
  ModalityFeasibility,
  MechanismOfAction,
  DeriskingStep,
  Calibration,
  Signal,
  Paper,
  Patent,
} from "@/lib/types";
import type { AttritionScore, Component } from "@/lib/attrition";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function signalVar(s: Signal): string {
  return s === "red" ? "var(--red)" : s === "amber" ? "var(--amber)" : "var(--green)";
}

function riskColor(x: number): string {
  if (x >= 0.66) return "var(--red)";
  if (x >= 0.4) return "var(--amber)";
  return "var(--green)";
}

function confColor(c: Report["confidence"]): string {
  return c === "High" ? "var(--green)" : c === "Moderate" ? "var(--amber)" : "var(--red)";
}

// Five-level mechanism confidence -> colour gradient (green -> amber -> red).
function mechColor(c: MechanismOfAction["confidence"]): string {
  return c === "Very high" || c === "High"
    ? "var(--green)"
    : c === "Moderate"
      ? "var(--amber)"
      : "var(--red)";
}

/* -------------------------------------------------- blind retrospective mode */
// Rendered above the verdict when a forecast was run as a prediction-as-of-cutoff.
// It states, without spin, exactly what is and is not held back, so the demo claim
// is honest: the attrition % is computed only from pre-cutoff data, but the written
// narrative is NOT outcome-blind because the language model knows the later history.
export function HoldbackBanner({ holdback }: { holdback: NonNullable<Report["holdback"]> }) {
  const outcome = holdback.observedOutcome;
  const outcomeColor = outcome === "failed" ? "var(--red)" : outcome === "approved" ? "var(--green)" : "var(--line-2)";
  return (
    <section className="panel p-5 rise" style={{ borderColor: "var(--amber)" }}>
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <span className="pill mono uppercase text-[11px]" style={{ color: "var(--amber)", borderColor: "var(--amber)" }}>
          Blind retrospective validation
        </span>
        <span className="mono text-[12px] t-dim">prediction as of {holdback.asOfDate}</span>
        {outcome && (
          <span className="pill mono uppercase text-[11px]" style={{ color: outcomeColor, borderColor: outcomeColor }}>
            actual outcome: {outcome}
          </span>
        )}
      </div>
      <p className="text-[13px] t-dim leading-snug max-w-[92ch]">{holdback.label}</p>
      <p className="text-[12.5px] t-muted leading-snug max-w-[92ch] mt-2">
        The attrition % and its decomposition are computed <strong>only</strong> from data that existed
        at the cutoff: the drug&apos;s post-cutoff trial outcomes and literature are withheld, it is removed
        from its own reference cohort, the precedent term counts only programs decided by the cutoff, and
        the base rate is scored at the phase it was then entering. The written narrative (verdict, failure
        modes, bull/bear) is <strong>not</strong> outcome-blind: the language model has parametric knowledge
        of the later history, so treat the prose as hindsight context, not as part of the blind prediction.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ verdict */
export function VerdictBand({
  report,
  attrition,
  approved = false,
}: {
  report: Report;
  attrition: number;
  approved?: boolean;
}) {
  const c = approved ? "var(--green)" : riskColor(attrition);
  if (approved) {
    return (
      <section className="panel p-5 sm:p-6 rise">
        <div className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center">
          <div>
            <div className="eyebrow">Attrition risk</div>
            <div className="serif leading-none mt-2" style={{ fontSize: 64, color: c }}>
              0%
            </div>
            <span
              className="pill mono uppercase mt-3 inline-block"
              style={{ color: c, borderColor: c }}
            >
              Approved for this indication
            </span>
          </div>
          <div className="md:pl-6 md:border-l" style={{ borderColor: "var(--line-2)" }}>
            <p className="serif text-[19px] leading-snug t-dim">
              This drug is already approved for this indication, so its probability of failing before
              approval is 0. The forecast below (mechanism, cohort, patents) is shown for context.
            </p>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="panel p-5 sm:p-6 rise">
      <div className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center">
        <div className="flex items-stretch gap-6">
          <div>
            <div className="eyebrow">Attrition risk</div>
            <div className="serif leading-none mt-2" style={{ fontSize: 64, color: c }}>
              {pct(attrition)}
            </div>
            <div className="text-[12px] t-muted mt-1 max-w-[16ch]">
              probability of failure before approval
            </div>
          </div>
          <div className="w-px self-stretch" style={{ background: "var(--line-2)" }} />
          <div className="flex flex-col justify-center gap-3">
            <div>
              <div className="eyebrow">Most likely time of failure</div>
              <div className="serif text-[26px] leading-none mt-1 t-dim">
                {attrition < 0.1 ? "–" : report.exitPhase}
              </div>
            </div>
            <div>
              <div className="eyebrow">Confidence</div>
              <div
                className="mono text-[15px] mt-1"
                style={{ color: confColor(report.confidence) }}
              >
                {report.confidence}
              </div>
            </div>
          </div>
        </div>

        <div className="md:pl-6 md:border-l" style={{ borderColor: "var(--line-2)" }}>
          <p className="serif text-[19px] leading-snug t-dim">{report.verdict}</p>
          <p className="text-[13px] t-muted mt-3">
            <span className="t-accent mono text-[11px] uppercase tracking-wider">Why this confidence · </span>
            {report.confidenceReason}
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------ attrition composition */
export function AttritionComposition({ score }: { score: AttritionScore }) {
  if (score.approved) {
    return (
      <section className="panel p-5 rise">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <div>
            <div className="eyebrow">Attrition composition</div>
            <h3 className="serif text-[20px] mt-1">Approved for this indication</h3>
          </div>
          <div className="text-right flex-none">
            <div className="serif text-[30px] leading-none" style={{ color: "var(--green)" }}>
              0%
            </div>
            <div className="mono text-[10px] t-muted mt-0.5">already approved</div>
          </div>
        </div>
        <p className="text-[13px] t-dim max-w-[82ch] leading-snug">
          {score.components[0]?.input ??
            "This drug is already approved for this indication, so attrition before approval is 0 by definition."}{" "}
          The reference-class decomposition does not apply.
        </p>
      </section>
    );
  }
  return (
    <section className="panel p-5 rise">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <div>
          <div className="eyebrow">Attrition composition</div>
          <h3 className="serif text-[20px] mt-1">How this number is built</h3>
        </div>
        <div className="text-right flex-none">
          <div className="serif text-[30px] leading-none" style={{ color: riskColor(score.attrition) }}>
            {pct(score.attrition)}
          </div>
          <div className="mono text-[10px] t-muted mt-0.5">attrition = 1 − PoS</div>
        </div>
      </div>
      <p className="text-[12.5px] t-muted mb-4 max-w-[82ch] leading-snug">
        A phase-anchored base rate adjusted by literature-grounded odds ratios in log-odds space:
        logit(PoS) = logit(base) + Σ ln(OR). Dominated here by {score.drivenBy}. Selecting a drug
        moves the base rate to that compound&apos;s development stage.
      </p>
      <div className="divide-y" style={{ borderColor: "var(--line)" }}>
        {score.components.map((c, i) => (
          <CompRow key={i} c={c} />
        ))}
      </div>
      <p className="mono text-[10px] t-muted mt-3">
        v1 coefficients are literature-anchored point estimates, not yet a model fitted on the
        held-out set (see calibration).
      </p>
    </section>
  );
}

function CompRow({ c }: { c: Component }) {
  const isFactor = c.kind === "factor";
  const isResult = c.kind === "result";
  const display = isFactor ? `× ${c.value.toFixed(2)}` : pct(c.value);
  const color = isFactor
    ? c.value >= 1.05
      ? "var(--green)"
      : c.value <= 0.95
        ? "var(--red)"
        : "var(--muted)"
    : "var(--ink)";
  return (
    <div className="grid gap-x-4 py-2.5 md:grid-cols-[1fr_auto] items-start">
      <div className="min-w-0">
        <div className="text-[13.5px] t-dim leading-snug">{c.label}</div>
        <div className="mono text-[10px] t-muted mt-0.5">
          {c.input}
          {c.citation ? ` · ${c.citation}` : ""}
        </div>
      </div>
      <div
        className="mono text-[15px] tabular-nums flex-none md:text-right"
        style={{ color, fontWeight: isResult ? 600 : 400 }}
      >
        {display}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- failure modes */
export function FailureModes({ modes }: { modes: FailureMode[] }) {
  return (
    <section>
      <SectionHead
        n="01"
        title="Failure-mode decomposition"
        sub="Attrition is not one number. Each recurring way this program can die, with the cheapest experiment that confirms or kills it early."
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {modes.map((m) => (
          <article key={m.title} className="panel p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <i className="dot mt-0.5" style={{ background: signalVar(m.signal) }} />
                <h4 className="text-[15px] font-semibold leading-tight">{m.title}</h4>
              </div>
              <div className="text-right flex-none">
                <div className="mono text-[15px] tabular-nums" style={{ color: signalVar(m.signal) }}>
                  {pct(m.probability)}
                </div>
                <div className="eyebrow" style={{ fontSize: 9 }}>of risk</div>
              </div>
            </div>
            <div className="meter">
              <span style={{ width: pct(m.probability), background: signalVar(m.signal) }} />
            </div>
            <p className="text-[13.5px] t-dim leading-snug">{m.mechanism}</p>
            <p className="text-[12.5px] t-muted leading-snug">
              <span className="mono text-[10px] uppercase tracking-wider">Evidence · </span>
              {m.evidence}
            </p>
            <div
              className="mt-auto rounded-md p-3"
              style={{ background: "var(--bg-2)", border: "1px solid var(--line)" }}
            >
              <div className="eyebrow t-accent mb-1">Kill experiment</div>
              <p className="text-[13px] t-dim leading-snug">{m.killExperiment}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 mono text-[11px] t-muted">
                <span>cost <span className="t-dim">{m.cost}</span></span>
                <span>readout <span className="t-dim">{m.timeline}</span></span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- modality */
export function ModalityPanel({ modality }: { modality: ModalityFeasibility }) {
  return (
    <section>
      <SectionHead
        n="02"
        title="Modality feasibility"
        sub="Target validity is not druggability. This layer scores whether your chosen modality can actually reach and drug the target."
      />
      <div className="panel p-5">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div>
            <div className="eyebrow">Modality</div>
            <div className="serif text-[22px] mt-1">{modality.modality}</div>
          </div>
          <div className="text-right">
            <div className="eyebrow">Overall feasibility</div>
            <div
              className="mono text-[22px] tabular-nums mt-1"
              style={{ color: riskColor(1 - modality.overall) }}
            >
              {pct(modality.overall)}
            </div>
          </div>
        </div>
        <p className="serif text-[16px] t-dim leading-snug mb-5">{modality.verdict}</p>
        <div className="grid gap-3">
          {modality.axes.map((a) => (
            <div key={a.label} className="grid sm:grid-cols-[180px_1fr] gap-x-4 gap-y-1 items-center">
              <div className="text-[13.5px]">{a.label}</div>
              <div className="flex items-center gap-3">
                <div className="meter flex-1">
                  <span
                    style={{ width: pct(a.score), background: riskColor(1 - a.score) }}
                  />
                </div>
                <span className="mono text-[12px] tabular-nums t-muted w-9 text-right">
                  {pct(a.score)}
                </span>
              </div>
              <div />
              <p className="text-[12px] t-muted leading-snug sm:col-start-2">{a.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ adversarial */
export function Adversarial({ bull, bear }: { bull: string[]; bear: string[] }) {
  return (
    <section>
      <SectionHead
        n="03"
        title="Proposer vs skeptic"
        sub="Calibration lives in the disagreement. One agent builds the strongest case to advance; the other tries to falsify it against the failure record."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <Argument role="Proposer" stance="the case to advance" points={bull} color="var(--green)" />
        <Argument role="Skeptic" stance="the case to kill" points={bear} color="var(--red)" />
      </div>
    </section>
  );
}

function Argument({
  role,
  stance,
  points,
  color,
}: {
  role: string;
  stance: string;
  points: string[];
  color: string;
}) {
  return (
    <article className="panel p-4" style={{ borderColor: "var(--line-2)" }}>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="dot" style={{ background: color }} />
        <h4 className="serif text-[18px]">{role}</h4>
        <span className="mono text-[11px] t-muted">{stance}</span>
      </div>
      <ul className="flex flex-col gap-2.5">
        {points.map((p, i) => (
          <li key={i} className="flex gap-2.5 text-[13.5px] t-dim leading-snug">
            <span className="mono text-[11px] mt-0.5 flex-none" style={{ color }}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* --------------------------------------------------------------- derisking */
export function Derisking({ steps }: { steps: DeriskingStep[] }) {
  return (
    <section>
      <SectionHead
        n="04"
        title="Derisking plan"
        sub="The kill experiments, ordered by value of information. What to spend next to collapse the biggest uncertainty for the least money."
      />
      <div className="panel divide-y" style={{ borderColor: "var(--line-2)" }}>
        {steps.map((s, i) => (
          <div
            key={i}
            className="grid gap-x-4 gap-y-2 p-4 md:grid-cols-[auto_1fr_auto] items-start"
            style={{ borderColor: "var(--line)" }}
          >
            <div className="mono text-[22px] tabular-nums t-muted leading-none pt-0.5">
              {String(i + 1).padStart(2, "0")}
            </div>
            <div className="min-w-0">
              <p className="text-[14.5px] t-dim leading-snug">{s.action}</p>
              <p className="text-[12px] t-muted mt-1">
                <span className="mono text-[10px] uppercase tracking-wider">Addresses · </span>
                {s.addresses}
              </p>
            </div>
            <div className="flex md:flex-col gap-x-4 gap-y-1 md:text-right mono text-[11px] t-muted md:min-w-[130px]">
              <VoiBadge voi={s.voi} />
              <span>cost <span className="t-dim">{s.cost}</span></span>
              <span>readout <span className="t-dim">{s.readout}</span></span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function VoiBadge({ voi }: { voi: DeriskingStep["voi"] }) {
  const color = voi === "Decisive" ? "var(--accent)" : voi === "High" ? "var(--green)" : "var(--muted)";
  return (
    <span className="pill mb-1 md:self-end" style={{ borderColor: color, color }}>
      {voi} VOI
    </span>
  );
}

/* ------------------------------------------------------- mechanism of action */
export function MechanismPanel({ mechanism }: { mechanism?: MechanismOfAction }) {
  if (!mechanism) return null;
  const color = mechColor(mechanism.confidence);
  return (
    <section>
      <SectionHead
        n="00"
        title="Mechanism of action"
        sub="The likely biological chain linking the drug to the disease, reconstructed from the literature and patent landscape. The confidence grade reflects how well the evidence substantiates this specific mechanism, not the overall forecast."
      />
      <div className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <div className="eyebrow">Proposed mechanism</div>
            <p className="serif text-[16px] t-dim leading-snug mt-1">{mechanism.summary}</p>
          </div>
          <span
            className="pill mono uppercase shrink-0"
            style={{ color, borderColor: color }}
          >
            {mechanism.confidence} confidence
          </span>
        </div>

        {mechanism.targetsInvolved.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="eyebrow">Targets</span>
            {mechanism.targetsInvolved.map((t) => (
              <span key={t} className="pill mono">
                {t}
              </span>
            ))}
          </div>
        )}

        {mechanism.chain.length > 0 && (
          <ol className="grid gap-3 mb-4">
            {mechanism.chain.map((link, i) => (
              <li key={i} className="grid grid-cols-[24px_1fr] gap-x-3 items-start">
                <span className="mono text-[12px] tabular-nums t-muted mt-[2px]">{i + 1}</span>
                <div>
                  <div className="text-[13.5px] leading-snug">{link.step}</div>
                  <div className="text-[12px] t-muted leading-snug mt-0.5">{link.support}</div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <p className="text-[12px] t-muted leading-snug">{mechanism.confidenceReason}</p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- calibration */
export function CalibrationPanel({ cal }: { cal: Calibration }) {
  // reliability plot: predicted (x) vs actual failure rate (y), 0..1, with the
  // perfect-calibration diagonal.
  const S = 220;
  const pad = 24;
  const sx = (v: number) => pad + v * (S - 2 * pad);
  const sy = (v: number) => S - pad - v * (S - 2 * pad);
  const maxN = Math.max(...cal.bins.map((b) => b.n));

  return (
    <section>
      <SectionHead
        n="06"
        title="Calibration backtest"
        sub="The score is only worth trusting if it was right on history it never saw. Predictions here use only evidence available before each program read out."
      />
      <div className="panel p-5 grid gap-6 lg:grid-cols-[auto_1fr] items-start">
        <div>
          <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[260px]" role="img" aria-label="Reliability plot">
            {/* frame */}
            <rect x={pad} y={pad} width={S - 2 * pad} height={S - 2 * pad} fill="none" stroke="var(--line-2)" />
            {/* perfect-calibration diagonal */}
            <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="var(--line-3)" strokeDasharray="3 3" />
            {/* bin points, radius ~ n */}
            {cal.bins.map((b, i) => (
              <g key={i}>
                <circle
                  cx={sx(b.predicted)}
                  cy={sy(b.actual)}
                  r={4 + (b.n / maxN) * 7}
                  fill="var(--accent-dim)"
                  stroke="var(--accent)"
                />
              </g>
            ))}
            <text x={sx(0.5)} y={S - 4} textAnchor="middle" fontSize="9" fill="var(--muted)" className="mono">
              predicted risk
            </text>
            <text x={10} y={sy(0.5)} textAnchor="middle" fontSize="9" fill="var(--muted)" className="mono" transform={`rotate(-90 10 ${sy(0.5)})`}>
              observed failure
            </text>
          </svg>
          <p className="mono text-[10px] t-muted text-center mt-1">bubble size = programs in bin</p>
        </div>

        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat label="Held-out programs" value={String(cal.nHeldOut)} />
            <Stat label="Test cutoff" value={String(cal.cutoffYear)} />
            <Stat label="AUPRC" value={cal.auprc.toFixed(2)} sub={`vs ${cal.baseline.toFixed(2)} base rate`} good={cal.auprc > 0.6} />
            <Stat label="Brier score" value={cal.brier.toFixed(2)} sub="lower is better" good={cal.brier < 0.2} />
          </div>
          <p className="text-[13px] t-muted leading-snug">{cal.note}</p>
          <p className="text-[12px] t-muted leading-snug mt-2">
            Points near the dashed line mean predicted risk matched observed failure. Lift over
            the base rate is what tells you the model is doing more than repeating popularity.
          </p>
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  good,
}: {
  label: string;
  value: string;
  sub?: string;
  good?: boolean;
}) {
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div
        className="serif text-[24px] leading-none mt-1"
        style={{ color: good === undefined ? "var(--ink)" : good ? "var(--green)" : "var(--amber)" }}
      >
        {value}
      </div>
      {sub && <div className="mono text-[10px] t-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- literature */
function formatAuthors(a: string[]): string {
  if (!a?.length) return "";
  return a.length <= 2 ? a.join(", ") : `${a[0]} et al.`;
}

export function LiteraturePanel({ papers }: { papers: Paper[] }) {
  if (!papers?.length) return null;
  return (
    <section>
      <SectionHead
        n="05"
        title="Literature"
        sub="The evidence base the forecast reasons over: the most relevant papers for this target-disease pair, retrieved live from Elicit's 138M-paper corpus."
      />
      <div className="panel divide-y" style={{ borderColor: "var(--line-2)" }}>
        {papers.map((p, i) => {
          const href = p.doi ? `https://doi.org/${p.doi}` : p.urls?.[0];
          return (
            <div key={i} className="p-4 grid gap-x-4 gap-y-1 md:grid-cols-[1fr_auto] items-start">
              <div className="min-w-0">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[14.5px] t-dim leading-snug hover:underline"
                    style={{ textDecorationColor: "var(--accent)" }}
                  >
                    {p.title}
                  </a>
                ) : (
                  <span className="text-[14.5px] t-dim leading-snug">{p.title}</span>
                )}
                <p className="text-[12px] t-muted mt-1">
                  {formatAuthors(p.authors)}
                  {p.year ? ` · ${p.year}` : ""}
                  {p.venue ? ` · ${p.venue}` : ""}
                </p>
              </div>
              {p.citedByCount != null && (
                <div className="mono text-[11px] t-muted md:text-right flex-none whitespace-nowrap">
                  {p.citedByCount.toLocaleString()} cites
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- patents */
export function PatentsPanel({ patents }: { patents: Patent[] }) {
  if (!patents?.length) return null;
  return (
    <section>
      <SectionHead
        n="07"
        title="Patent landscape"
        sub="Freedom-to-operate and competitive signal for this target-disease pair, retrieved live from AMASS patentcore. Who is filing, and around what."
      />
      <div className="panel divide-y" style={{ borderColor: "var(--line-2)" }}>
        {patents.map((p, i) => (
          <div key={i} className="p-4 grid gap-x-4 gap-y-1 md:grid-cols-[1fr_auto] items-start">
            <div className="min-w-0">
              {p.url ? (
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[14.5px] t-dim leading-snug hover:underline"
                  style={{ textDecorationColor: "var(--accent)" }}
                >
                  {p.title}
                </a>
              ) : (
                <span className="text-[14.5px] t-dim leading-snug">{p.title}</span>
              )}
              {p.abstract && (
                <p className="text-[12px] t-muted mt-1 leading-snug line-clamp-2">{p.abstract}</p>
              )}
              <p className="mono text-[10.5px] t-muted mt-1">
                {[p.assignee, p.number, p.date ? p.date.slice(0, 4) : null].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- section head */
export function SectionHead({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="mb-4 flex gap-4">
      <span className="mono text-[13px] t-accent pt-1 select-none">{n}</span>
      <div>
        <h3 className="serif text-[22px] leading-tight">{title}</h3>
        <p className="text-[13.5px] t-muted mt-1 max-w-[70ch] leading-snug">{sub}</p>
      </div>
    </div>
  );
}
