// Domain model for Prognosis — a reference-class forecasting instrument for
// drug-program attrition. All data in data.ts is illustrative (a UX mock),
// not verified clinical fact.

export type Phase =
  | "Preclinical"
  | "Phase 1"
  | "Phase 2"
  | "Phase 3"
  | "Filed"
  | "Approved";

// Ordered pipeline stages a program passes through. A program's survival track
// fills up to the last stage it reached.
export const PHASES: Phase[] = [
  "Preclinical",
  "Phase 1",
  "Phase 2",
  "Phase 3",
  "Filed",
  "Approved",
];

export type Modality =
  | "Oral peptide"
  | "Injectable peptide"
  | "Small molecule"
  | "Monoclonal antibody";

export type Outcome = "Approved" | "Failed" | "Discontinued" | "Ongoing";

export type Signal = "green" | "amber" | "red";

export interface TargetAssoc {
  symbol: string;
  name: string;
  // Open Targets overall association score, 0-1.
  association: number;
  // Which evidence streams drive the association (chips under each target).
  evidence: string[];
  // Optional editorial note (not provided by Open Targets).
  note?: string;
}

export interface Disease {
  id: string;
  name: string;
  synonym: string;
  efoId?: string;
  targets: TargetAssoc[];
}

// One clinical trial of a cohort program. Ground-truth structured detail from
// Open Targets (start date, status, why-stopped, link), optionally enriched with
// a completion date from pg_trials via the NCT id. NOT LLM-generated.
export interface TrialDetail {
  phase: string; // OT phase string e.g. "PHASE_2" (not the Phase union)
  status: string | null; // TERMINATED / COMPLETED / RECRUITING ...
  startDate: string | null;
  completionDate: string | null; // best-effort from pg_trials via NCT id
  whyStopped: string | null;
  stopReasonCategories: string[];
  title: string | null;
  url: string | null; // ClinicalTrials.gov link (carries the NCT id)
  nctId: string | null;
  // richer detail, mostly from AMASS trialcore enrichment
  summary?: string | null; // brief study summary
  enrollment?: number | null;
  sponsor?: string | null;
  source?: "open_targets" | "amass";
}

export interface CohortProgram {
  drug: string;
  sponsor: string;
  target: string;
  indication: string;
  modality: Modality;
  reached: Phase; // furthest stage reached
  outcome: Outcome;
  deathPhase?: Phase; // stage where a failed/discontinued program stopped
  reason: string; // why it stopped / current status
  similarity: number; // 0-1 mechanistic analogy to the subject program
  year: number; // year of the defining readout
  // Real trials for this program (live forecasts only; undefined for authored pairs).
  trials?: TrialDetail[];
}

export interface FailureMode {
  title: string;
  mechanism: string;
  probability: number; // 0-1 share of this program's total attrition risk
  evidence: string;
  killExperiment: string;
  cost: string;
  timeline: string;
  signal: Signal; // current read on whether this risk is live
}

export interface ModalityAxis {
  label: string;
  score: number; // 0-1 feasibility on this axis
  note: string;
}

export interface ModalityFeasibility {
  modality: Modality;
  overall: number; // 0-1
  verdict: string;
  axes: ModalityAxis[];
}

export interface DeriskingStep {
  action: string;
  addresses: string; // which failure mode(s) it kills
  cost: string;
  readout: string; // time to answer
  voi: "Decisive" | "High" | "Moderate"; // value of information
}

export interface CalibrationBin {
  predicted: number; // bucket midpoint 0-1
  actual: number; // observed failure rate 0-1
  n: number;
}

export interface Calibration {
  nHeldOut: number;
  cutoffYear: number;
  auprc: number;
  baseline: number; // base-rate / popularity floor
  brier: number;
  bins: CalibrationBin[];
  note: string;
}

export interface Drug {
  chembl_id: string;
  name: string;
  max_phase: number | null; // 4 = approved, 1-3 = experimental/clinical
  molecule_type: string | null;
  first_approval: number | null;
}

export interface Paper {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  doi: string | null;
  pmid: string | null;
  venue: string | null;
  citedByCount: number | null;
  urls: string[];
}

export interface Patent {
  title: string;
  abstract: string | null;
  assignee: string | null;
  number: string | null; // publication / patent number
  date: string | null; // filing or publication date
  url: string | null;
}

export interface Report {
  attrition: number; // 0-1 probability of failure before approval
  exitPhase: Phase; // most likely stage of failure
  verdict: string;
  confidence: "High" | "Moderate" | "Low";
  confidenceReason: string;
  cohortSummary: string;
  cohort: CohortProgram[];
  failureModes: FailureMode[];
  modality: ModalityFeasibility;
  bull: string[];
  bear: string[];
  derisking: DeriskingStep[];
  calibration: Calibration;
}
