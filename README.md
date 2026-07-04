# Drug repurposing engine on Amass

Given an already-approved drug, surface indications OTHER than the one(s) it was
approved for, grounded in structured clinical-trial, regulatory and mechanism data
from the [Amass](https://platform.amass.tech) life-sciences API.

## What it does (and does not) claim

This is **evidence-grounded hypothesis generation**, not a trained statistical
predictor. An approved drug usually already has trials and literature for other
indications that never reached approval. The engine aggregates those signals and
(optionally) has an LLM reason over mechanism to rank them. It surfaces and ranks
existing evidence; it does not compute a novel probability of success. A true
predictive model (trained on drug-target-disease graphs) would be a separate build.

## Architecture

Two layers, deliberately separated:

1. **Deterministic query engine** (`repurposing.py`) — pure Amass queries, no LLM.
   Asserts only facts pulled straight from records. This is the "database query
   model." It:
   - resolves the drug in **DrugCore** (canonical name, mechanism/targets, brands);
   - pulls the drug's authorizations from **RegulatoryCore** (the known baseline);
   - pulls its trials from **TrialCore** and aggregates DISTINCT indications with
     objective per-indication evidence (trial count, furthest phase, completions,
     results posted, sample NCT IDs).

2. **LLM reasoning layer** (`agent.py`) — an agentic Claude loop (Anthropic tool
   use) that takes the deterministic evidence, separates novel candidates from the
   already-approved and from noise, pulls extra literature on demand, and emits a
   ranked report with rationale + calibrated confidence + citations.

`amass_client.py` is the thin API client shared by both.

## Two non-obvious correctness constraints (handled)

- **Amass caps every query at 300 results and has NO pagination** (`offset`/`page`
  are silently ignored). Recall is widened by unioning the drug name + its trade
  names. The 300-cap residual is disclosed in each report's coverage note, never
  silently truncated.
- **Full-text match != the drug is the intervention.** A naive search for
  `sildenafil` returns orthopedic trials that merely *exclude* patients on it, and
  research-code synonyms (`HIP-0908`) collide with unrelated trials. Every trial is
  therefore filtered to those where the drug actually appears in the intervention
  fields before its conditions are counted.

## Usage

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then put your amass_ key in .env

python main.py "semaglutide"            # deterministic evidence table
python main.py "sildenafil" --json      # machine-readable JSON (for a future UI)
python main.py "semaglutide" --agent    # + LLM ranking (needs ANTHROPIC_API_KEY)
```

The `--json` output is the intended contract for a future dashboard: type a drug,
get a structured indications table.
