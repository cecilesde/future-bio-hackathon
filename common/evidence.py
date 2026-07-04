"""Trial evidence per (drug, disease) — for the UI's evidence fields ONLY.

This is NOT model input (that would leak trial history into zero-trial inference).
It answers "what trial evidence exists" so the UI can show n_trials, furthest phase,
and real NCT ids for a suggested pair, and so we can set evidence_tier.

Precision filter: a trial counts for a drug only if the drug (or a synonym) appears
in interventionNames / interventionMeshTerms — not merely mentioned in the record.
Trial conditions are mapped to canonical diseases via common.normalize.best_match.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from common.normalize import best_match

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"

_PHASE_RANK = {"EARLY_PHASE1": 0.5, "PHASE1": 1.0, "PHASE2": 2.0, "PHASE3": 3.0, "PHASE4": 4.0}
_RANK_PHASE = {0.5: "EARLY_PHASE1", 1.0: "PHASE1", 2.0: "PHASE2", 3.0: "PHASE3", 4.0: "PHASE4"}


def _phase_rank(phase: str | None) -> float:
    if not phase:
        return 0.0
    best = 0.0
    for tok in re.split(r"[^A-Za-z0-9_]+", phase.upper()):
        best = max(best, _PHASE_RANK.get(tok, 0.0))
    return best


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])


class EvidenceIndex:
    """(drug, disease) -> {n_trials, furthest_phase, supporting_trials}."""

    def __init__(self, drugcore: dict | None = None):
        self.drugcore = drugcore or json.loads((CACHE / "drugcore.json").read_text())
        self._cache: dict[str, dict] = {}

    def _drug_terms(self, drug: str) -> set[str]:
        terms = {drug.lower()}
        rec = self.drugcore.get(drug)
        if rec:
            if rec.get("name"):
                terms.add(rec["name"].lower())
            for s in _as_list(rec.get("synonyms")):
                terms.add(str(s).lower())
            for t in _as_list(rec.get("tradeNames")):
                terms.add(str(t).lower())
        return {t for t in terms if len(t) >= 4}

    def _index_drug(self, drug: str) -> dict:
        """disease -> aggregated evidence for this drug (built once, cached)."""
        if drug in self._cache:
            return self._cache[drug]
        f = CACHE / "trials" / f"{_slug(drug)}.json"
        by_disease: dict[str, dict] = {}
        if f.exists():
            terms = self._drug_terms(drug)
            for tr in json.loads(f.read_text()):
                iv = " ".join(str(x).lower() for x in
                              (_as_list(tr.get("interventionNames"))
                               + _as_list(tr.get("interventionMeshTerms"))))
                if not any(t in iv for t in terms):
                    continue  # drug not an intervention -> skip (precision)
                conds = _as_list(tr.get("conditionMeshTerms")) or _as_list(tr.get("conditions"))
                mapped = {best_match(c) for c in conds}
                mapped.discard(None)
                rank = _phase_rank(tr.get("phase"))
                nct = tr.get("nctId")
                for dis in mapped:
                    e = by_disease.setdefault(dis, {"n": 0, "rank": 0.0, "ncts": []})
                    e["n"] += 1
                    e["rank"] = max(e["rank"], rank)
                    if nct:
                        e["ncts"].append((rank, nct))
        self._cache[drug] = by_disease
        return by_disease

    def get(self, drug: str, disease: str) -> dict:
        e = self._index_drug(drug).get(disease)
        if not e:
            return {"n_trials": 0, "furthest_phase": "NA", "supporting_trials": []}
        ncts = [n for _, n in sorted(e["ncts"], reverse=True)][:5]
        return {
            "n_trials": e["n"],
            "furthest_phase": _RANK_PHASE.get(e["rank"], "NA"),
            "supporting_trials": ncts,
        }
