"""PU (positive-unlabeled) bagging model.

Lives in its own module (not in a script run as __main__) so that pickled models
reference a stable import path `common.pu_model.PUBagger` and can be unpickled from
any process (train writes it, score reads it).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier

SEED = 42


def make_lgbm() -> LGBMClassifier:
    return LGBMClassifier(
        n_estimators=200, learning_rate=0.05, num_leaves=15,
        min_child_samples=5, subsample=0.8, colsample_bytree=0.8,
        reg_lambda=1.0, random_state=SEED, verbose=-1,
    )


class PUBagger:
    """Bagged PU classifier: each bag = all positives + a random unlabeled subsample."""

    def __init__(self, n_bags=15, neg_ratio=20, seed=SEED):
        self.n_bags, self.neg_ratio, self.seed = n_bags, neg_ratio, seed
        self.models: list = []

    def fit(self, X: pd.DataFrame, y: np.ndarray):
        self.models = []
        pos_idx = np.where(y == 1)[0]
        neg_idx = np.where(y == 0)[0]
        n_neg = min(len(neg_idx), self.neg_ratio * max(len(pos_idx), 1))
        rng = np.random.default_rng(self.seed)
        for _ in range(self.n_bags):
            samp = rng.choice(neg_idx, size=n_neg, replace=False)
            idx = np.concatenate([pos_idx, samp])
            m = make_lgbm()
            m.fit(X.iloc[idx], y[idx])
            self.models.append(m)
        return self

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        return np.mean([m.predict_proba(X)[:, 1] for m in self.models], axis=0)
