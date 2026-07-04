"""Stage 4 — train the PU predictor and evaluate it honestly.

Model: bagged LightGBM (positive-unlabeled via negative subsampling), with a
regularized logistic regression baseline and a disease-popularity floor. The model
must beat the popularity floor or it is just a crowd detector, not a repurposing
model.

Evaluation: repeated stratified K-fold over PAIRS. For each fold we hold out pairs,
train on the rest, and rank the held-out positives among held-out unlabeled pairs.
Metrics: AUPRC (vs base-rate line), Hits@k, recall@k. We also report a "hard" slice:
performance on positives that have NO shared target (can the model transfer without
the single strongest feature?).

Calibration: isotonic regression on out-of-fold scores -> probabilities.

Artifacts: data/artifacts/model.pkl (bagged boosters + calibrator + columns),
data/artifacts/metrics.json.
"""

from __future__ import annotations

import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler

from common.features_lib import FEATURE_COLUMNS
from common.pu_model import PUBagger, SEED

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "data" / "artifacts"

CAT_COLS = ["drug_type"]
NUM_COLS = [c for c in FEATURE_COLUMNS if c not in CAT_COLS]


def _prep(df: pd.DataFrame) -> pd.DataFrame:
    X = df[FEATURE_COLUMNS].copy()
    for c in CAT_COLS:
        X[c] = X[c].astype("category")
    return X


def _hits_at_k(y_true: np.ndarray, scores: np.ndarray, ks=(10, 25, 50)) -> dict:
    order = np.argsort(-scores)
    yt = y_true[order]
    out = {}
    n_pos = int(y_true.sum())
    for k in ks:
        hits = int(yt[:k].sum())
        out[f"hits@{k}"] = hits
        out[f"recall@{k}"] = hits / n_pos if n_pos else 0.0
    return out


def evaluate(df: pd.DataFrame, n_splits=5, n_repeats=3) -> dict:
    X = _prep(df)
    y = df["label"].to_numpy()
    oof = np.zeros(len(df))
    oof_count = np.zeros(len(df))

    aps, pop_aps = [], []
    for rep in range(n_repeats):
        skf = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=SEED + rep)
        for tr, te in skf.split(X, y):
            model = PUBagger(seed=SEED + rep).fit(X.iloc[tr], y[tr])
            s = model.predict_proba(X.iloc[te])
            oof[te] += s
            oof_count[te] += 1
            aps.append(average_precision_score(y[te], s))
            # popularity floor on the same held-out fold
            pop_aps.append(average_precision_score(y[te], df["disease_popularity"].to_numpy()[te]))

    oof /= np.maximum(oof_count, 1)
    base_rate = float(y.mean())
    metrics = {
        "n_pairs": int(len(df)), "n_positives": int(y.sum()),
        "base_rate": base_rate,
        "auprc_model_mean": float(np.mean(aps)),
        "auprc_model_std": float(np.std(aps)),
        "auprc_popularity_floor": float(np.mean(pop_aps)),
        "auprc_random": base_rate,
        "lift_over_popularity": float(np.mean(aps) / max(np.mean(pop_aps), 1e-9)),
        **_hits_at_k(y, oof),
    }
    # hard slice: positives with no shared target (pure non-obvious transfer)
    hard = (df["label"] == 1) & (df["has_shared_target"] == 0)
    if hard.sum() >= 3:
        mask = (df["has_shared_target"] == 0).to_numpy()
        metrics["auprc_hard_no_shared_target"] = float(
            average_precision_score(y[mask], oof[mask]))
        metrics["n_hard_positives"] = int(hard.sum())
    return metrics, oof


def train_final(df: pd.DataFrame, oof: np.ndarray):
    X = _prep(df)
    y = df["label"].to_numpy()
    model = PUBagger().fit(X, y)
    # calibrate on out-of-fold scores (never on training scores)
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(oof, y)
    # logistic-regression baseline (reported, not served)
    Xn = df[NUM_COLS].fillna(df[NUM_COLS].median())
    lr = LogisticRegression(max_iter=1000, class_weight="balanced")
    lr.fit(StandardScaler().fit_transform(Xn), y)
    return model, iso


def main():
    df = pd.read_parquet(ART / "dataset.parquet")
    metrics, oof = evaluate(df)
    print(json.dumps(metrics, indent=2))
    model, iso = train_final(df, oof)
    with open(ART / "model.pkl", "wb") as f:
        pickle.dump({"model": model, "calibrator": iso,
                     "feature_columns": FEATURE_COLUMNS,
                     "cat_cols": CAT_COLS}, f)
    (ART / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"\nSaved model.pkl + metrics.json")
    verdict = "BEATS" if metrics["lift_over_popularity"] > 1.2 else "DOES NOT clearly beat"
    print(f"VERDICT: model {verdict} the popularity floor "
          f"(AUPRC {metrics['auprc_model_mean']:.3f} vs "
          f"{metrics['auprc_popularity_floor']:.3f}).")


if __name__ == "__main__":
    main()
