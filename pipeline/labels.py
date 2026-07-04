"""Stage 2 — build positive (drug, disease) approval labels from regulatorycore.

Positives only (this is positive-unlabeled learning): a label means "this drug is
regulatory-approved (FDA or EMA) for this canonical disease", with the earliest
authorization date (for the retrospective time-split).

Two precision filters are essential (full-text search is noisy):
  1. activeSubstance filter: keep only regulatory records whose activeSubstance
     actually matches the drug. Verified necessary: a "dapagliflozin" query returns
     96 records but only 9 are dapagliflozin; the rest merely mention it.
  2. indication extraction: EMA therapeuticIndication is clean prose that usually
     opens with the disease name; FDA's field is often the label DESCRIPTION
     section (chemistry), so it yields a disease only when one is named. We take
     every canonical disease found in the text (match_in_text), unioned across a
     drug's approval records.

Output: data/artifacts/labels.json — list of {drug, disease, agencies, first_date}.
"""

from __future__ import annotations

import json
from pathlib import Path

from common.normalize import match_in_text

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
ART = ROOT / "data" / "artifacts"


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def _substance_terms(name: str, drug_rec: dict | None) -> set[str]:
    terms = {name.lower()}
    if drug_rec:
        if drug_rec.get("name"):
            terms.add(drug_rec["name"].lower())
        for s in _as_list(drug_rec.get("synonyms")):
            terms.add(str(s).lower())
    return {t for t in terms if len(t) >= 4}


def _substance_matches(active: str, terms: set[str]) -> bool:
    a = (active or "").lower()
    if not a:
        return False
    return any(t in a or a in t for t in terms)


def _extract_indication(rec: dict) -> list[str]:
    """Canonical disease(s) this authorization is FOR.

    EMA therapeuticIndication is clean prose (usually opens with the disease) -> use
    the whole field. FDA's field is often the label DESCRIPTION section (chemistry),
    where incidental disease mentions (e.g. "in diabetic patients") cause false
    positives -> only trust it after an explicit indication cue ("indicated for ...").
    """
    text = rec.get("therapeuticIndication") or ""
    if not text:
        return []
    if rec.get("agency") == "EMA":
        # clean prose; disease(s) named up front. But cut off comorbidity /
        # risk-population clauses first: "...weight-related comorbidity (e.g.
        # hypertension, type 2 diabetes...)" lists OTHER diseases that are not
        # the indication. Truncate at the first such cue.
        low = text.lower()
        cut = len(text)
        for cue in ("comorbidit", "in the presence of", "risk factor",
                    "who are at", "with an increased risk", "risk of major"):
            i = low.find(cue)
            if i != -1:
                cut = min(cut, i)
        return match_in_text(text[:cut])
    # FDA: the field is unreliable (label DESCRIPTION section; risk-population
    # mentions cause false positives). Trust it only right after an explicit
    # "for the treatment of" cue, and take just the PRIMARY (first) disease in a
    # short window. This favours precision over recall for FDA-only drugs.
    low = text.lower()
    cue = -1
    for marker in ("for the treatment of", "to reduce the risk of",
                   "for the prevention of", "indicated for the"):
        i = low.find(marker)
        if i != -1 and (cue == -1 or i < cue):
            cue = i
    if cue == -1:
        return []
    hits = match_in_text(text[cue: cue + 90])
    return hits[:1]  # primary indication only, to avoid trailing risk-group mentions


def build_labels() -> list[dict]:
    drugcore = json.loads((CACHE / "drugcore.json").read_text())
    reg_dir = CACHE / "regulatory"
    seed_drugs = json.loads((ROOT / "data" / "seed" / "drugs.json").read_text())

    # (drug, disease) -> {agencies:set, first_date:str|None}
    pairs: dict[tuple[str, str], dict] = {}
    stats = {"drugs_with_reg": 0, "reg_kept": 0, "reg_dropped_substance": 0,
             "reg_no_disease": 0}

    for name in seed_drugs:
        rec = drugcore.get(name)
        slug = _slug(name)
        f = reg_dir / f"{slug}.json"
        if not f.exists():
            continue
        stats["drugs_with_reg"] += 1
        terms = _substance_terms(name, rec)
        for r in json.loads(f.read_text()):
            if not _substance_matches(r.get("activeSubstance", ""), terms):
                stats["reg_dropped_substance"] += 1
                continue
            diseases = _extract_indication(r)
            if not diseases:
                stats["reg_no_disease"] += 1
                continue
            stats["reg_kept"] += 1
            agency = r.get("agency")
            date = r.get("firstAuthorizationDate") or r.get("authorizationDate")
            for dis in diseases:
                key = (name, dis)
                cur = pairs.setdefault(key, {"agencies": set(), "first_date": None})
                if agency:
                    cur["agencies"].add(agency)
                if date and (cur["first_date"] is None or date < cur["first_date"]):
                    cur["first_date"] = date

    labels = [
        {"drug": d, "disease": dis, "agencies": sorted(v["agencies"]),
         "first_date": v["first_date"]}
        for (d, dis), v in sorted(pairs.items())
    ]
    ART.mkdir(parents=True, exist_ok=True)
    (ART / "labels.json").write_text(json.dumps(labels, indent=1))
    print(f"labels: {len(labels)} positive (drug,disease) pairs across "
          f"{len({l['drug'] for l in labels})} drugs, "
          f"{len({l['disease'] for l in labels})} diseases")
    print(f"stats: {stats}")
    return labels


def _slug(name: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


if __name__ == "__main__":
    labels = build_labels()
    from collections import Counter
    print("\nmost-approved diseases:")
    for dis, n in Counter(l["disease"] for l in labels).most_common(12):
        print(f"  {n:3}  {dis}")
    print("\nsample labels:")
    for l in labels[:15]:
        print(f"  {l['drug']:22} -> {l['disease']:34} {l['agencies']} {l['first_date']}")
