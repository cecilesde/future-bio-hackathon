"""Deterministic drug-repurposing evidence engine (no LLM).

Given an approved drug, this pulls structured evidence from Amass and aggregates
the DISTINCT indications the drug has been studied in, with objective evidence
per indication (how many trials, the furthest phase reached, how many completed,
whether any posted results, sample trial IDs). It also lists the drug's
regulatory-approved indications verbatim.

This layer asserts ONLY facts that come straight out of Amass records. It does
NOT decide "is this a novel repurposing opportunity" — that judgement is fuzzy
(matching free-text regulatory indications) and is left to the LLM layer in
agent.py, which reasons over the evidence this engine assembles.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict

from amass_client import AmassClient, MAX_LIMIT

# Trial "conditions" free-text is noisy. Drop these before aggregating.
_NOISE_CONDITION_PATTERNS = (
    "healthy volunteer", "healthy participant", "healthy subject", "healthy adult",
    "meddra version", "system organ class", "therapeutic area", "classification code",
)

# Rank clinical-trial phases so we can take a per-indication maximum.
_PHASE_RANK = {
    "EARLY_PHASE1": 0.5, "PHASE1": 1.0, "PHASE2": 2.0,
    "PHASE3": 3.0, "PHASE4": 4.0,
}


def _phase_rank(phase: str | None) -> float:
    """Map a phase string (incl. combined like 'PHASE1|PHASE2') to a numeric max."""
    if not phase:
        return 0.0
    best = 0.0
    for token in re.split(r"[^A-Za-z0-9_]+", phase.upper()):
        best = max(best, _PHASE_RANK.get(token, 0.0))
    return best


def _rank_to_phase(rank: float) -> str:
    if rank <= 0:
        return "NA"
    return {0.5: "EARLY_PHASE1", 1.0: "PHASE1", 2.0: "PHASE2",
            3.0: "PHASE3", 4.0: "PHASE4"}.get(rank, f"rank{rank}")


@dataclass
class IndicationEvidence:
    indication: str                 # display label (a MeSH term where possible)
    n_trials: int = 0
    max_phase: str = "NA"
    n_completed: int = 0            # trials with overallStatus COMPLETED
    n_with_results: int = 0         # trials where hasResults is true
    statuses: dict = field(default_factory=dict)   # status -> count
    sample_trials: list = field(default_factory=list)  # up to 8 nctIds
    _rank: float = 0.0              # internal: numeric max phase for sorting


@dataclass
class DrugEvidence:
    query_name: str
    resolved: bool
    canonical_name: str | None = None
    chembl_id: str | None = None
    drug_type: str | None = None
    description: str | None = None          # Amass summary incl. approved/investig. counts
    synonyms: list = field(default_factory=list)
    trade_names: list = field(default_factory=list)
    targets: list = field(default_factory=list)          # [{symbol, name, ensemblId, action}]
    approved_indications: list = field(default_factory=list)  # regulatory, verbatim
    indications: list = field(default_factory=list)       # list[IndicationEvidence-as-dict]
    n_trials_examined: int = 0
    coverage_note: str = ""                # honest note about the 300-cap / recall

    def to_json(self, **kw) -> str:
        return json.dumps(asdict(self), indent=2, **kw)


def _as_list(v) -> list:
    """Amass sometimes returns JSON-encoded strings for list fields; normalize."""
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("[") and s.endswith("]"):
            try:
                parsed = json.loads(s)
                return parsed if isinstance(parsed, list) else [v]
            except json.JSONDecodeError:
                return [v]
        return [v]
    return [v]


def _is_noise_condition(cond: str, drug_terms: set[str]) -> bool:
    c = cond.strip().lower()
    if not c or len(c) < 3:
        return True
    if c in drug_terms:                     # the drug name itself listed as a condition
        return True
    return any(p in c for p in _NOISE_CONDITION_PATTERNS)


def _conditions_of(trial: dict) -> list[str]:
    """Prefer MeSH-normalized terms; fall back to raw conditions when absent."""
    mesh = trial.get("conditionMeshTerms") or []
    if mesh:
        return mesh
    return trial.get("conditions") or []


def resolve_drug(client: AmassClient, name: str) -> dict | None:
    """Best DrugCore match for a drug name (top ranked hit)."""
    hits = client.search("drugcore", name, limit=5)
    return hits[0] if hits else None


def _dedupe_ci(terms) -> list[str]:
    seen, out = set(), []
    for t in terms:
        k = (t or "").strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(t.strip())
    return out


def _drug_query_terms(name: str, drug_rec: dict | None) -> list[str]:
    """TrialCore query strings: the drug name + its real trade names ONLY.

    Trade names matter (Ozempic/Wegovy/Rybelsus) because trials register under a
    brand. We deliberately EXCLUDE research-code synonyms (e.g. 'HIP-0908',
    'UK-92480' for sildenafil): as full-text queries they collide with unrelated
    trials ('HIP-0908' -> hip-arthroplasty studies), poisoning recall. Precision
    is then guaranteed downstream by the intervention filter, not by the query.
    """
    terms = [name]
    if drug_rec:
        if drug_rec.get("name"):
            terms.append(drug_rec["name"])
        for t in _as_list(drug_rec.get("tradeNames")):
            if "component of" not in t.lower():
                terms.append(t)
    return _dedupe_ci(terms)


def _drug_identifiers(name: str, drug_rec: dict | None) -> list[str]:
    """Lowercased tokens used to confirm the drug IS a trial's intervention.

    Broader than the query terms (includes synonyms/codes) because here we match
    against a trial's intervention fields, where a code like 'HIP-0908' will NOT
    spuriously match orthopedic text. Short tokens are dropped to avoid substring
    false hits.
    """
    ids = [name]
    if drug_rec:
        ids.append(drug_rec.get("name"))
        for t in _as_list(drug_rec.get("tradeNames")):
            if "component of" not in t.lower():
                ids.append(t)
        ids.extend(_as_list(drug_rec.get("synonyms")))
    return [t.lower() for t in _dedupe_ci(ids) if len(t.strip()) >= 4]


def _drug_is_intervention(trial: dict, identifiers: list[str]) -> bool:
    """True iff one of the drug's identifiers appears in the trial's intervention
    fields. This is what separates a trial that TESTS the drug from one that only
    mentions it (exclusion criteria, concomitant meds) or a code collision."""
    haystack = " ".join(
        str(x).lower() for x in (
            (trial.get("interventionNames") or [])
            + (trial.get("interventionMeshTerms") or [])
        )
    )
    if not haystack:
        return False
    return any(idn in haystack for idn in identifiers)


def get_approved_indications(client: AmassClient, name: str,
                             drug_rec: dict | None) -> tuple[list[dict], list[str]]:
    """Regulatory authorizations (FDA/EMA) for the drug's active substance.

    Returns (records, brand_names). brand_names are distinct trade names (those
    that don't already contain the INN, e.g. 'Viagra' not 'Sildenafil Teva'),
    used to widen trial recall and intervention matching."""
    substances = {name.lower()}
    if drug_rec and drug_rec.get("name"):
        substances.add(drug_rec["name"].lower())
    out, brands = [], []
    for rec in client.search("regulatorycore", name, limit=25):
        active = (rec.get("activeSubstance") or "").lower()
        # keep only records whose active substance actually matches the drug
        if active and not any(s in active or active in s for s in substances):
            continue
        indication = rec.get("therapeuticIndication") or ""
        brand = rec.get("name")
        if brand and not any(s in brand.lower() for s in substances):
            brands.append(brand)  # distinct brand (Viagra), not "Sildenafil Teva"
        out.append({
            "agency": rec.get("agency"),
            "brand_name": brand,
            "authorization_status": rec.get("authorizationStatus"),
            "is_orphan": rec.get("isOrphan"),
            "first_authorization_date": rec.get("firstAuthorizationDate"),
            # therapeuticIndication is long free text; keep a trimmed excerpt verbatim
            "therapeutic_indication_excerpt": indication[:500],
        })
    return out, _dedupe_ci(brands)


def aggregate_indications(trials: list[dict], drug_terms: set[str]) -> list[IndicationEvidence]:
    """Collapse trials into distinct indications with objective per-indication evidence."""
    by_key: dict[str, IndicationEvidence] = {}
    for tr in trials:
        rank = _phase_rank(tr.get("phase"))
        status = tr.get("overallStatus") or "UNKNOWN"
        has_results = bool(tr.get("hasResults"))
        nct = tr.get("nctId")
        for cond in _conditions_of(tr):
            if _is_noise_condition(cond, drug_terms):
                continue
            key = cond.strip().lower()
            ev = by_key.get(key)
            if ev is None:
                ev = IndicationEvidence(indication=cond.strip())
                by_key[key] = ev
            ev.n_trials += 1
            ev._rank = max(ev._rank, rank)
            ev.max_phase = _rank_to_phase(ev._rank)
            ev.statuses[status] = ev.statuses.get(status, 0) + 1
            if status == "COMPLETED":
                ev.n_completed += 1
            if has_results:
                ev.n_with_results += 1
            if nct and nct not in ev.sample_trials and len(ev.sample_trials) < 8:
                ev.sample_trials.append(nct)
    # sort by furthest phase, then trial count
    return sorted(by_key.values(), key=lambda e: (e._rank, e.n_trials), reverse=True)


def build_drug_evidence(client: AmassClient, name: str) -> DrugEvidence:
    """Top-level: assemble the full deterministic repurposing evidence bundle."""
    drug_rec = resolve_drug(client, name)
    ev = DrugEvidence(query_name=name, resolved=drug_rec is not None)

    if drug_rec:
        ev.canonical_name = drug_rec.get("name")
        ev.chembl_id = drug_rec.get("chemblId")
        ev.drug_type = drug_rec.get("drugType")
        ev.description = drug_rec.get("description")
        ev.synonyms = _as_list(drug_rec.get("synonyms"))
        ev.trade_names = _as_list(drug_rec.get("tradeNames"))
        for moa in _as_list(drug_rec.get("mechanismsOfAction")):
            if not isinstance(moa, dict):
                continue
            for tgt in moa.get("targets", []) or []:
                ev.targets.append({
                    "symbol": tgt.get("symbol"),
                    "name": tgt.get("name"),
                    "ensemblId": tgt.get("ensemblId"),
                    "action": moa.get("actionType"),
                    "mechanism": moa.get("mechanismOfAction"),
                })

    # Fetch regulatory first: its brand names widen trial recall (Viagra/Revatio
    # are absent from DrugCore.tradeNames but present as regulatory brands).
    ev.approved_indications, brands = get_approved_indications(client, name, drug_rec)

    query_terms = _dedupe_ci(_drug_query_terms(name, drug_rec) + brands)
    raw_trials = client.search_union("trialcore", query_terms, limit=MAX_LIMIT)

    # Precision gate: keep only trials where the drug is an actual intervention,
    # not merely mentioned (exclusion criteria) or matched via a colliding code.
    identifiers = _dedupe_ci(_drug_identifiers(name, drug_rec) + [b.lower() for b in brands])
    trials = [t for t in raw_trials if _drug_is_intervention(t, identifiers)]
    n_dropped = len(raw_trials) - len(trials)
    ev.n_trials_examined = len(trials)

    drug_terms = {t.lower() for t in query_terms}
    indications = aggregate_indications(trials, drug_terms)
    ev.indications = [
        {k: v for k, v in asdict(i).items() if not k.startswith("_")}
        for i in indications
    ]

    ev.coverage_note = (
        f"Unioned {len(query_terms)} query terms (name + trade names); "
        f"{len(raw_trials)} trials retrieved, {n_dropped} dropped by the intervention "
        f"filter (drug only mentioned, not tested), {len(trials)} retained. Amass caps "
        f"each query at {MAX_LIMIT} results with no pagination, so very prolific drugs "
        f"may have long-tail indications not surfaced here."
    )
    return ev
