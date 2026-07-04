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

// The reference-class cohort for a target: every drug / clinical candidate that
// acts on it, with its trial reports (phase, status, why-stopped). Live, AMASS-free.
export async function cohortCandidates(ensemblId: string): Promise<CohortCandidate[]> {
  const q = `query($t:String!){
    target(ensemblId:$t){
      drugAndClinicalCandidates{
        rows{
          maxClinicalStage
          drug{ id name drugType maximumClinicalStage }
          diseases{ disease{ id name } }
          clinicalReports{ trialPhase trialOverallStatus trialWhyStopped trialStopReasonCategories trialStartDate year title url }
        }
      }
    }
  }`;
  const d = await post<{
    target: {
      drugAndClinicalCandidates: {
        rows: {
          maxClinicalStage: string | null;
          drug: { id: string; name: string; drugType: string | null; maximumClinicalStage: string | null } | null;
          diseases: ({ disease: { id: string; name: string } | null } | null)[] | null;
          clinicalReports: {
            trialPhase: string | null;
            trialOverallStatus: string | null;
            trialWhyStopped: string | null;
            trialStopReasonCategories: string[] | null;
            trialStartDate: string | null;
            year: number | null;
            title: string | null;
            url: string | null;
          }[] | null;
        }[];
      } | null;
    } | null;
  }>(q, { t: ensemblId });

  const rows = d.target?.drugAndClinicalCandidates?.rows ?? [];
  return rows
    .filter((r) => r.drug)
    .map((r) => {
      const diseases = [
        ...new Set(
          (r.diseases ?? [])
            .map((x) => x?.disease?.name)
            .filter((n): n is string => !!n)
        ),
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
