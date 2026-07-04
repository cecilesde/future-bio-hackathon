"""Stage 6 — load drugs, diseases, predictions, labels, model_meta into Supabase.

Uses the service-role key (bypasses RLS). Idempotent: upserts on natural keys, so
re-running a scoring pass overwrites cleanly. Column shapes match sql/schema.sql and
the UI's web/src/lib/serve.ts reader exactly.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "data" / "artifacts"
CACHE = ROOT / "data" / "cache"


def _as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])


def _client():
    load_dotenv(ROOT / ".env")
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def load():
    sb = _client()
    drugcore = json.loads((CACHE / "drugcore.json").read_text())
    labels = json.loads((ART / "labels.json").read_text())
    preds = json.loads((ART / "predictions.json").read_text())
    metrics = json.loads((ART / "metrics.json").read_text()) if (ART / "metrics.json").exists() else {}

    # per-drug approved diseases + per-disease approved-drug count (for subtitles)
    approved_by_drug: dict[str, list[str]] = {}
    approved_by_disease: dict[str, set[str]] = {}
    for l in labels:
        approved_by_drug.setdefault(l["drug"], []).append(l["disease"])
        approved_by_disease.setdefault(l["disease"], set()).add(l["drug"])

    # ---- drugs (only those we scored) ----
    scored_drugs = sorted({p["drug"] for p in preds})
    drug_rows = []
    for name in scored_drugs:
        rec = drugcore.get(name) or {}
        targets = []
        for moa in _as_list(rec.get("mechanismsOfAction")):
            if isinstance(moa, dict):
                for t in moa.get("targets", []) or []:
                    if t.get("symbol"):
                        targets.append({"symbol": t["symbol"], "ensemblId": t.get("ensemblId"),
                                        "action": moa.get("actionType")})
        drug_rows.append({
            "name": name,
            "chembl_id": rec.get("chemblId"),
            "drug_type": rec.get("drugType"),
            "smiles": rec.get("canonicalSmiles"),
            "inchikey": rec.get("inchiKey"),
            "max_clinical_stage": rec.get("maxClinicalStage"),
            "targets": targets,
            "approved_for": sorted(set(approved_by_drug.get(name, []))),
        })
    sb.table("drugs").upsert(drug_rows, on_conflict="name").execute()

    # ---- diseases (only those we scored) ----
    scored_diseases = sorted({p["disease"] for p in preds})
    disease_rows = [{
        "name": d,
        "n_approved_drugs": len(approved_by_disease.get(d, set())),
    } for d in scored_diseases]
    sb.table("diseases").upsert(disease_rows, on_conflict="name").execute()

    # id maps
    drug_id = {r["name"]: r["id"] for r in
               sb.table("drugs").select("id,name").execute().data}
    disease_id = {r["name"]: r["id"] for r in
                  sb.table("diseases").select("id,name").execute().data}

    # ---- predictions ----
    pred_rows = []
    seen_pairs = set()
    for p in preds:
        di, si = drug_id.get(p["drug"]), disease_id.get(p["disease"])
        if di is None or si is None:
            continue
        if (di, si) in seen_pairs:  # guard against any duplicate pair
            continue
        seen_pairs.add((di, si))
        pred_rows.append({
            "drug_id": di, "disease_id": si,
            "score": p["score"], "is_already_approved": p["is_already_approved"],
            "confidence": p["confidence"], "evidence_tier": p["evidence_tier"],
            "furthest_phase": p["furthest_phase"], "n_trials": p["n_trials"],
            "rationale": p["rationale"], "supporting_trials": p["supporting_trials"],
            "top_features": p["top_features"],
            "rank_for_disease": p["rank_for_disease"], "rank_for_drug": p["rank_for_drug"],
        })
    for chunk in _chunks(pred_rows, 1000):
        sb.table("predictions").upsert(chunk, on_conflict="drug_id,disease_id").execute()

    # ---- labels (audit) ----
    label_rows = []
    for l in labels:
        di, si = drug_id.get(l["drug"]), disease_id.get(l["disease"])
        if di is None or si is None:
            continue
        for agency in (l["agencies"] or ["UNKNOWN"]):
            label_rows.append({"drug_id": di, "disease_id": si, "agency": agency,
                               "first_authorization_date": l["first_date"]})
    if label_rows:
        for chunk in _chunks(label_rows, 1000):
            sb.table("labels").upsert(chunk, on_conflict="drug_id,disease_id,agency").execute()

    # ---- model_meta ---- (coverage note uses ACTUAL grid counts, not hardcoded)
    coverage_note = (
        "Calibrated approval-resemblance probability from a positive-unlabeled "
        "model over Amass evidence. Reflects similarity to historically approved "
        "drug-disease pairs, not a validated probability of trial success or "
        f"efficacy. Candidate grid: {len(drug_rows)} drugs x {len(disease_rows)} "
        "diseases.")
    sb.table("model_meta").upsert({
        "run_id": "latest",
        "metrics": metrics,
        "coverage_note": coverage_note,
        "notes": f"{len(pred_rows)} predictions, {len(drug_rows)} drugs, "
                 f"{len(disease_rows)} diseases, {len(label_rows)} labels.",
    }, on_conflict="run_id").execute()

    print(f"loaded: {len(drug_rows)} drugs, {len(disease_rows)} diseases, "
          f"{len(pred_rows)} predictions, {len(label_rows)} labels")


if __name__ == "__main__":
    load()
