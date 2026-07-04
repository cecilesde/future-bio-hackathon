"""Stage 5 — score the full drug x disease grid and assemble prediction rows.

Loads the trained model, scores every (resolved drug, canonical disease) pair,
attaches UI-facing evidence (n_trials / furthest_phase / supporting_trials),
a grounded one-sentence rationale, confidence, and per-direction ranks. Writes
data/artifacts/predictions.json for the Supabase loader.
"""

from __future__ import annotations

import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd

from common.features_lib import FeatureBuilder, FEATURE_COLUMNS
from common.evidence import EvidenceIndex
from common.normalize import canonical_diseases

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "data" / "artifacts"


def _confidence(score: float, n_trials: int, has_shared: int) -> str:
    if score >= 0.5 and (n_trials > 0 or has_shared):
        return "high"
    if score >= 0.2:
        return "medium"
    return "low"


def _rationale(fb: FeatureBuilder, drug: str, disease: str, feats: dict) -> str:
    di = fb.drug_info[drug]
    approved = fb.disease_drugs.get(disease, set()) - {drug}
    approved_targets = set()
    for ad in approved:
        adi = fb.drug_info.get(ad)
        if adi:
            approved_targets |= adi["targets"]
    shared = sorted(di["targets"] & approved_targets)
    example = next(iter(approved), None)
    if shared:
        tgt = ", ".join(shared[:2])
        via = f" (e.g. {example})" if example else ""
        return (f"Shares target {tgt} with drug(s) already approved for "
                f"{disease}{via}.")
    if feats.get("chem_sim_max") and feats["chem_sim_max"] >= 0.3 and example:
        return (f"Structurally similar (Tanimoto {feats['chem_sim_max']:.2f}) to "
                f"{example}, approved for {disease}.")
    if feats.get("same_mechanism_approved"):
        return f"Same mechanism of action as an approved drug for {disease}."
    if feats.get("disease_popularity", 0) > 0:
        return (f"Ranked on target biology and drug profile; {disease} has "
                f"{feats['disease_popularity']} approved drug(s) as reference.")
    return "Ranked on target biology and drug profile."


def _top_features(feats: dict) -> dict:
    out = {}
    if feats.get("has_shared_target"):
        out["shared_target"] = int(feats["shared_target_count"])
    if feats.get("same_mechanism_approved"):
        out["same_mechanism"] = True
    if feats.get("chem_sim_max") and feats["chem_sim_max"] >= 0.3:
        out["chem_similarity"] = round(float(feats["chem_sim_max"]), 2)
    if feats.get("tgt_has_clinical_sm_tractability"):
        out["target_tractable"] = True
    return out


def score() -> list[dict]:
    with open(ART / "model.pkl", "rb") as f:
        bundle = pickle.load(f)
    model, iso = bundle["model"], bundle["calibrator"]

    fb = FeatureBuilder()
    ev = EvidenceIndex(fb.drugcore)
    diseases = canonical_diseases()
    positives = {(l["drug"], l["disease"]) for l in fb.labels}

    feat_rows, meta = [], []
    for drug in fb.drug_info:
        for disease in diseases:
            f = fb.features(drug, disease)
            if f is None:
                continue
            feat_rows.append({c: f.get(c) for c in FEATURE_COLUMNS})
            meta.append((drug, disease, f))

    X = pd.DataFrame(feat_rows)
    for c in bundle["cat_cols"]:
        X[c] = X[c].astype("category")
    raw = model.predict_proba(X)
    cal = iso.predict(raw)

    preds = []
    for (drug, disease, feats), s in zip(meta, cal):
        e = ev.get(drug, disease)
        has_shared = int(feats.get("has_shared_target", 0))
        preds.append({
            "drug": drug, "disease": disease,
            "score": round(float(s), 4),
            "is_already_approved": (drug, disease) in positives,
            "confidence": _confidence(float(s), e["n_trials"], has_shared),
            "evidence_tier": "clinical_trial" if e["n_trials"] > 0 else "mechanism_or_literature",
            "furthest_phase": e["furthest_phase"],
            "n_trials": e["n_trials"],
            "rationale": _rationale(fb, drug, disease, feats),
            "supporting_trials": e["supporting_trials"],
            "top_features": _top_features(feats),
        })

    df = pd.DataFrame(preds)
    df["rank_for_disease"] = df.groupby("disease")["score"].rank(ascending=False, method="first").astype(int)
    df["rank_for_drug"] = df.groupby("drug")["score"].rank(ascending=False, method="first").astype(int)
    preds = df.to_dict("records")

    (ART / "predictions.json").write_text(json.dumps(preds))
    print(f"scored {len(preds)} pairs; {sum(p['is_already_approved'] for p in preds)} already-approved")
    # sanity: top drugs for NASH
    nash = sorted([p for p in preds if p["disease"] == "Non-Alcoholic Steatohepatitis"],
                  key=lambda p: -p["score"])[:8]
    print("\nTop predicted drugs for Non-Alcoholic Steatohepatitis:")
    for p in nash:
        flag = " [approved]" if p["is_already_approved"] else ""
        print(f"  {p['score']:.3f}  {p['drug']:22} {p['confidence']:6}{flag}  {p['rationale'][:70]}")
    return preds


if __name__ == "__main__":
    score()
