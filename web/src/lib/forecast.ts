// Live agentic forecast for an arbitrary (disease, target, drug) triple.
//
// Design principle (see docs/agentic-forecast-plan.md §C0): the NUMBER is
// deterministic. computeAttrition() is the sole producer of the attrition score;
// the LLM only produces the score's grounded inputs (a curated real cohort, a
// modality-feasibility estimate) and the qualitative report sections. The model
// never emits the probability.
//
// Cohort source is Open Targets `drugAndClinicalCandidates` (live, no AMASS
// credits required) plus Elicit literature. Runs server-side only.

import { computeAttrition, type AttritionScore } from "./attrition";
import { extract } from "./llm";
import { searchPapers, type ElicitPaper } from "./elicit";
import { restQuery } from "./supabase";
import { getPatents, getDrugTrials } from "./evidence";
import {
  resolveDisease,
  resolveTarget,
  associationFor,
  cohortCandidates,
  type CohortCandidate,
} from "./opentargets";
import type {
  Report,
  CohortProgram,
  FailureMode,
  ModalityFeasibility,
  DeriskingStep,
  TargetAssoc,
  TrialDetail,
  Patent,
  Drug,
  Paper,
} from "./types";

// The LLM returns a drugId provenance token on each program (schema-required);
// it is not part of the public CohortProgram type but is used to join back to the
// raw Open Targets candidate for ground-truth trial detail.
type CuratedProgram = CohortProgram & { drugId?: string };

export interface ForecastInput {
  diseaseName: string;
  targetSymbol: string;
  drugs: Drug[];
}

export interface ForecastResult {
  report: Report;
  score: AttritionScore;
  papers: Paper[];
  patents: Patent[];
  provenance: {
    efoId: string | null;
    ensemblId: string | null;
    associationFound: boolean;
    cohortSize: number;
    cohortSource: "open_targets";
    trialsAttached: number;
    patentCount: number;
    subjectDrugTrials: number; // AMASS trials fetched for the input drug(s)
    generatedAt: string;
  };
}

const NEUTRAL_ASSOC = 0.3; // prior when Open Targets has no association row for the pair

// House style for all generated prose (matches the authored reports).
const STYLE = " Write in plain, concise clinical prose. Do not use em-dashes; use commas, colons, or parentheses instead.";

// ---- serialisation of raw cohort rows for the curation prompt ----
function cohortLines(cands: CohortCandidate[]): string {
  return cands
    .map((c, i) => {
      const rep = c.reports
        .slice(0, 3)
        .map((r) => [r.phase, r.status, r.year, r.whyStopped ? `stopped: ${r.whyStopped}` : ""].filter(Boolean).join(" "))
        .join(" | ");
      const dz = c.diseases.slice(0, 3).join("; ");
      return `[${i + 1}] id=${c.drugId} ${c.drugName} · type=${c.drugType ?? "?"} · maxStage=${c.maxStage ?? "?"} · indications=${dz || "?"}${rep ? ` · trials: ${rep}` : ""}`;
    })
    .join("\n");
}

function paperLines(papers: ElicitPaper[]): string {
  return papers
    .map((p, i) => `[L${i + 1}] ${p.title}${p.year ? ` (${p.year})` : ""}\n${(p.abstract ?? "").slice(0, 600)}`)
    .join("\n\n");
}

function patentLines(patents: Patent[]): string {
  if (!patents.length) return "(no patents retrieved)";
  return patents
    .map((p, i) => `[P${i + 1}] ${p.title}${p.assignee ? ` — ${p.assignee}` : ""}${p.date ? ` (${p.date.slice(0, 4)})` : ""}\n${(p.abstract ?? "").slice(0, 400)}`)
    .join("\n\n");
}

// Rank raw candidates so the most informative ones survive the token cap:
// decided outcomes and later stages first.
function rankCandidates(cands: CohortCandidate[]): CohortCandidate[] {
  const stageRank: Record<string, number> = {
    PHASE_4: 5, PHASE_3: 4, PHASE_2: 3, PHASE_1: 2, EARLY_PHASE_1: 1, PRECLINICAL: 0,
  };
  return [...cands].sort((a, b) => {
    const ra = stageRank[a.maxStage ?? ""] ?? 0;
    const rb = stageRank[b.maxStage ?? ""] ?? 0;
    if (rb !== ra) return rb - ra;
    return b.reports.length - a.reports.length;
  });
}

// ---------------------------------------------------------------- Stage 1 ----
interface CuratedCohort {
  cohort: CuratedProgram[];
  cohortSummary: string;
}

const STAGE_RANK: Record<string, number> = {
  PHASE_4: 5, PHASE4: 5, PHASE_3: 4, PHASE3: 4, PHASE_2: 3, PHASE2: 3,
  PHASE_1: 2, PHASE1: 2, EARLY_PHASE_1: 1, PRECLINICAL: 0,
};
const MAX_TRIALS_PER_PROGRAM = 15;

// Most informative first: trials with a stoppage reason, then later phase, then
// most recent. Shared by OT attach and AMASS enrichment.
function sortTrials(a: TrialDetail, b: TrialDetail): number {
  const wa = a.whyStopped ? 1 : 0;
  const wb = b.whyStopped ? 1 : 0;
  if (wb !== wa) return wb - wa;
  const sr = (STAGE_RANK[b.phase] ?? 0) - (STAGE_RANK[a.phase] ?? 0);
  if (sr) return sr;
  return (b.startDate ?? "").localeCompare(a.startDate ?? "");
}
const trialKey = (t: TrialDetail) => t.nctId ?? `${t.title ?? ""}|${t.phase}|${t.startDate ?? ""}`;

// Join each curated program back to its raw Open Targets candidate (by drugId,
// then drug name) and attach the real trials. Ground-truth structured data, not
// LLM prose. Then best-effort enrich each trial's completion date from pg_trials
// by NCT id (the only date pg_trials can supply for a cohort drug).
async function attachTrials(cohort: CuratedProgram[], cands: CohortCandidate[]): Promise<CohortProgram[]> {
  const byId = new Map(cands.map((c) => [c.drugId, c]));
  const byName = new Map(cands.map((c) => [c.drugName.toLowerCase(), c]));

  const withTrials = cohort.map((p) => {
    const cand = (p.drugId && byId.get(p.drugId)) || byName.get(p.drug.toLowerCase());
    // strip the internal drugId from the public object
    const { drugId: _drop, ...program } = p;
    void _drop;
    if (!cand) return program as CohortProgram;

    const seen = new Set<string>();
    const trials: TrialDetail[] = cand.reports
      .map(
        (r): TrialDetail => ({
          phase: r.phase ?? "",
          status: r.status,
          startDate: r.startDate,
          completionDate: null,
          whyStopped: r.whyStopped,
          stopReasonCategories: r.stopReasonCategories ?? [],
          title: r.title,
          url: r.url,
          nctId: r.nctId,
          source: "open_targets",
        })
      )
      .filter((t) => {
        const k = trialKey(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort(sortTrials);
    // NB: not capped here; the AMASS enrichment step caps after merging.

    return { ...program, trials } as CohortProgram;
  });

  // best-effort completion-date enrichment from pg_trials (harvested AMASS)
  const ncts = [...new Set(withTrials.flatMap((p) => (p.trials ?? []).map((t) => t.nctId).filter((x): x is string => !!x)))];
  if (ncts.length) {
    try {
      const rows = await restQuery<{ nct_id: string; completion_date: string | null }>(
        `pg_trials?nct_id=in.(${ncts.join(",")})&select=nct_id,completion_date`
      );
      const dateBy = new Map(rows.map((r) => [r.nct_id, r.completion_date]));
      for (const p of withTrials) {
        for (const t of p.trials ?? []) {
          if (t.nctId && dateBy.has(t.nctId)) t.completionDate = dateBy.get(t.nctId) ?? null;
        }
      }
    } catch {
      /* enrichment is best-effort; OT already gives start date + status + why-stopped */
    }
  }
  return withTrials;
}

async function curateCohort(
  input: ForecastInput,
  cands: CohortCandidate[],
  subjectModality: string
): Promise<CuratedCohort> {
  if (cands.length === 0) {
    return {
      cohort: [],
      cohortSummary: `No clinical or approved programs are recorded against ${input.targetSymbol} in Open Targets, so there is no reference class yet. This is a first-in-class position: the forecast leans on target validation and modality feasibility rather than precedent.`,
    };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["cohort", "cohortSummary"],
    properties: {
      cohort: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["drugId", "drug", "target", "indication", "modality", "reached", "outcome", "reason", "similarity", "year"],
          properties: {
            drugId: { type: "string", description: "the id=... provenance token of the source row; must copy an id present in the input" },
            drug: { type: "string" },
            sponsor: { type: "string", description: "developer if known from the drug, else empty string" },
            target: { type: "string" },
            indication: { type: "string" },
            modality: { type: "string", enum: ["Oral peptide", "Injectable peptide", "Small molecule", "Monoclonal antibody"] },
            reached: { type: "string", enum: ["Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"] },
            outcome: { type: "string", enum: ["Approved", "Failed", "Discontinued", "Ongoing"] },
            deathPhase: { type: "string", enum: ["Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"] },
            reason: { type: "string", description: "one sentence: how it ended / current status, grounded in the row's trial data" },
            similarity: { type: "number", description: "0-1 mechanistic analogy to the subject program" },
            year: { type: "number" },
          },
        },
      },
      cohortSummary: { type: "string", description: "2-3 sentences on what the reference class shows: how many decided, where failures cluster." },
    },
  };

  const system =
    "You are a drug-development analyst assembling a reference-class cohort. You are given the real drugs/candidates that act on a target (from Open Targets), each with a provenance id, drug type, furthest clinical stage, indications, and trial reports (phase, overall status, why-stopped). Select and annotate the programs most mechanistically analogous to the subject program. You MUST NOT invent programs: every cohort entry's drugId must copy an id present in the input, and its outcome/stage/year must be grounded in that row's data (TERMINATED/SUSPENDED/WITHDRAWN => Failed or Discontinued; COMPLETED at approval stage or maxStage PHASE_4 => Approved; RECRUITING/ACTIVE/ONGOING => Ongoing). Map drug type to the nearest of the four modality values. Judge each program's mechanistic similarity to the subject. Prefer decided (non-ongoing) programs and later stages. Return at most 8." + STYLE;
  const user = `Subject program:\n- Disease: ${input.diseaseName}\n- Target: ${input.targetSymbol}\n- Modality: ${subjectModality}\n\nCandidate programs acting on ${input.targetSymbol}:\n${cohortLines(rankCandidates(cands).slice(0, 25))}\n\nBuild the reference-class cohort, grounded strictly in the rows above.`;

  const data = await extract<CuratedCohort>(system, user, schema, { effort: "low", maxTokens: 3500 });
  const cohort = (data.cohort ?? []).filter((c) => c.drug);
  return { cohort, cohortSummary: data.cohortSummary ?? "" };
}

// Enrich EVERY similar programme with an AMASS trialcore ping (one per programme,
// cached per drug in pg_evidence so a credit is spent at most once). AMASS trials
// (a) fill missing why-stopped / summary / enrollment on the OT trials we already
// have, by NCT id, and (b) add AMASS-only trials. This is what makes the "similar
// programmes" dropdowns detailed on exactly why each programme died. Capped after
// merge to keep payload sane.
async function enrichCohortWithAmass(cohort: CohortProgram[]): Promise<CohortProgram[]> {
  return Promise.all(
    cohort.map(async (p) => {
      const amass = await getDrugTrials(p.drug).catch(() => [] as TrialDetail[]);
      if (!amass.length) return p;
      const amassByNct = new Map(amass.filter((t) => t.nctId).map((t) => [t.nctId as string, t]));

      const existing = (p.trials ?? []).map((t) => {
        const a = t.nctId ? amassByNct.get(t.nctId) : undefined;
        if (!a) return t;
        return {
          ...t,
          whyStopped: t.whyStopped ?? a.whyStopped,
          completionDate: t.completionDate ?? a.completionDate,
          summary: t.summary ?? a.summary,
          enrollment: t.enrollment ?? a.enrollment,
          sponsor: t.sponsor ?? a.sponsor,
        };
      });

      const seen = new Set(existing.map(trialKey));
      const extra = amass.filter((t) => !seen.has(trialKey(t)));
      const merged = [...existing, ...extra].sort(sortTrials).slice(0, MAX_TRIALS_PER_PROGRAM);
      return { ...p, trials: merged };
    })
  );
}

// ---------------------------------------------------------------- Stage 2 ----
interface ModalityAndRisks {
  modality: ModalityFeasibility;
  failureModes: FailureMode[];
  derisking: DeriskingStep[];
}

async function modalityAndRisks(
  input: ForecastInput,
  cohort: CohortProgram[],
  papers: ElicitPaper[],
  patents: Patent[],
  subjectModality: string
): Promise<ModalityAndRisks> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["modality", "failureModes", "derisking"],
    properties: {
      modality: {
        type: "object",
        additionalProperties: false,
        required: ["modality", "overall", "verdict", "axes"],
        properties: {
          modality: { type: "string" },
          overall: { type: "number", description: "0-1 overall feasibility of this modality reaching and drugging this target" },
          verdict: { type: "string" },
          axes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "score", "note"],
              properties: { label: { type: "string" }, score: { type: "number" }, note: { type: "string" } },
            },
          },
        },
      },
      failureModes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "mechanism", "probability", "evidence", "killExperiment", "cost", "timeline", "signal"],
          properties: {
            title: { type: "string" },
            mechanism: { type: "string" },
            probability: { type: "number", description: "0-1 share of THIS program's total attrition risk; across modes should sum to ~1" },
            evidence: { type: "string" },
            killExperiment: { type: "string" },
            cost: { type: "string", description: "e.g. $0.8-1.5M" },
            timeline: { type: "string", description: "e.g. 3-4 months" },
            signal: { type: "string", enum: ["green", "amber", "red"] },
          },
        },
      },
      derisking: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "addresses", "cost", "readout", "voi"],
          properties: {
            action: { type: "string" },
            addresses: { type: "string" },
            cost: { type: "string" },
            readout: { type: "string" },
            voi: { type: "string", enum: ["Decisive", "High", "Moderate"] },
          },
        },
      },
    },
  };

  const cohortSummary = cohort.length
    ? cohort.map((c) => `- ${c.drug} (${c.modality}, reached ${c.reached}, ${c.outcome}): ${c.reason}`).join("\n")
    : "(no clinical reference class for this target)";

  const system =
    "You are a translational-medicine risk analyst. Given a subject program (disease + target + modality), its real reference-class cohort with each program's failure reason, the literature, and the patent landscape, produce three things: (1) modality feasibility: an overall 0-1 score plus named axes (e.g. stability, permeability, bioavailability, target-tissue access, CMC) each with a 0-1 score and a one-line note; (2) failure modes: the recurring ways THIS program can die, each with a share of total attrition risk (shares ~sum to 1), the mechanism, evidence (cite the cohort's actual failures, the literature, or the patents), a cheap kill experiment, its cost and timeline, and a signal (green=low/monitored, amber=live, red=likely); (3) a derisking plan: the kill experiments ordered by value of information. Ground failure modes in how analogous programs actually failed. The patent landscape informs competitive/freedom-to-operate and differentiation risk. Do not output any probability of overall success; that is computed separately." + STYLE;
  const user = `Subject: ${input.targetSymbol} in ${input.diseaseName}, modality ${subjectModality}.\n\nReference-class cohort and how each ended:\n${cohortSummary}\n\nLiterature:\n${paperLines(papers)}\n\nPatent landscape (AMASS patentcore):\n${patentLines(patents)}\n\nProduce modality feasibility, failure modes, and the derisking plan.`;

  const data = await extract<ModalityAndRisks>(system, user, schema, { effort: "medium", maxTokens: 4000 });
  return {
    modality: data.modality,
    failureModes: data.failureModes ?? [],
    derisking: data.derisking ?? [],
  };
}

// ---------------------------------------------------------------- Stage 4 ----
interface Judgement {
  verdict: string;
  confidence: "High" | "Moderate" | "Low";
  confidenceReason: string;
  exitPhase: Report["exitPhase"];
  bull: string[];
  bear: string[];
}

async function judge(
  input: ForecastInput,
  score: AttritionScore,
  cohort: CohortProgram[],
  associationFound: boolean,
  association: number,
  papersCount: number,
  patentsCount: number
): Promise<Judgement> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "confidence", "confidenceReason", "exitPhase", "bull", "bear"],
    properties: {
      verdict: { type: "string", description: "one or two sentences: the crux — what this program lives or dies on" },
      confidence: { type: "string", enum: ["High", "Moderate", "Low"] },
      confidenceReason: { type: "string", description: "grounded in evidence density: cohort size, association strength, literature agreement" },
      exitPhase: { type: "string", enum: ["Preclinical", "Phase 1", "Phase 2", "Phase 3", "Filed", "Approved"] },
      bull: { type: "array", items: { type: "string" }, description: "3-4 strongest points to advance" },
      bear: { type: "array", items: { type: "string" }, description: "3-4 strongest points to kill; try to falsify the bull case" },
    },
  };

  const decided = cohort.filter((c) => c.outcome !== "Ongoing").length;
  const failed = cohort.filter((c) => c.outcome === "Failed" || c.outcome === "Discontinued").length;
  const evidence = [
    `Computed attrition risk: ${Math.round(score.attrition * 100)}% (probability of failure before approval).`,
    `Dominant driver of the score: ${score.drivenBy}.`,
    `Reference cohort: ${cohort.length} programs (${decided} decided, ${failed} failed/discontinued).`,
    `Open Targets association: ${associationFound ? association.toFixed(2) : "no association row (neutral prior used)"}.`,
    `Literature retrieved: ${papersCount} papers.`,
    `Patents retrieved: ${patentsCount} (AMASS patentcore).`,
  ].join("\n");

  const rubric =
    "Confidence rubric (evidence density, not optimism): High = >=5 decided analogous programs AND association >=0.5 AND consistent literature; Moderate = a partial reference class or mixed evidence; Low = sparse cohort (<3 decided), no association row, or contested mechanism. Then run an adversarial check: try to refute your own verdict against the failure record; if the refutation has force, cap confidence one level lower.";

  const system =
    "You are the lead forecaster writing the verdict for a drug-program attrition report. You are given the already-computed attrition number and the evidence it was built from. Write the crux verdict (what the program lives or dies on), assign a confidence using the rubric, name the most likely phase of failure, and give the proposer (advance) and skeptic (kill) cases. Do not restate or alter the attrition number. " +
    rubric +
    STYLE;
  const user = `Subject: ${input.targetSymbol} in ${input.diseaseName}.\n\nEvidence:\n${evidence}\n\nDecomposition terms:\n${score.components.map((c) => `- ${c.label}: ${c.kind === "factor" ? `x${c.value.toFixed(2)}` : `${Math.round(c.value * 100)}%`}`).join("\n")}\n\nWrite the verdict, confidence (with the rubric + adversarial check), most-likely exit phase, and the proposer/skeptic cases.`;

  const data = await extract<Judgement>(system, user, schema, { effort: "high", maxTokens: 2500 });
  return {
    verdict: data.verdict ?? "",
    confidence: data.confidence ?? "Low",
    confidenceReason: data.confidenceReason ?? "",
    exitPhase: data.exitPhase ?? "Phase 2",
    bull: data.bull ?? [],
    bear: data.bear ?? [],
  };
}

// ---- subject modality inference from the selected drug(s) ----
function subjectModalityOf(drugs: Drug[]): string {
  const lead = drugs.find((d) => d.molecule_type);
  const t = (lead?.molecule_type ?? "").toLowerCase();
  if (t.includes("antibody")) return "Monoclonal antibody";
  if (t.includes("protein") || t.includes("peptide")) return "Injectable peptide";
  if (t.includes("small")) return "Small molecule";
  return drugs.length ? "Small molecule" : "Modality not yet chosen";
}

function toPaper(p: ElicitPaper): Paper {
  return { ...p, pmid: null };
}

// ------------------------------------------------------------------- main ----
export async function generateForecast(input: ForecastInput): Promise<ForecastResult> {
  const now = new Date().toISOString();

  // Stage 0 — resolve + assemble evidence in parallel (deterministic).
  const [disease, target] = await Promise.all([
    resolveDisease(input.diseaseName),
    resolveTarget(input.targetSymbol),
  ]);
  if (!target) throw new Error(`Could not resolve target "${input.targetSymbol}" in Open Targets.`);

  const efoId = disease?.id ?? null;
  const ensemblId = target.id;

  const [assoc, cands, elicitPapers, patents, subjectDrugTrials] = await Promise.all([
    efoId ? associationFor(ensemblId, efoId) : Promise.resolve({ association: 0, evidence: [], datatypeScores: {}, found: false }),
    cohortCandidates(ensemblId),
    searchPapers(`${input.targetSymbol} as a therapeutic target for ${input.diseaseName}: clinical trial outcomes, efficacy and safety, mechanism`, 8).catch(() => [] as ElicitPaper[]),
    // AMASS patents (cached: one credit at most per disease+target). Empty when
    // AMASS is out of credits, so the forecast degrades gracefully.
    getPatents(input.diseaseName, input.targetSymbol).catch(() => [] as Patent[]),
    // AMASS trials for the drug(s) the user typed (cached per drug). Enriches the
    // subject drug's real clinical history.
    Promise.all(input.drugs.map((d) => getDrugTrials(d.name).catch(() => [] as TrialDetail[])))
      .then((lists) => lists.flat())
      .catch(() => [] as TrialDetail[]),
  ]);

  const associationValue = assoc.found ? assoc.association : NEUTRAL_ASSOC;
  const targetAssoc: TargetAssoc = {
    symbol: target.name || input.targetSymbol.toUpperCase(),
    name: target.name || input.targetSymbol,
    association: associationValue,
    evidence: assoc.evidence,
  };
  const subjectModality = subjectModalityOf(input.drugs);

  // Stage 1 — curate the real cohort (LLM, grounded), then attach ground-truth
  // trials from the raw Open Targets candidates (+ pg_trials completion dates),
  // then merge in any AMASS trials fetched for the drug(s) the user typed.
  const { cohort: curatedCohort, cohortSummary } = await curateCohort(input, cands, subjectModality);
  const cohort = await enrichCohortWithAmass(await attachTrials(curatedCohort, cands));

  // Stage 2 — modality feasibility + failure modes + derisking (LLM, grounded).
  const mr = await modalityAndRisks(input, cohort, elicitPapers, patents, subjectModality);

  // Stage 3 — compute the number (deterministic, the ONLY place it is produced).
  const partialReport = { modality: mr.modality, cohort } as unknown as Report;
  const score = computeAttrition({
    report: partialReport,
    target: targetAssoc,
    drugs: input.drugs,
    diseaseName: input.diseaseName,
  });

  // Stage 4 — verdict, confidence, adversarial (LLM, high effort).
  const j = await judge(input, score, cohort, assoc.found, associationValue, elicitPapers.length, patents.length);

  const report: Report = {
    attrition: score.attrition,
    exitPhase: j.exitPhase,
    verdict: j.verdict,
    confidence: j.confidence,
    confidenceReason: j.confidenceReason,
    cohortSummary,
    cohort,
    failureModes: mr.failureModes,
    modality: mr.modality,
    bull: j.bull,
    bear: j.bear,
    derisking: mr.derisking,
    // Calibration is not applicable to on-the-fly forecasts (no fitted model yet);
    // the UI omits the calibration panel for live reports. Kept for type shape.
    calibration: {
      nHeldOut: cohort.length,
      cutoffYear: 0,
      auprc: 0,
      baseline: 0,
      brier: 0,
      bins: [],
      note: "Calibration backtest is available only for the authored demo pairs; on-the-fly forecasts are not yet fitted.",
    },
  };

  return {
    report,
    score,
    papers: elicitPapers.map(toPaper),
    patents,
    provenance: {
      efoId,
      ensemblId,
      associationFound: assoc.found,
      cohortSize: cohort.length,
      cohortSource: "open_targets",
      trialsAttached: cohort.reduce((n, p) => n + (p.trials?.length ?? 0), 0),
      patentCount: patents.length,
      subjectDrugTrials: subjectDrugTrials.length,
      generatedAt: now,
    },
  };
}
