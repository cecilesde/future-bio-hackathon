"""ChEMBL client — the drug universe (approved + experimental).

ChEMBL is open, no key. Molecules with max_phase >= 1 are drugs that have at
least entered clinical development; max_phase 4 = approved, 1-3 = experimental /
clinical-stage. Docs: https://www.ebi.ac.uk/chembl/api/data/
"""
from __future__ import annotations

import time

import requests

BASE = "https://www.ebi.ac.uk/chembl/api/data"


def iter_drugs(min_phase: float = 1.0, page_size: int = 1000):
    """Yield drug dicts for molecules at or above min_phase (clinical/approved)."""
    offset = 0
    while True:
        for attempt in range(4):
            try:
                r = requests.get(
                    f"{BASE}/molecule.json",
                    params={
                        "max_phase__gte": min_phase,
                        "pref_name__isnull": "false",
                        "limit": page_size,
                        "offset": offset,
                    },
                    timeout=60,
                )
                r.raise_for_status()
                break
            except requests.RequestException:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        body = r.json()
        molecules = body.get("molecules", [])
        if not molecules:
            return
        for m in molecules:
            syns = sorted({
                s.get("molecule_synonym", "").strip()
                for s in (m.get("molecule_synonyms") or [])
                if s.get("molecule_synonym")
            })
            yield {
                "chembl_id": m["molecule_chembl_id"],
                "name": (m.get("pref_name") or "").strip(),
                "max_phase": m.get("max_phase"),
                "molecule_type": m.get("molecule_type"),
                "first_approval": m.get("first_approval"),
                "synonyms": syns[:50],
            }
        if len(molecules) < page_size:
            return
        offset += page_size


if __name__ == "__main__":
    n = 0
    for d in iter_drugs():
        n += 1
        if n <= 5:
            print(d["chembl_id"], d["name"], d["max_phase"], d["molecule_type"])
    print("total drugs:", n)
