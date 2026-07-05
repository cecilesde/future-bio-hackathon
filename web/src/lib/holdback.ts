// Blind retrospective validation ("prediction-as-of-cutoff").
//
// A target-free forecast normally reads a drug's OWN trial outcomes and failure
// literature, so running a drug that later failed is circular, not a validation.
// A HoldbackConfig censors the pipeline so the model predicts a program using
// ONLY information that existed at a chosen cutoff date, then we compare that
// blind prediction to the observed outcome.
//
// Scope of what this CAN and CANNOT hold back (be honest about it in the demo):
//  - CAN censor: Elicit literature (drop post-cutoff papers), the drug's own
//    trial outcomes/stop-reasons, self-inclusion in the reference cohort, and the
//    base-rate phase (score as-of the cutoff phase, not the terminal high-water
//    mark). These are the data inputs to the DETERMINISTIC attrition number.
//  - CANNOT censor: Claude's parametric knowledge. The LLM knows the drug failed
//    regardless of inputs, so the narrative prose is NOT a clean holdback. Only
//    the deterministic attrition number is the auditable artifact.

import type { PhaseKey } from "./attrition";
import type { CohortCandidate } from "./opentargets";
import type { TrialDetail } from "./types";
import type { ElicitPaper } from "./elicit";

export interface HoldbackConfig {
  asOfDate: string; // ISO "YYYY-MM-DD"; nothing known after this instant enters the forecast
  asOfPhase: PhaseKey; // base-rate phase the program was entering at the cutoff (its pivotal trial)
  excludeChemblIds: string[]; // subject drug(s) removed from their own reference cohort
  censorCohort?: boolean; // also temporally censor the reference cohort itself (fully-blind precedent)
  label: string; // human summary shown in the blind-mode banner
}

// Report-side marker so the UI can flag a forecast as a blind retrospective run.
export interface HoldbackInfo {
  asOfDate: string;
  asOfPhase: PhaseKey;
  observedOutcome?: "failed" | "approved"; // the real, known outcome (for the demo reveal)
  label: string;
}

// Registry of backtest programs. Keyed by ChEMBL id; a run for one of these drugs
// against the matching disease is AUTOMATICALLY switched into blind mode, so the
// demo is just "type the drug + disease and Compute". Outcomes below are the real,
// observed results (used only for the post-prediction reveal, never as an input).
interface HoldbackCase extends HoldbackConfig {
  chemblId: string;
  diseaseMatch: RegExp; // which queried disease this case applies to
  observedOutcome: "failed" | "approved";
}

export const HOLDBACK_CASES: HoldbackCase[] = [
  {
    chemblId: "CHEMBL520733", // Semagacestat
    diseaseMatch: /alzheim/i,
    asOfDate: "2009-12-31", // safely before the Aug-2010 Phase-3 halt
    asOfPhase: "p3", // legitimately reached Phase 3; its IDENTITY pivotal trial
    excludeChemblIds: ["CHEMBL520733"],
    censorCohort: true,
    observedOutcome: "failed",
    label:
      "Blind prediction as of 2009-12-31: semagacestat's own trial outcomes and post-2009 literature are withheld; the Phase-3 halt (Aug 2010) had not happened.",
  },
];

// Look up the holdback case for a (drug, disease) pair, if any.
export function holdbackFor(chemblId: string | null | undefined, diseaseName: string): HoldbackCase | null {
  const id = (chemblId ?? "").trim().toUpperCase();
  if (!id) return null;
  return (
    HOLDBACK_CASES.find((c) => c.chemblId.toUpperCase() === id && c.diseaseMatch.test(diseaseName)) ?? null
  );
}

const CENSOR_STATUS = /TERMINATED|WITHDRAWN|SUSPENDED/i;

const cutoffYear = (asOfDate: string): number => Number(asOfDate.slice(0, 4));

// A date string ("YYYY-MM-DD...") strictly after the cutoff.
function dateAfter(date: string | null | undefined, asOfDate: string): boolean {
  if (!date) return false; // unknown date: cannot prove it is post-cutoff, keep it
  return date.slice(0, 10) > asOfDate;
}

// Drop the subject drug's own trials that reveal (or postdate) the outcome:
//  - started after the cutoff,
//  - a stop status (TERMINATED / WITHDRAWN / SUSPENDED),
//  - and null out any whyStopped text on the survivors.
export function censorTrials(trials: TrialDetail[], cfg: HoldbackConfig): TrialDetail[] {
  return trials
    .filter((t) => !dateAfter(t.startDate, cfg.asOfDate))
    .filter((t) => !(t.status && CENSOR_STATUS.test(t.status)))
    .map((t) => ({ ...t, whyStopped: null }));
}

// Drop literature published after the cutoff year. Papers with no year are kept
// (cannot be dated); in practice Elicit returns a year on the outcome papers.
export function censorPapers(papers: ElicitPaper[], cfg: HoldbackConfig): ElicitPaper[] {
  const yr = cutoffYear(cfg.asOfDate);
  return papers.filter((p) => p.year == null || p.year <= yr);
}

// Remove the subject drug from its own reference cohort, and (when censorCohort)
// temporally censor every remaining program's trial reports so the precedent term
// reflects only what was decided by the cutoff:
//  - drop reports that started after the cutoff,
//  - downgrade a post-cutoff-visible stop status to unknown (as-of the cutoff we
//    do not yet know it stopped),
//  - null every whyStopped.
export function censorCandidates(cands: CohortCandidate[], cfg: HoldbackConfig): CohortCandidate[] {
  const excluded = new Set(cfg.excludeChemblIds.map((x) => x.toUpperCase()));
  const kept = cands.filter((c) => !excluded.has((c.drugId ?? "").toUpperCase()));
  if (!cfg.censorCohort) return kept;
  return kept.map((c) => {
    const reports = c.reports
      .filter((r) => !dateAfter(r.startDate, cfg.asOfDate) && (r.year == null || r.year <= cutoffYear(cfg.asOfDate)))
      .map((r) => ({
        ...r,
        // As-of the cutoff we cannot know a trial later stopped; treat a stop
        // status as unknown so it is not counted as a decided failure.
        status: r.status && CENSOR_STATUS.test(r.status) ? null : r.status,
        whyStopped: null,
      }));
    return { ...c, reports };
  });
}
