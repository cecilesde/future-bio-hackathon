"""Stratify the harvested AMASS trialcore cache by disease area -> disease and
emit the seed JSON (data/seed/trial-distribution.json).

The classification logic lives in trial_taxonomy.py (shared with the Supabase
loader). This script just runs the aggregate and writes it out. The live UI
reads this distribution from Supabase; the JSON is the reproducible seed.
"""
import json
import os

import trial_taxonomy as tax

OUT = os.path.join(tax.ROOT, "data", "seed", "trial-distribution.json")


def main():
    dist = tax.aggregate()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(dist, fh, indent=1)
    m = dist["meta"]
    print(f"unique trials: {m['totalUniqueTrials']}  mapped: {m['mappedTrials']} "
          f"({m['mappedTrials'] / m['totalUniqueTrials']:.0%})  areas: {m['areas']}")
    for a in dist["areas"]:
        print(f"  {a['trials']:6d}  {a['area']} ({len(a['diseases'])} diseases)")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
