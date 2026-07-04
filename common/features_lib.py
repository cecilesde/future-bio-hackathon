"""Feature construction for (drug, disease) candidate pairs.

CORE CONSTRAINT (the whole point): every feature must be computable for a pair with
ZERO trial history, so we use only drug-intrinsic, disease-intrinsic, and RELATIONAL
(transfer) signals. Trial-derived quantities (n_trials, furthest_phase) are carried
as EVIDENCE for the UI but are NOT model features.

LEAKAGE GUARD: transfer features for pair (d, X) are computed with d and X's own
label removed ("leave-one-out"): the approved-drug set for disease X excludes d, and
d's promiscuity count excludes X. A positive pair therefore cannot see itself.

Feature families implemented here:
  drug-intrinsic   : drug_type, n_targets, has_smiles, target-gene genetics
                     (LOEUF/pLI/essentiality), target safety load, tractability,
                     drug promiscuity (#other approved indications).
  disease-intrinsic: disease popularity (#other approved drugs) [the popularity
                     baseline signal — monitored, not trusted alone].
  relational/xfer  : shared-target-with-approved, same-mechanism-approved,
                     max/mean Tanimoto chemical similarity to drugs approved for
                     the disease.

Deferred (needs extra pulls): target-disease genetic & literature association.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "cache"
ART = ROOT / "data" / "artifacts"

try:
    from rdkit import Chem
    from rdkit.Chem import AllChem, DataStructs
    from rdkit import RDLogger
    RDLogger.DisableLog("rdApp.*")
    _RDKIT = True
except Exception:  # pragma: no cover
    _RDKIT = False


def _as_list(v):
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("[") and s.endswith("]"):
            try:
                return json.loads(s)
            except json.JSONDecodeError:
                return [v]
    return [v]


def _fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class FeatureBuilder:
    """Precomputes per-drug and per-disease aggregates; emits per-pair feature dicts."""

    def __init__(self):
        self.drugcore: dict = json.loads((CACHE / "drugcore.json").read_text())
        self.genes: dict = json.loads((CACHE / "genes.json").read_text()) \
            if (CACHE / "genes.json").exists() else {}
        self.labels: list[dict] = json.loads((ART / "labels.json").read_text())

        # drug -> {targets:set[symbol], actions:set, drug_type, smiles, fp}
        self.drug_info: dict[str, dict] = {}
        for name, rec in self.drugcore.items():
            if not rec:
                continue
            targets, actions = set(), set()
            for moa in _as_list(rec.get("mechanismsOfAction")):
                if not isinstance(moa, dict):
                    continue
                act = moa.get("actionType")
                for t in moa.get("targets", []) or []:
                    sym = t.get("symbol")
                    if sym:
                        targets.add(sym)
                        if act:
                            actions.add((sym, act))
            smiles = rec.get("canonicalSmiles")
            self.drug_info[name] = {
                "targets": targets,
                "actions": actions,
                "drug_type": rec.get("drugType"),
                "smiles": smiles,
                "fp": self._fingerprint(smiles),
            }

        # disease -> set of approved drugs; drug -> set of approved diseases
        self.disease_drugs: dict[str, set[str]] = {}
        self.drug_diseases: dict[str, set[str]] = {}
        for l in self.labels:
            self.disease_drugs.setdefault(l["disease"], set()).add(l["drug"])
            self.drug_diseases.setdefault(l["drug"], set()).add(l["disease"])

    # ---- helpers ----
    @staticmethod
    def _fingerprint(smiles):
        if not (_RDKIT and smiles):
            return None
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            return None
        return AllChem.GetMorganFingerprintAsBitVect(mol, radius=2, nBits=2048)

    def _target_genetics(self, symbols: set[str]) -> dict:
        loeuf, pli, ess, safety, tract_sm = [], [], [], 0, 0
        for sym in symbols:
            g = self.genes.get(sym)
            if not g:
                continue
            gc = (g.get("gnomadConstraint") or {}).get("lossOfFunction") or {}
            if _fnum(gc.get("loeuf")) is not None:
                loeuf.append(_fnum(gc.get("loeuf")))
            if _fnum(gc.get("pli")) is not None:
                pli.append(_fnum(gc.get("pli")))
            dm = g.get("depmapEssentiality") or {}
            if _fnum(dm.get("meanGeneEffect")) is not None:
                ess.append(_fnum(dm.get("meanGeneEffect")))
            safety += len(g.get("safetyLiabilities") or [])
            tr = (g.get("tractability") or {}).get("smallMolecule") or {}
            if tr.get("clinical"):
                tract_sm = 1
        return {
            "tgt_loeuf_mean": statistics.mean(loeuf) if loeuf else None,
            "tgt_pli_mean": statistics.mean(pli) if pli else None,
            "tgt_essentiality_mean": statistics.mean(ess) if ess else None,
            "tgt_safety_count": safety,
            "tgt_has_clinical_sm_tractability": tract_sm,
        }

    def _chem_sim(self, fp, approved_fps: list) -> dict:
        if fp is None or not approved_fps:
            return {"chem_sim_max": None, "chem_sim_mean": None}
        sims = [DataStructs.TanimotoSimilarity(fp, a) for a in approved_fps if a is not None]
        if not sims:
            return {"chem_sim_max": None, "chem_sim_mean": None}
        return {"chem_sim_max": max(sims), "chem_sim_mean": sum(sims) / len(sims)}

    # ---- main API ----
    def features(self, drug: str, disease: str) -> dict | None:
        di = self.drug_info.get(drug)
        if di is None:
            return None
        # leave-one-out: exclude this pair from the transfer sets
        approved_drugs = self.disease_drugs.get(disease, set()) - {drug}
        my_diseases = self.drug_diseases.get(drug, set()) - {disease}

        approved_targets: set[str] = set()
        approved_actions: set = set()
        approved_fps = []
        for ad in approved_drugs:
            adi = self.drug_info.get(ad)
            if not adi:
                continue
            approved_targets |= adi["targets"]
            approved_actions |= adi["actions"]
            if adi["fp"] is not None:
                approved_fps.append(adi["fp"])

        shared = di["targets"] & approved_targets
        feats = {
            # drug-intrinsic
            "drug_type": di["drug_type"] or "UNKNOWN",
            "n_targets": len(di["targets"]),
            "has_smiles": int(di["smiles"] is not None),
            "drug_promiscuity": len(my_diseases),
            # disease-intrinsic (popularity baseline signal)
            "disease_popularity": len(approved_drugs),
            # relational / transfer
            "shared_target_count": len(shared),
            "has_shared_target": int(bool(shared)),
            "same_mechanism_approved": int(bool(di["actions"] & approved_actions)),
        }
        feats.update(self._target_genetics(di["targets"]))
        feats.update(self._chem_sim(di["fp"], approved_fps))
        return feats


FEATURE_COLUMNS = [
    "drug_type", "n_targets", "has_smiles", "drug_promiscuity",
    "disease_popularity", "shared_target_count", "has_shared_target",
    "same_mechanism_approved", "tgt_loeuf_mean", "tgt_pli_mean",
    "tgt_essentiality_mean", "tgt_safety_count", "tgt_has_clinical_sm_tractability",
    "chem_sim_max", "chem_sim_mean",
]

if __name__ == "__main__":
    fb = FeatureBuilder()
    print(f"drugs with info: {len(fb.drug_info)}; labelled diseases: {len(fb.disease_drugs)}")
    # a known transfer case: a GLP-1 drug vs a disease other GLP-1 drugs are approved for
    for d, dis in [("Tirzepatide", "Non-Alcoholic Steatohepatitis"),
                   ("Empagliflozin", "Heart Failure"),
                   ("Sitagliptin", "Type 2 Diabetes Mellitus")]:
        f = fb.features(d, dis)
        if f:
            print(f"\n{d} x {dis}:")
            for k in ("has_shared_target", "shared_target_count", "same_mechanism_approved",
                      "chem_sim_max", "disease_popularity", "drug_promiscuity"):
                print(f"   {k:26} = {f.get(k)}")
