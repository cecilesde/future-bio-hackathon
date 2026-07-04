"""Disease normalization: map messy free-text to the 207 canonical diseases.

This is the crux of label quality. Two entry points:
  - match_in_text(text): find canonical diseases whose name/alias appears in a
    block of free text (used on regulatory indication prose, which for EMA
    records typically begins with the disease name).
  - best_match(term): fuzzy-map a single clean condition term (e.g. a trial's
    conditionMeshTerm, itself MeSH-normalized) to a canonical disease.

Design choices:
  - Substring detection is word-boundary aware to avoid "flu" matching "influenza"
    inside "influence", etc.
  - A hand-authored alias map covers the high-value renamings the fuzzy matcher
    would miss (NASH/MASH, NAFLD/MASLD, abbreviations). Extend it as validation
    against known approvals surfaces misses. NEVER let a wrong map harden silently.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from rapidfuzz import fuzz, process

ROOT = Path(__file__).resolve().parent.parent
SEED_DIR = ROOT / "data" / "seed"

# canonical -> extra aliases (all matched case-insensitively, word-boundary).
# Only add aliases you can defend; a wrong alias poisons labels.
_ALIASES: dict[str, list[str]] = {
    "Non-Alcoholic Steatohepatitis": [
        "nash", "mash", "nonalcoholic steatohepatitis",
        "metabolic dysfunction-associated steatohepatitis",
        "metabolic dysfunction associated steatohepatitis",
    ],
    "Non-Alcoholic Fatty Liver Disease": [
        "nafld", "masld", "nonalcoholic fatty liver disease",
        "metabolic dysfunction-associated steatotic liver disease",
        "fatty liver disease",
    ],
    "Type 2 Diabetes Mellitus": [
        "type 2 diabetes", "t2dm", "type ii diabetes",
        "non-insulin-dependent diabetes", "niddm",
    ],
    "Type 1 Diabetes Mellitus": ["type 1 diabetes", "t1dm", "insulin-dependent diabetes"],
    "Heart Failure": ["cardiac failure", "congestive heart failure", "chf"],
    "Chronic Kidney Disease": ["ckd", "chronic renal disease", "chronic renal failure"],
    "Myocardial Infarction": ["heart attack"],
    "Hypertension": ["high blood pressure", "elevated blood pressure"],
    "Rheumatoid Arthritis": ["ra "],
    "Ulcerative Colitis": ["uc "],
    "Crohn Disease": ["crohn's disease", "crohns disease"],
    "Chronic Obstructive Pulmonary Disease": ["copd"],
    "Major Depressive Disorder": ["mdd", "major depression", "clinical depression"],
    "Attention Deficit Hyperactivity Disorder": ["adhd"],
}

_STOP = re.compile(r"[^a-z0-9]+")


def _norm(s: str) -> str:
    return _STOP.sub(" ", (s or "").lower()).strip()


@lru_cache(maxsize=1)
def _load() -> tuple[list[str], dict[str, str], dict[str, str]]:
    """Return (canonical_list, alias_norm -> canonical, canonical_norm -> canonical)."""
    raw = json.loads((SEED_DIR / "diseases.json").read_text())
    canon = list(dict.fromkeys(raw))  # dedupe, preserve order (seed has a dup)
    alias_to_canon: dict[str, str] = {}
    canon_norm: dict[str, str] = {}
    for c in canon:
        canon_norm[_norm(c)] = c
        alias_to_canon[_norm(c)] = c
        for a in _ALIASES.get(c, []):
            alias_to_canon[_norm(a)] = c
    return canon, alias_to_canon, canon_norm


def match_in_text(text: str) -> list[str]:
    """Canonical diseases whose name or alias appears in `text` (word-boundary).

    Returns matches ordered by the position they appear (earliest first), so an
    EMA indication that opens with the disease name yields it first. De-duplicated.
    """
    canon, alias_to_canon, _ = _load()
    hay = " " + _norm(text) + " "
    # record the matched alias string per canonical, to resolve specificity later
    hits: list[tuple[int, str, str]] = []  # (pos, canonical, matched_alias_norm)
    seen: set[str] = set()
    for alias_norm, canonical in alias_to_canon.items():
        if canonical in seen:
            continue
        needle = " " + alias_norm + " "
        pos = hay.find(needle)
        if pos != -1:
            hits.append((pos, canonical, alias_norm))
            seen.add(canonical)
    # prefer the most specific: drop a match whose alias is a substring of another
    # matched alias (e.g. "hypertension" inside "pulmonary hypertension").
    aliases = [a for _, _, a in hits]
    kept = []
    for pos, canonical, alias_norm in hits:
        if any(alias_norm != other and alias_norm in other for other in aliases):
            continue
        kept.append((pos, canonical))
    kept.sort()
    return [c for _, c in kept]


def best_match(term: str, threshold: int = 88) -> str | None:
    """Fuzzy-map one clean condition term to a canonical disease, or None.

    Use for trial conditionMeshTerms (already MeSH-normalized). Tries exact/alias
    first, then token_set_ratio fuzzy above `threshold`.
    """
    if not term or not term.strip():
        return None
    canon, alias_to_canon, _ = _load()
    n = _norm(term)
    if n in alias_to_canon:
        return alias_to_canon[n]
    match = process.extractOne(
        n, list(alias_to_canon.keys()), scorer=fuzz.token_set_ratio
    )
    if match and match[1] >= threshold:
        return alias_to_canon[match[0]]
    return None


def canonical_diseases() -> list[str]:
    return list(_load()[0])


if __name__ == "__main__":  # quick self-check
    tests = [
        "Type 2 diabetes mellitus Forxiga is indicated in adults ...",
        "noncirrhotic metabolic dysfunction-associated steatohepatitis (MASH)",
        "for the treatment of adults with NASH with moderate fibrosis",
        "chronic heart failure with reduced ejection fraction",
    ]
    for t in tests:
        print(f"{t[:55]!r:57} -> {match_in_text(t)}")
    for term in ["Diabetes Mellitus, Type 2", "Alzheimer's disease", "COPD"]:
        print(f"best_match({term!r}) -> {best_match(term)}")
