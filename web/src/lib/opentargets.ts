// Open Targets Platform client (server-side, live, no API key).
//
// This is the TS port of pipeline/opentargets.py, plus the cohort source used by
// the live forecast: `drugAndClinicalCandidates` (the drugs/candidates that hit a
// target, with their trial reports). This is the AMASS-free reference-class
// source — it needs no AMASS credits.

const API = "https://api.platform.opentargets.org/api/v4/graphql";

const DATATYPE_LABELS: Record<string, string> = {
  genetic_association: "Genetic association",
  genetic_literature: "Genetic (literature)",
  somatic_mutation: "Somatic mutation",
  known_drug: "Drugs (approved/clinical)",
  affected_pathway: "Pathways",
  literature: "Literature",
  rna_expression: "Expression",
  animal_model: "Animal models",
  clinical: "Clinical",
};

async function post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Open Targets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (body.errors) throw new Error(`Open Targets GraphQL: ${JSON.stringify(body.errors).slice(0, 300)}`);
  return body.data as T;
}

export interface ResolvedEntity {
  id: string;
  name: string;
}

// Resolve a disease name -> EFO/MONDO entity (preferring ontology ids over HP).
export async function resolveDisease(name: string): Promise<ResolvedEntity | null> {
  const q = `query($q:String!){ search(queryString:$q,entityNames:["disease"],page:{index:0,size:5}){ hits{ id name entity } } }`;
  const d = await post<{ search: { hits: { id: string; name: string }[] } }>(q, { q: name });
  const hits = d.search.hits;
  if (!hits.length) return null;
  const onto = hits.find((h) => /^(MONDO|EFO)/.test(h.id));
  return onto ?? hits[0];
}

// Resolve a gene symbol -> Open Targets target (Ensembl id + approved symbol).
export async function resolveTarget(symbol: string): Promise<ResolvedEntity | null> {
  const q = `query($s:String!){ search(queryString:$s,entityNames:["target"],page:{index:0,size:5}){ hits{ id name entity } } }`;
  const d = await post<{ search: { hits: { id: string; name: string }[] } }>(q, { s: symbol });
  return d.search.hits[0] ?? null;
}

export interface Association {
  association: number; // 0-1 overall
  evidence: string[]; // friendly datatype labels, strongest first
  datatypeScores: Record<string, number>;
  found: boolean; // false => no OT association row; caller falls back to a neutral prior
}

function evidenceFrom(dts: Record<string, number>): string[] {
  return Object.entries(dts)
    .sort((a, b) => b[1] - a[1])
    .filter(([, v]) => v >= 0.1)
    .slice(0, 4)
    .map(([k]) => DATATYPE_LABELS[k] ?? k.replace(/_/g, " "));
}

// Overall association score for a (target, disease) pair. Tries the disease's
// associatedTargets first, then the target's associatedDiseases; returns found=false
// if neither lists the pair (the pair may still be biologically plausible, so the
// caller uses a neutral prior rather than zero).
export async function associationFor(ensemblId: string, efoId: string): Promise<Association> {
  const neutral: Association = { association: 0, evidence: [], datatypeScores: {}, found: false };
  const q = `query($t:String!){ target(ensemblId:$t){ associatedDiseases(page:{index:0,size:50}){ rows{ score disease{ id } datatypeScores{ id score } } } } }`;
  try {
    const d = await post<{
      target: { associatedDiseases: { rows: { score: number; disease: { id: string }; datatypeScores: { id: string; score: number }[] }[] } } | null;
    }>(q, { t: ensemblId });
    const rows = d.target?.associatedDiseases?.rows ?? [];
    const row = rows.find((r) => r.disease.id === efoId);
    if (!row) return neutral;
    const dts: Record<string, number> = {};
    for (const x of row.datatypeScores) dts[x.id] = Math.round(x.score * 1000) / 1000;
    return { association: Math.round(row.score * 1000) / 1000, evidence: evidenceFrom(dts), datatypeScores: dts, found: true };
  } catch {
    return neutral;
  }
}

export interface CohortReport {
  phase: string | null;
  status: string | null; // e.g. TERMINATED, COMPLETED, RECRUITING
  whyStopped: string | null;
  stopReasonCategories: string[];
  startDate: string | null;
  year: number | null;
  title: string | null;
  url: string | null;
  nctId: string | null; // parsed from the url (NCT\d+)
}

const NCT_RE = /NCT\d{8}/i;
function nctFrom(url: string | null | undefined, title: string | null | undefined): string | null {
  const m = (url ?? "").match(NCT_RE) ?? (title ?? "").match(NCT_RE);
  return m ? m[0].toUpperCase() : null;
}
export interface CohortCandidate {
  drugId: string;
  drugName: string;
  drugType: string | null; // Small molecule, Antibody, ...
  maxStage: string | null; // PHASE_3, PHASE_1, ...
  diseases: string[];
  reports: CohortReport[];
}

// Shared shape of one drugAndClinicalCandidates row (identical on target and
// disease queries) + its mapper into CohortCandidate.
interface CandidateRow {
  maxClinicalStage: string | null;
  drug: { id: string; name: string; drugType: string | null; maximumClinicalStage: string | null } | null;
  diseases?: ({ disease: { id: string; name: string } | null } | null)[] | null; // present on target rows only
  clinicalReports:
    | {
        trialPhase: string | null;
        trialOverallStatus: string | null;
        trialWhyStopped: string | null;
        trialStopReasonCategories: string[] | null;
        trialStartDate: string | null;
        year: number | null;
        title: string | null;
        url: string | null;
      }[]
    | null;
}

const REPORTS_SEL = `clinicalReports{ trialPhase trialOverallStatus trialWhyStopped trialStopReasonCategories trialStartDate year title url }`;
// The target row exposes `diseases` (the drug's indications); the disease row does
// NOT (querying it there is a GraphQL error). Two selections, one mapper.
const TARGET_ROWS = `rows{ maxClinicalStage drug{ id name drugType maximumClinicalStage } diseases{ disease{ id name } } ${REPORTS_SEL} }`;
const DISEASE_ROWS = `rows{ maxClinicalStage drug{ id name drugType maximumClinicalStage } ${REPORTS_SEL} }`;

function mapCandidateRows(rows: CandidateRow[]): CohortCandidate[] {
  return rows
    .filter((r) => r.drug)
    .map((r) => {
      const diseases = [
        ...new Set((r.diseases ?? []).map((x) => x?.disease?.name).filter((n): n is string => !!n)),
      ];
      const reports = (r.clinicalReports ?? [])
        .filter((rep) => rep.trialOverallStatus || rep.trialPhase || rep.trialWhyStopped || rep.trialStartDate)
        .map((rep) => ({
          phase: rep.trialPhase,
          status: rep.trialOverallStatus,
          whyStopped: rep.trialWhyStopped,
          stopReasonCategories: (rep.trialStopReasonCategories ?? []).filter((c): c is string => !!c),
          startDate: rep.trialStartDate,
          year: rep.year,
          title: rep.title,
          url: rep.url,
          nctId: nctFrom(rep.url, rep.title),
        }));
      return {
        drugId: r.drug!.id,
        drugName: r.drug!.name,
        drugType: r.drug!.drugType,
        maxStage: r.maxClinicalStage ?? r.drug!.maximumClinicalStage,
        diseases,
        reports,
      };
    });
}

// The reference-class cohort for a target: every drug / clinical candidate that
// acts on it, with its trial reports (phase, status, why-stopped). Live, AMASS-free.
export async function cohortCandidates(ensemblId: string): Promise<CohortCandidate[]> {
  const q = `query($t:String!){ target(ensemblId:$t){ drugAndClinicalCandidates{ ${TARGET_ROWS} } } }`;
  const d = await post<{ target: { drugAndClinicalCandidates: { rows: CandidateRow[] } | null } | null }>(q, { t: ensemblId });
  return mapCandidateRows(d.target?.drugAndClinicalCandidates?.rows ?? []);
}

// The reference-class cohort for a DISEASE: every drug / clinical candidate in
// development or approved for it. Same shape as cohortCandidates (target-free).
export async function diseaseCohortCandidates(efoId: string): Promise<CohortCandidate[]> {
  const q = `query($e:String!){ disease(efoId:$e){ drugAndClinicalCandidates{ ${DISEASE_ROWS} } } }`;
  const d = await post<{ disease: { drugAndClinicalCandidates: { rows: CandidateRow[] } | null } | null }>(q, { e: efoId });
  return mapCandidateRows(d.disease?.drugAndClinicalCandidates?.rows ?? []);
}

// ---- drug -> targets (mechanism-of-action context, target-free lens) ----
// A drug's mechanism-of-action targets, by HGNC symbol. Verified: aspirin
// (CHEMBL25) -> PTGS1, PTGS2. Returns [] on error / unknown drug.
export async function drugTargets(chemblId: string): Promise<string[]> {
  const q = `query($id:String!){ drug(chemblId:$id){ mechanismsOfAction{ rows{ targets{ approvedSymbol } } } } }`;
  try {
    const d = await post<{
      drug: { mechanismsOfAction: { rows: { targets: { approvedSymbol: string | null }[] | null }[] } | null } | null;
    }>(q, { id: chemblId });
    const rows = d.drug?.mechanismsOfAction?.rows ?? [];
    const syms = new Set<string>();
    for (const r of rows) for (const t of r.targets ?? []) if (t.approvedSymbol) syms.add(t.approvedSymbol.toUpperCase());
    return [...syms];
  } catch {
    return [];
  }
}

// ---- disease -> drugs (structured backbone for drug discovery) ----
export interface DiseaseDrugRow {
  name: string;
  chemblId: string | null;
  drugType: string | null;
  maxClinicalStage: string | null;
}
export async function diseaseDrugCandidates(efoId: string): Promise<DiseaseDrugRow[]> {
  const q = `query($e:String!){
    disease(efoId:$e){ drugAndClinicalCandidates{ rows{ maxClinicalStage drug{ id name drugType maximumClinicalStage } } } }
  }`;
  try {
    const d = await post<{
      disease: {
        drugAndClinicalCandidates: {
          rows: {
            maxClinicalStage: string | null;
            drug: { id: string; name: string; drugType: string | null; maximumClinicalStage: string | null } | null;
          }[];
        } | null;
      } | null;
    }>(q, { e: efoId });
    const rows = d.disease?.drugAndClinicalCandidates?.rows ?? [];
    const seen = new Set<string>();
    const out: DiseaseDrugRow[] = [];
    for (const r of rows) {
      if (!r.drug || seen.has(r.drug.id)) continue;
      seen.add(r.drug.id);
      out.push({
        name: r.drug.name,
        chemblId: r.drug.id,
        drugType: r.drug.drugType,
        maxClinicalStage: r.maxClinicalStage ?? r.drug.maximumClinicalStage,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---- approval-per-indication (for the "already approved => 0% attrition" rule) ----
// The OT indication stage string for an approved indication is the literal
// "APPROVAL" (NOT "PHASE_4"). Returns the set of EFO/MONDO ids the drug is
// APPROVED for. [] on error / unknown drug.
export async function drugApprovalIndications(chemblId: string): Promise<string[]> {
  const q = `query($id:String!){ drug(chemblId:$id){ indications{ rows{ maxClinicalStage disease{ id } } } } }`;
  try {
    const d = await post<{
      drug: { indications: { rows: { maxClinicalStage: string | null; disease: { id: string } | null }[] } | null } | null;
    }>(q, { id: chemblId });
    const rows = d.drug?.indications?.rows ?? [];
    const ids = new Set<string>();
    for (const r of rows) if (r.maxClinicalStage === "APPROVAL" && r.disease?.id) ids.add(r.disease.id);
    return [...ids];
  } catch {
    return [];
  }
}

// Descendant EFO/MONDO ids of a disease (subtypes). Used so a drug approved for a
// subtype (e.g. major depressive disorder) counts as approved for a broader query
// (depression). [] on error / leaf disease.
// Ids that count as "the same disease as efoId" for an approval match: the
// disease's subtypes (descendants) PLUS its cross-ontology equivalents (dbXRefs).
// The latter matters because the disease search resolves a name to one ontology
// node (usually MONDO/EFO) while a drug's approval indication is often filed under
// a DIFFERENT ontology node for the same concept. Example: "Obesity" resolves to
// MONDO_0011122 ("obesity disorder"), but semaglutide's obesity APPROVAL is filed
// under HP_0001513 ("Obesity"); MONDO_0011122.dbXRefs includes HP:0001513, so
// including the normalized xrefs bridges the two. dbXRefs use "PREFIX:id"; OT ids
// use "PREFIX_id", so normalize the first colon to an underscore.
export async function diseaseDescendants(efoId: string): Promise<string[]> {
  const q = `query($e:String!){ disease(efoId:$e){ descendants dbXRefs } }`;
  try {
    const d = await post<{ disease: { descendants: string[] | null; dbXRefs: string[] | null } | null }>(q, { e: efoId });
    const descendants = d.disease?.descendants ?? [];
    const xrefs = (d.disease?.dbXRefs ?? []).map((x) => x.replace(":", "_"));
    return [...new Set([...descendants, ...xrefs])];
  } catch {
    return [];
  }
}

// True if the drug is approved for the queried disease OR one of its subtypes /
// cross-ontology equivalents (see diseaseDescendants). Ancestor approvals do NOT
// count (approval for a broad parent does not imply approval for a narrow subtype).
export function isApprovedForIndication(approvedIds: string[], efoId: string, related: string[]): boolean {
  if (!approvedIds.length || !efoId) return false;
  const targetSet = new Set([efoId, ...related]);
  return approvedIds.some((id) => targetSet.has(id));
}
