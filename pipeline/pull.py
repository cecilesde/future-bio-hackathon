"""Stage 1 — pull raw Amass records for the seed vocabulary.

Scope (locked): the candidate grid is the UI's bundled vocabulary — 493 drugs and
207 diseases (data/seed/*.json). Pulling only what those entities need keeps the
grid at ~102k pairs with no truncation and guarantees every UI-selectable entity
has data.

What we pull, and why (all feature families are downstream of these):
  - drugcore   : resolve each seed drug -> targets, SMILES, drugType, stage.
  - regulatorycore : approvals per drug -> the LABELS (approved indication + date).
  - trialcore  : trials per drug -> evidence fields (n_trials, phase, NCT ids) and
                 the drug->disease-studied edges used for transfer features.
  - genecore   : each drug target -> tractability / constraint / safety priors.

Design notes:
  - Resumable + cheap I/O: trials and regulatory records are stored ONE FILE PER
    DRUG (data/cache/trials/<slug>.json), trimmed to needed fields, so a rerun skips
    cached drugs and we never rewrite a giant blob. drugcore/genes are small single
    JSONs. Amass is rate-limited (60/min); a full pull takes ~1h — never restart
    from zero on a transient error.
  - Records are TRIMMED at pull time: trials drop outcome-measure / arm-group text,
    regulatory drops documentSections. This cuts cache size ~5-10x.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv

from amass.client import AmassClient, MAX_LIMIT

ROOT = Path(__file__).resolve().parent.parent
SEED_DIR = ROOT / "data" / "seed"
CACHE_DIR = ROOT / "data" / "cache"

# fields we keep per record (everything else is dropped to shrink the cache)
_TRIAL_KEEP = (
    "nctId", "phase", "overallStatus", "hasResults", "startDate", "completionDate",
    "conditions", "conditionMeshTerms", "interventionNames", "interventionMeshTerms",
    "briefTitle", "sponsorName", "enrollment",
)
_REG_KEEP = (
    "agency", "name", "activeSubstance", "moleculeType", "authorizationStatus",
    "procedureType", "therapeuticIndication", "authorizationDate",
    "firstAuthorizationDate", "isOrphan", "designations",
)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _load_seed() -> tuple[list[str], list[str]]:
    drugs = json.loads((SEED_DIR / "drugs.json").read_text())
    diseases = json.loads((SEED_DIR / "diseases.json").read_text())
    return drugs, diseases


def _load_json(p: Path) -> dict | list | None:
    return json.loads(p.read_text()) if p.exists() else None


def _save_json(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(p)


def _trim(rec: dict, keep: tuple[str, ...]) -> dict:
    return {k: rec.get(k) for k in keep if k in rec}


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


def _drug_query_terms(name: str, drug_rec: dict | None) -> list[str]:
    """name + trade names (brands register trials/approvals) + a couple of synonyms."""
    terms = [name]
    if drug_rec:
        if drug_rec.get("name"):
            terms.append(drug_rec["name"])
        for t in _as_list(drug_rec.get("tradeNames")):
            if "component of" not in str(t).lower():
                terms.append(t)
        for s in _as_list(drug_rec.get("synonyms"))[:2]:
            terms.append(s)
    seen, out = set(), []
    for t in terms:
        k = str(t).strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(str(t).strip())
    return out[:4]  # cap union width to bound API calls per drug


def pull(save_every: int = 10) -> None:
    load_dotenv(ROOT / ".env")
    client = AmassClient(timeout=60.0)  # trial queries return up to 300 rows; be patient
    drugs, _diseases = _load_seed()

    limit = os.environ.get("AMASS_PULL_LIMIT")
    if limit:  # smoke-test knob: pull only the first N drugs
        drugs = drugs[: int(limit)]

    drug_dir = CACHE_DIR / "drugcore.json"           # single small file: name -> record
    reg_dir = CACHE_DIR / "regulatory"               # per-drug files
    trial_dir = CACHE_DIR / "trials"                 # per-drug files
    reg_dir.mkdir(parents=True, exist_ok=True)
    trial_dir.mkdir(parents=True, exist_ok=True)

    drugcore: dict = _load_json(drug_dir) or {}      # seed_name -> resolved record

    print(f"Pulling for {len(drugs)} seed drugs (drugcore cached: {len(drugcore)})")

    for i, name in enumerate(drugs):
        slug = _slug(name)
        reg_f, trial_f = reg_dir / f"{slug}.json", trial_dir / f"{slug}.json"
        need_drug = name not in drugcore
        need_reg, need_trial = not reg_f.exists(), not trial_f.exists()
        if not (need_drug or need_reg or need_trial):
            continue
        try:
            if need_drug:
                hits = client.search("drugcore", name, limit=5)
                drugcore[name] = hits[0] if hits else None
            rec = drugcore.get(name)
            terms = _drug_query_terms(name, rec)

            if need_reg:
                reg = client.search_union("regulatorycore", terms, limit=50)
                _save_json(reg_f, [_trim(r, _REG_KEEP) for r in reg])
            if need_trial:
                tr = client.search_union("trialcore", terms, limit=MAX_LIMIT)
                _save_json(trial_f, [_trim(t, _TRIAL_KEEP) for t in tr])
        except Exception as e:  # never lose progress on a transient failure
            print(f"  ! {name}: {e}")
            _save_json(drug_dir, drugcore)
            continue

        if (i + 1) % save_every == 0:
            _save_json(drug_dir, drugcore)
            resolved = sum(1 for v in drugcore.values() if v)
            print(f"  [{i + 1}/{len(drugs)}] resolved={resolved}")

    _save_json(drug_dir, drugcore)

    # --- second pass: genecore for every distinct target symbol across all drugs ---
    symbols: set[str] = set()
    for rec in drugcore.values():
        if not rec:
            continue
        for moa in _as_list(rec.get("mechanismsOfAction")):
            if isinstance(moa, dict):
                for tgt in moa.get("targets", []) or []:
                    sym = tgt.get("symbol")
                    if sym:
                        symbols.add(sym)

    genes: dict = _load_json(CACHE_DIR / "genes.json") or {}
    todo = [s for s in sorted(symbols) if s not in genes]
    print(f"Genecore: {len(symbols)} distinct targets, {len(todo)} to fetch")
    for j, sym in enumerate(todo):
        try:
            hits = client.search("genecore", sym, limit=3)
            exact = next((h for h in hits if (h.get("symbol") or "").upper() == sym.upper()), None)
            genes[sym] = exact or (hits[0] if hits else None)
        except Exception as e:
            print(f"  ! gene {sym}: {e}")
        if (j + 1) % 25 == 0:
            _save_json(CACHE_DIR / "genes.json", genes)
            print(f"  [gene {j + 1}/{len(todo)}]")
    _save_json(CACHE_DIR / "genes.json", genes)

    resolved = sum(1 for v in drugcore.values() if v)
    n_reg = len(list(reg_dir.glob("*.json")))
    n_trial = len(list(trial_dir.glob("*.json")))
    print(f"DONE. drugs resolved {resolved}/{len(drugs)}; genes {len(genes)}; "
          f"reg_files={n_reg}; trial_files={n_trial}")


if __name__ == "__main__":
    pull()
