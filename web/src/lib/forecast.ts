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

import {
  computeAttrition,
  computeAttritionTargetFree,
  attritionMath,
  areaOf,
  phaseOf,
  type AttritionScore,
} from "./attrition";
import { extract } from "./llm";
import { searchPapers, type ElicitPaper } from "./elicit";
import { restQuery } from "./supabase";
import {
  getPatents,
  getDrugTrials,
  getDrugApprovals,
  getDiseaseDescendants,
  keyOf,
  readCache,
  writeCache,
} from "./evidence";
import {
  resolveDisease,
  resolveTarget,
  associationFor,
  cohortCandidates,
  diseaseCohortCandidates,
  isApprovedForIndication,
  type CohortCandidate,
} from "./opentargets";
import type {
  Report,
  CohortProgram,
  FailureMode,
  ModalityFeasibility,
  DeriskingStep,
  MechanismOfAction,
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

// When `subject` is present the forecast is target-free (drug + disease); when
// absent it is the legacy target path (targetSymbol drives everything).
export interface SubjectDescriptor {
  kind: "drug";
  drugName: string;
}

export interface ForecastInput {
  diseaseName: string;
  targetSymbol: string;
  drugs: Drug[];
  subject?: SubjectDescriptor;
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

// Subject framing for the LLM prompts: target path uses the target symbol,
// target-free path uses the drug name. The target branch reproduces the original
// literals exactly so /api/forecast output is byte-identical.
function subjectHead(input: ForecastInput): string {
  return input.subject?.drugName ?? input.targetSymbol;
}
function subjectLines(input: ForecastInput, subjectModality: string): { block: string; heading: string } {
  if (!input.subject) {
    return {
      block: `- Disease: ${input.diseaseName}\n- Target: ${input.targetSymbol}\n- Modality: ${subjectModality}`,
      heading: `Candidate programs acting on ${input.targetSymbol}`,
    };
  }
  return {
    block: `- Disease: ${input.diseaseName}\n- Drug: ${input.subject.drugName}\n- Modality: ${subjectModality}`,
    heading: `Similar programmes developed for ${input.diseaseName}`,
  };
}

async function curateCohort(
  input: ForecastInput,
  cands: CohortCandidate[],
  subjectModality: string
): Promise<CuratedCohort> {
  if (cands.length === 0) {
    return {
      cohort: [],
      cohortSummary: input.subject
        ? `No clinical or approved programs are recorded for ${input.diseaseName} in Open Targets, so there is no reference class yet. The forecast leans on this drug's efficacy evidence and modality feasibility rather than precedent.`
        : `No clinical or approved programs are recorded against ${input.targetSymbol} in Open Targets, so there is no reference class yet. This is a first-in-class position: the forecast leans on target validation and modality feasibility rather than precedent.`,
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
  const sl = subjectLines(input, subjectModality);
  const user = `Subject program:\n${sl.block}\n\n${sl.heading}:\n${cohortLines(rankCandidates(cands).slice(0, 25))}\n\nBuild the reference-class cohort, grounded strictly in the rows above.`;

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
  const user = `Subject: ${subjectHead(input)} in ${input.diseaseName}, modality ${subjectModality}.\n\nReference-class cohort and how each ended:\n${cohortSummary}\n\nLiterature:\n${paperLines(papers)}\n\nPatent landscape (AMASS patentcore):\n${patentLines(patents)}\n\nProduce modality feasibility, failure modes, and the derisking plan.`;

  const data = await extract<ModalityAndRisks>(system, user, schema, { effort: "medium", maxTokens: 4000 });
  return {
    modality: data.modality,
    failureModes: data.failureModes ?? [],
    derisking: data.derisking ?? [],
  };
}

// ------------------------------------------------------ Mechanism of action ----
// Reconstruct the likely biological mechanism linking the drug to the disease
// (through the selected target, if any) from the already-fetched literature +
// patents. The confidence grade is SPECIFIC to that mechanism: if the evidence
// does not substantiate a specific chain, the grade is Very low / Low. This is
// pure narrative + a qualitative grade; it does NOT feed the deterministic number.
async function mechanismLinkage(
  input: ForecastInput,
  papers: ElicitPaper[],
  patents: Patent[],
  targetSymbol?: string
): Promise<MechanismOfAction> {
  const drugName = input.subject?.drugName ?? (input.drugs.map((d) => d.name).join(", ") || "the drug");
  const tgt = targetSymbol?.trim() || "";

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "chain", "targetsInvolved", "confidence", "confidenceReason"],
    properties: {
      summary: { type: "string", description: "1-2 sentences: the most likely mechanism by which the drug affects the disease" },
      chain: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["step", "support"],
          properties: {
            step: { type: "string", description: "one causal link, e.g. 'Drug agonises GLP1R on pancreatic beta cells'" },
            support: { type: "string", description: "evidence backing this link: cite [L#] papers / [P#] patents, or 'unsupported' if none" },
          },
        },
      },
      targetsInvolved: { type: "array", items: { type: "string" }, description: "HGNC symbol(s) the mechanism runs through; empty if none identified" },
      confidence: { type: "string", enum: ["Very low", "Low", "Moderate", "High", "Very high"] },
      confidenceReason: { type: "string", description: "one or two sentences on what evidence does and does not substantiate this specific mechanism" },
    },
  };

  const system =
    "You are a molecular pharmacologist. From the provided literature and patents, reconstruct the most likely biological mechanism by which a drug affects a disease (optionally through a named target): a short causal chain from the drug's molecular action to the disease-relevant effect. Ground every link strictly in the provided evidence; cite the [L#] papers or [P#] patents that support each link, and mark any link 'unsupported' if the evidence does not establish it. Do not assert links from prior knowledge alone. Then grade your confidence in THIS SPECIFIC mechanism on a five-level scale: 'Very high' = each link is directly demonstrated in this disease context by convergent literature and/or patent evidence; 'High' = the chain is well supported with only minor gaps; 'Moderate' = a plausible mechanism with partial or indirect support; 'Low' = weak or fragmentary evidence, mechanism largely speculative; 'Very low' = the evidence does not identify any specific mechanism (mechanism effectively unknown). If you cannot substantiate a mechanism, say so plainly and grade Very low or Low." +
    STYLE;
  const user = `Drug: ${drugName}\nDisease: ${input.diseaseName}\n${tgt ? `Selected target: ${tgt}` : "No specific target selected; identify the most likely target(s) from the evidence."}\n\nLiterature:\n${paperLines(papers)}\n\nPatent landscape (AMASS patentcore):\n${patentLines(patents)}\n\nDescribe the most likely mechanism by which ${drugName} could affect ${input.diseaseName}${tgt ? ` through ${tgt}` : ""}, grounded strictly in the evidence above, and grade your confidence in that specific mechanism.`;

  const data = await extract<MechanismOfAction>(system, user, schema, { effort: "medium", maxTokens: 1600 });
  return {
    summary: data.summary ?? "",
    chain: data.chain ?? [],
    targetsInvolved: data.targetsInvolved ?? [],
    confidence: data.confidence ?? "Very low",
    confidenceReason: data.confidenceReason ?? "",
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
  patentsCount: number,
  efficacyLevel?: string
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
    input.subject
      ? `Drug efficacy evidence in this disease: ${efficacyLevel ?? "none"} (${association.toFixed(2)}).`
      : `Open Targets association: ${associationFound ? association.toFixed(2) : "no association row (neutral prior used)"}.`,
    `Literature retrieved: ${papersCount} papers.`,
    `Patents retrieved: ${patentsCount} (AMASS patentcore).`,
  ].join("\n");

  const rubric =
    "Confidence rubric (evidence density, not optimism): High = >=5 decided analogous programs AND association >=0.5 AND consistent literature; Moderate = a partial reference class or mixed evidence; Low = sparse cohort (<3 decided), no association row, or contested mechanism. Then run an adversarial check: try to refute your own verdict against the failure record; if the refutation has force, cap confidence one level lower.";

  const system =
    "You are the lead forecaster writing the verdict for a drug-program attrition report. You are given the already-computed attrition number and the evidence it was built from. Write the crux verdict (what the program lives or dies on), assign a confidence using the rubric, name the most likely phase of failure, and give the proposer (advance) and skeptic (kill) cases. Do not restate or alter the attrition number. " +
    rubric +
    STYLE;
  const user = `Subject: ${subjectHead(input)} in ${input.diseaseName}.\n\nEvidence:\n${evidence}\n\nDecomposition terms:\n${score.components.map((c) => `- ${c.label}: ${c.kind === "factor" ? `x${c.value.toFixed(2)}` : `${Math.round(c.value * 100)}%`}`).join("\n")}\n\nWrite the verdict, confidence (with the rubric + adversarial check), most-likely exit phase, and the proposer/skeptic cases.`;

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

// ===================================================================== //
//  Target-free helpers (drug + disease, no target)                       //
// ===================================================================== //

// Deterministic modality prior (used by the target-free score's cheap step-2
// ranking). Literature-anchored, not fitted.
function modalityPrior(moleculeType: string | null): number {
  const t = (moleculeType ?? "").toLowerCase();
  if (t.includes("antibody")) return 0.55;
  if (t.includes("small")) return 0.6;
  if (t.includes("protein") || t.includes("peptide")) return 0.5;
  if (t.includes("oligo") || t.includes("nucleotide")) return 0.45;
  return 0.5;
}

const FAILED_RE = /TERMINATED|WITHDRAWN|SUSPENDED/i;
const ONGOING_RE = /RECRUITING|ACTIVE|ENROLL|NOT_YET/i;

// Raw failed/decided estimate straight from OT candidate rows (no LLM), mirroring
// the curation prompt's status->outcome rules. null when no decided programs.
function rawOutcome(c: CohortCandidate): "approved" | "failed" | "ongoing" | "unknown" {
  if (/PHASE_?4/i.test(c.maxStage ?? "")) return "approved";
  const statuses = c.reports.map((r) => r.status ?? "");
  if (statuses.some((x) => FAILED_RE.test(x))) return "failed";
  if (statuses.some((x) => ONGOING_RE.test(x))) return "ongoing";
  if (statuses.length && statuses.every((x) => /COMPLETED/i.test(x))) return "ongoing"; // completed, not approved => undecided
  return "unknown";
}
export function rawFailFraction(cands: CohortCandidate[]): number | null {
  let failed = 0;
  let decided = 0;
  for (const c of cands) {
    const o = rawOutcome(c);
    if (o === "failed") {
      failed++;
      decided++;
    } else if (o === "approved") {
      decided++;
    }
  }
  return decided ? failed / decided : null;
}

export interface DrugAttritionScore {
  attrition: number;
  efficacyLevel: EfficacyLevel;
}

// Rank a set of drugs for a disease by a target-free attrition score. Each drug
// gets its OWN efficacy grade (per-drug LLM, cached), which is what differentiates
// drugs at the same phase/modality; the disease cohort + area are shared. The full
// generateForecastTargetFree remains the authoritative number on selection.
export async function scoreDrugsTargetFree(
  diseaseName: string,
  drugs: Drug[]
): Promise<Map<string, DrugAttritionScore>> {
  const disease = await resolveDisease(diseaseName).catch(() => null);
  const efoId = disease?.id ?? null;
  const cands = efoId ? await diseaseCohortCandidates(efoId).catch(() => [] as CohortCandidate[]) : [];
  const sharedFail = rawFailFraction(cands);
  const area = areaOf(diseaseName);

  // cap concurrency so a 20-drug disease doesn't fire 20 LLM calls at once
  const scored = await mapPool(drugs, 6, async (drug) => {
    const eff = await efficacyFor(drug, diseaseName).catch(
      () => ({ level: "none" as EfficacyLevel, evidence: 0.3, rationale: "" })
    );
    const { attrition } = attritionMath({
      area,
      phase: phaseOf(drug.max_phase),
      association: efficacyScoreOf(eff),
      modalityOverall: modalityPrior(drug.molecule_type),
      cohortFailFraction: sharedFail,
      leadMaxPhase: drug.max_phase,
    });
    return [drug.chembl_id || drug.name, { attrition, efficacyLevel: eff.level }] as const;
  });
  return new Map(scored);
}

// bounded-concurrency map (preserves order)
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- efficacy-evidence stage: the target-free replacement for the genetic term ----
export type EfficacyLevel = "strong" | "moderate" | "weak" | "none";
interface EfficacyResult {
  level: EfficacyLevel;
  evidence: number;
  rationale: string;
}
// Deterministic level -> 0-1 mapping that feeds attritionMath's second term.
// Anchored on the association scale (0.3 = neutral, OR = 1.0). "none" is NEVER a
// reward: absence of efficacy evidence stays neutral, not high.
export const EFFICACY_TO_SCORE: Record<EfficacyLevel, number> = {
  strong: 0.75,
  moderate: 0.55,
  weak: 0.4,
  none: 0.3,
};

// The value that feeds attritionMath's second term. Blends the level bucket
// (reproducible anchor) with the model's continuous 0-1 evidence, so drugs at the
// same level still differentiate (e.g. two "strong" approved drugs don't tie).
function efficacyScoreOf(eff: EfficacyResult): number {
  const anchor = EFFICACY_TO_SCORE[eff.level];
  const raw = typeof eff.evidence === "number" ? Math.max(0, Math.min(1, eff.evidence)) : anchor;
  return Math.max(0.05, Math.min(0.95, 0.5 * anchor + 0.5 * raw));
}

async function efficacyEvidence(
  drug: Drug,
  diseaseName: string,
  trials: TrialDetail[],
  papers: ElicitPaper[]
): Promise<EfficacyResult> {
  if (!trials.length && !papers.length) {
    return {
      level: "none",
      evidence: 0.3,
      rationale: `No efficacy evidence for ${drug.name.toLowerCase()} in ${diseaseName} was retrieved.`,
    };
  }
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["level", "evidence", "rationale"],
    properties: {
      level: { type: "string", enum: ["strong", "moderate", "weak", "none"] },
      evidence: { type: "number", description: "0-1 strength of the efficacy evidence you actually see" },
      rationale: { type: "string", description: "one sentence, grounded strictly in the trials/literature provided" },
    },
  };
  const trialLines = trials
    .slice(0, 12)
    .map((t) => `- ${t.phase || "?"} ${t.status ?? ""}${t.whyStopped ? ` (stopped: ${t.whyStopped})` : ""}${t.title ? ` — ${t.title}` : ""}`)
    .join("\n");
  const system =
    "You are a clinical-evidence analyst. From ONLY the provided trials (this drug) and literature abstracts, judge how strongly the evidence supports that this drug is efficacious in this disease. Grade 'strong' only for positive controlled clinical outcomes with effect size; 'moderate' for suggestive clinical signal; 'weak' for preclinical/anecdotal only; 'none' when the evidence does not address efficacy in this disease. Do NOT reward absence of evidence: missing or off-indication data is 'none', not a high grade. Give a one-sentence rationale citing the specific trial or paper. Do not use em-dashes.";
  const user = `Drug: ${drug.name}\nDisease: ${diseaseName}\n\nThis drug's trials (AMASS):\n${trialLines || "(none)"}\n\nLiterature (Elicit):\n${paperLines(papers)}\n\nGrade the efficacy evidence for ${drug.name} in ${diseaseName}.`;
  const data = await extract<EfficacyResult>(system, user, schema, { effort: "low", maxTokens: 900 });
  const level = (["strong", "moderate", "weak", "none"] as const).includes(data.level) ? data.level : "none";
  return {
    level,
    evidence: typeof data.evidence === "number" ? data.evidence : EFFICACY_TO_SCORE[level],
    rationale: data.rationale ?? "",
  };
}

// Cached per-drug efficacy grade for (drug, disease). One AMASS/Elicit/LLM cost at
// most per pair, ever. Both the ranked table and the full dashboard read this, so
// the estimate and the dashboard's efficacy term agree. Callers may pass already
// fetched trials/papers to avoid re-fetching.
async function efficacyFor(
  drug: Drug,
  diseaseName: string,
  trials?: TrialDetail[],
  papers?: ElicitPaper[]
): Promise<EfficacyResult> {
  const ref = `${drug.chembl_id || drug.name}|${diseaseName}`;
  const cacheKey = keyOf("efficacy", ref);
  const cached = await readCache<EfficacyResult>(cacheKey);
  if (cached && cached.length) return cached[0];

  const [t, p] = await Promise.all([
    trials ?? getDrugTrials(drug.name).catch(() => [] as TrialDetail[]),
    papers ?? searchPapers(`${drug.name} efficacy in ${diseaseName}: clinical trial outcomes, effect size`, 6).catch(() => [] as ElicitPaper[]),
  ]);
  const eff = await efficacyEvidence(drug, diseaseName, t, p);
  await writeCache(cacheKey, "efficacy", ref, [eff]);
  return eff;
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

  // Approved-for-indication check: if the lead drug is already approved for this
  // disease (or a subtype of it), attrition is a hard 0. OT lookups are cached + free.
  const leadDrug = input.drugs.reduce<Drug | null>(
    (b, d) => (b == null || (d.max_phase ?? -1) > (b.max_phase ?? -1) ? d : b),
    null
  );
  const approvedForIndication =
    leadDrug && efoId
      ? await Promise.all([getDrugApprovals(leadDrug.chembl_id), getDiseaseDescendants(efoId)])
          .then(([ap, desc]) => isApprovedForIndication(ap, efoId, desc))
          .catch(() => false)
      : false;

  // Stage 1 — curate the real cohort (LLM, grounded), then attach ground-truth
  // trials from the raw Open Targets candidates (+ pg_trials completion dates),
  // then merge in any AMASS trials fetched for the drug(s) the user typed.
  const { cohort: curatedCohort, cohortSummary } = await curateCohort(input, cands, subjectModality);
  const cohort = await enrichCohortWithAmass(await attachTrials(curatedCohort, cands));

  // Stage 2 — modality feasibility + failure modes + derisking (LLM, grounded),
  // in parallel with the mechanism-of-action synthesis (independent LLM stage).
  const [mr, mechanism] = await Promise.all([
    modalityAndRisks(input, cohort, elicitPapers, patents, subjectModality),
    mechanismLinkage(input, elicitPapers, patents, input.targetSymbol),
  ]);

  // Stage 3 — compute the number (deterministic, the ONLY place it is produced).
  const partialReport = { modality: mr.modality, cohort } as unknown as Report;
  const score = computeAttrition({
    report: partialReport,
    target: targetAssoc,
    drugs: input.drugs,
    diseaseName: input.diseaseName,
    approvedForIndication,
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
    mechanism,
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

// ------------------------------------------------------- target-free main ----
// Full dashboard from (disease + drug), NO target. Same pipeline as
// generateForecast, but the cohort is the DISEASE's programs and the validation
// term is the drug's efficacy evidence (not a target's genetics).
export async function generateForecastTargetFree(diseaseName: string, drug: Drug): Promise<ForecastResult> {
  const now = new Date().toISOString();

  const disease = await resolveDisease(diseaseName).catch(() => null);
  const efoId = disease?.id ?? null;

  const [cands, effPapers, patents, drugTrials] = await Promise.all([
    efoId ? diseaseCohortCandidates(efoId).catch(() => [] as CohortCandidate[]) : Promise.resolve([] as CohortCandidate[]),
    searchPapers(`${drug.name} efficacy in ${diseaseName}: clinical trial outcomes, effect size`, 8).catch(() => [] as ElicitPaper[]),
    getPatents(diseaseName, diseaseName).catch(() => [] as Patent[]),
    getDrugTrials(drug.name).catch(() => [] as TrialDetail[]),
  ]);

  const input: ForecastInput = {
    diseaseName,
    targetSymbol: "",
    drugs: [drug],
    subject: { kind: "drug", drugName: drug.name },
  };
  const subjectModality = subjectModalityOf([drug]);

  // Approved-for-indication check: hard-0 attrition if this drug is already
  // approved for the disease (or a subtype). OT lookups are cached + free.
  const approvedForIndication = efoId
    ? await Promise.all([getDrugApprovals(drug.chembl_id), getDiseaseDescendants(efoId)])
        .then(([ap, desc]) => isApprovedForIndication(ap, efoId, desc))
        .catch(() => false)
    : false;

  // Stage 1 — curate the DISEASE cohort (existing pipeline, target-free framing).
  const { cohort: curatedCohort, cohortSummary } = await curateCohort(input, cands, subjectModality);
  const cohort = await enrichCohortWithAmass(await attachTrials(curatedCohort, cands));

  // Efficacy-evidence stage -> 0-1 (replaces the genetic term). Cached per
  // (drug, disease) so it matches the ranked-table estimate exactly.
  const eff = await efficacyFor(drug, diseaseName, drugTrials, effPapers);
  const efficacyScore = efficacyScoreOf(eff);

  // Stage 2 — modality feasibility + failure modes + derisking, in parallel with
  // the mechanism-of-action synthesis (no selected target: drug -> disease).
  const [mr, mechanism] = await Promise.all([
    modalityAndRisks(input, cohort, effPapers, patents, subjectModality),
    mechanismLinkage(input, effPapers, patents, undefined),
  ]);

  // Stage 3 — the number (deterministic), with the efficacy-evidence label.
  const partialReport = { modality: mr.modality, cohort } as unknown as Report;
  const score = computeAttritionTargetFree({
    diseaseName,
    drug,
    report: partialReport,
    efficacyEvidence: efficacyScore,
    efficacyRationale: eff.rationale,
    efficacyLevel: eff.level,
    approvedForIndication,
  });

  // Stage 4 — verdict, confidence, adversarial.
  const j = await judge(input, score, cohort, eff.level !== "none", efficacyScore, effPapers.length, patents.length, eff.level);

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
    mechanism,
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
    papers: effPapers.map(toPaper),
    patents,
    provenance: {
      efoId,
      ensemblId: null,
      associationFound: eff.level !== "none",
      cohortSize: cohort.length,
      cohortSource: "open_targets",
      trialsAttached: cohort.reduce((n, p) => n + (p.trials?.length ?? 0), 0),
      patentCount: patents.length,
      subjectDrugTrials: drugTrials.length,
      generatedAt: now,
    },
  };
}
