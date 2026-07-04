// Computed, decomposed attrition score.
//
// Works in probability-of-success (PoS) space: a phase-anchored base rate is
// adjusted by literature-grounded odds ratios in log-odds space, then
// attrition = 1 - PoS. Every term is returned with its value, the input it came
// from, and a citation, so the UI can render the full mathematical breakdown and
// the number reacts to the disease / target / drug selected.
//
// v1 coefficients are literature-anchored point estimates (not a fitted model);
// they are labelled as such in the UI and are the thing to calibrate next.

import type { Report, TargetAssoc, Drug } from "./types";

type AreaKey = "metabolic" | "neurology" | "oncology" | "default";
type PhaseKey = "pre" | "p1" | "p2" | "p3" | "filed";

// P(approval | currently at phase), by therapeutic area. Shape follows published
// likelihood-of-approval data (Wong, Siah & Lo 2019; BIO/Informa success rates).
const BASE_RATE: Record<AreaKey, Record<PhaseKey, number>> = {
  metabolic: { pre: 0.08, p1: 0.14, p2: 0.22, p3: 0.6, filed: 0.88 },
  neurology: { pre: 0.04, p1: 0.08, p2: 0.12, p3: 0.46, filed: 0.83 },
  oncology: { pre: 0.03, p1: 0.06, p2: 0.1, p3: 0.4, filed: 0.82 },
  default: { pre: 0.05, p1: 0.1, p2: 0.16, p3: 0.5, filed: 0.85 },
};

const AREA_LABEL: Record<AreaKey, string> = {
  metabolic: "Metabolic & endocrine",
  neurology: "Neurology / CNS",
  oncology: "Oncology",
  default: "All indications",
};
const PHASE_LABEL: Record<PhaseKey, string> = {
  pre: "preclinical",
  p1: "Phase 1",
  p2: "Phase 2",
  p3: "Phase 3",
  filed: "filed",
};

export function areaOf(diseaseName: string): AreaKey {
  const n = diseaseName.toLowerCase();
  if (/obesit|diabet|metaboli|lipid|nash|endocrin/.test(n)) return "metabolic";
  if (/alzheim|parkinson|neuro|demen|epilep|sclerosis|migraine/.test(n)) return "neurology";
  if (/cancer|neoplasm|carcinoma|lymphoma|leukemia|tumou?r|oncolog|sarcoma/.test(n)) return "oncology";
  return "default";
}

export function phaseOf(maxPhase: number | null | undefined): PhaseKey {
  if (maxPhase == null) return "pre";
  if (maxPhase >= 4) return "filed";
  if (maxPhase >= 3) return "p3";
  if (maxPhase >= 2) return "p2";
  if (maxPhase >= 1) return "p1";
  return "pre";
}

const clamp = (x: number, lo = 0.001, hi = 0.999) => Math.max(lo, Math.min(hi, x));
const logit = (p: number) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export interface Component {
  label: string;
  kind: "base" | "factor" | "result";
  // base/result carry a probability; factors carry an odds ratio
  value: number;
  input: string;
  citation?: string;
}

export interface AttritionScore {
  attrition: number; // 0-1
  pos: number; // probability of success 0-1
  components: Component[];
  drivenBy: string; // short plain-language summary of the dominant term
}

function cohortFailFraction(report: Report): number {
  const decided = report.cohort.filter((c) => c.outcome !== "Ongoing");
  if (!decided.length) return 0.5;
  const failed = decided.filter((c) => c.outcome === "Failed" || c.outcome === "Discontinued").length;
  return failed / decided.length;
}

// ---- the sole attrition math ----
// Both computeAttrition (from a full Report) and the target tournament (from raw
// features) call this, so the formula can never drift between the two paths.
export interface AttritionFeatures {
  area: AreaKey;
  phase: PhaseKey;
  association: number; // 0-1
  modalityOverall: number; // 0-1
  cohortFailFraction: number | null; // null => neutral (no decided cohort)
  leadMaxPhase: number | null;
}
export interface AttritionTerms {
  br: number;
  orGenetic: number;
  orModality: number;
  orPrecedent: number;
  orDrug: number;
}

export function attritionMath(f: AttritionFeatures): { attrition: number; pos: number; terms: AttritionTerms } {
  const br = BASE_RATE[f.area][f.phase];
  const assoc = clamp(f.association, 0, 1);
  const mod = clamp(f.modalityOverall, 0, 1);
  // null => 0.4 pivot (orPrecedent = 1.0, neutral). Callers with a Report pass the
  // legacy 0.5 empty-cohort default explicitly to keep existing numbers identical.
  const fail = clamp(f.cohortFailFraction == null ? 0.4 : f.cohortFailFraction, 0, 1);
  const orGenetic = Math.pow(2, (assoc - 0.3) / 0.35); // ~2x at assoc 0.65 (Nelson 2015)
  const orModality = Math.pow(2, (mod - 0.5) / 0.4);
  const orPrecedent = Math.pow(2, -((fail - 0.4) / 0.3)); // high prior failure -> penalty
  const orDrug = f.leadMaxPhase != null && f.leadMaxPhase >= 4 ? 1.2 : 1.0;
  const logOdds =
    logit(br) + Math.log(orGenetic) + Math.log(orModality) + Math.log(orPrecedent) + Math.log(orDrug);
  const pos = sigmoid(logOdds);
  return { attrition: 1 - pos, pos, terms: { br, orGenetic, orModality, orPrecedent, orDrug } };
}

export function computeAttrition(args: {
  report: Report;
  target: TargetAssoc | null;
  drugs: Drug[];
  diseaseName: string;
}): AttritionScore {
  const { report, target, drugs, diseaseName } = args;
  const area = areaOf(diseaseName);

  // base rate anchored on the most advanced selected drug's phase (no drug ->
  // de-novo / preclinical), which is what makes the score move with the drug.
  const lead = drugs.reduce<Drug | null>(
    (best, d) => (best == null || (d.max_phase ?? -1) > (best.max_phase ?? -1) ? d : best),
    null
  );
  const phase = phaseOf(lead?.max_phase);

  const assoc = clamp(target?.association ?? 0.3, 0, 1);
  const mod = clamp(report.modality.overall, 0, 1);
  const fail = clamp(cohortFailFraction(report), 0, 1); // legacy 0.5 default for empty

  const { attrition, pos, terms } = attritionMath({
    area,
    phase,
    association: target?.association ?? 0.3,
    modalityOverall: report.modality.overall,
    cohortFailFraction: cohortFailFraction(report),
    leadMaxPhase: lead?.max_phase ?? null,
  });
  const { br, orGenetic, orModality, orPrecedent, orDrug } = terms;

  const leadLabel = lead
    ? `${lead.name.toLowerCase()} (${phase === "filed" ? "approved" : PHASE_LABEL[phase]})`
    : "no lead compound → de-novo (preclinical)";

  const components: Component[] = [
    {
      label: `Base rate · ${AREA_LABEL[area]}, from ${PHASE_LABEL[phase]}`,
      kind: "base",
      value: br,
      input: leadLabel,
      citation: "Wong, Siah & Lo 2019; BIO/Informa success rates",
    },
    {
      label: `Genetic / target validation · association ${assoc.toFixed(2)}`,
      kind: "factor",
      value: orGenetic,
      input: `${target?.symbol ?? "target"}–disease, Open Targets`,
      citation: "Nelson et al. 2015, Nat Genet",
    },
    {
      label: `Modality feasibility · ${Math.round(mod * 100)}%`,
      kind: "factor",
      value: orModality,
      input: `${report.modality.modality} druggability`,
    },
    {
      label: `Reference-class precedent · ${Math.round(fail * 100)}% of analogues failed`,
      kind: "factor",
      value: orPrecedent,
      input: "historical cohort (this view's swimlanes)",
    },
    {
      label: `Drug track record`,
      kind: "factor",
      value: orDrug,
      input: lead ? `${lead.name.toLowerCase()} developability` : "no drug selected (neutral)",
    },
    { label: "Probability of success", kind: "result", value: pos, input: "= sigmoid(Σ log-odds)" },
  ];

  // dominant driver, for the plain-language line
  const factors = [
    { name: "the historical base rate at this stage", w: Math.abs(logit(br) - logit(0.1)) },
    { name: "prior failures at this target", w: Math.abs(Math.log(orPrecedent)) },
    { name: "target validation strength", w: Math.abs(Math.log(orGenetic)) },
    { name: "modality feasibility", w: Math.abs(Math.log(orModality)) },
  ].sort((a, b) => b.w - a.w);

  return { attrition, pos, components, drivenBy: factors[0].name };
}
