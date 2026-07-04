"""Stage 3 — assemble the (drug x disease) feature matrix + labels.

Candidate grid = resolved seed drugs x 207 canonical diseases. Each row is one pair
with its leakage-safe features (common/features_lib) and a binary label (1 iff the
pair is a known approval). Saved to data/artifacts/dataset.parquet.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from common.features_lib import FeatureBuilder, FEATURE_COLUMNS
from common.normalize import canonical_diseases

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "data" / "artifacts"


def build() -> pd.DataFrame:
    fb = FeatureBuilder()
    diseases = canonical_diseases()
    positives = {(l["drug"], l["disease"]) for l in fb.labels}

    rows = []
    for drug in fb.drug_info:  # only resolved drugs
        for disease in diseases:
            feats = fb.features(drug, disease)
            if feats is None:
                continue
            feats["drug"] = drug
            feats["disease"] = disease
            feats["label"] = int((drug, disease) in positives)
            rows.append(feats)

    df = pd.DataFrame(rows)
    ART.mkdir(parents=True, exist_ok=True)
    df.to_parquet(ART / "dataset.parquet")
    pos = int(df["label"].sum())
    print(f"dataset: {len(df)} pairs ({df['drug'].nunique()} drugs x "
          f"{df['disease'].nunique()} diseases), {pos} positives "
          f"(base rate {pos / len(df):.4%})")
    print(f"feature columns: {FEATURE_COLUMNS}")
    # coverage of transfer signal among positives vs negatives (sanity)
    for col in ("has_shared_target", "same_mechanism_approved"):
        p = df[df.label == 1][col].mean()
        n = df[df.label == 0][col].mean()
        print(f"  {col:26} positives={p:.2f}  negatives={n:.3f}")
    return df


if __name__ == "__main__":
    build()
