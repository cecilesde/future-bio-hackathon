# Attritio AI

Reference-class forecasting for drug-program attrition. Give it a disease + a drug
(and optionally a target) and it computes how likely the program is to fail before
approval, decomposes the number, assembles the reference cohort of similar programs
(with real trials and why they stopped), proposes the likely mechanism of action,
names the failure modes, and prices the cheapest experiment that resolves each risk
early. A disease alone yields a ranked table of candidate drugs. A second tab maps
the AMASS clinical-trial landscape by disease.

The live forecast is real, not a mock: the number is deterministic math and the LLM
(Claude) supplies grounded inputs + prose over retrieved Open Targets / Elicit / AMASS
evidence. See `CLAUDE.md` for the full architecture (single source of truth).

Live: https://repurpose-engine-wine.vercel.app (the Vercel project is still named
`repurpose-engine`; the product was renamed from "Prognosis").

## Architecture

```
Inputs (any of): disease · target · drug ──> one Compute button dispatches a lens:
  disease + target (+drug)  ─> target lens      (validation = OT genetic association)
  disease + drug (no target)─> target-free lens (validation = drug efficacy evidence)
  disease alone             ─> discovery: ranked candidate-drug table

  For a forecast lens:
     Open Targets cohort + Elicit literature + AMASS patents/trials
                          │
                          v
     LLM curates a real cohort · modality/failure-modes/derisking · mechanism of
     action (graded) · verdict/confidence
                          │
                          v
     Deterministic attrition = 1 − PoS  (hard 0 if the drug is already approved
     for this indication) · decomposition · swimlanes · patents · literature
```

- **Targets, cohort, patents, literature, trials, per-indication approvals are all
  live/real** (Open Targets GraphQL, Elicit, AMASS, ChEMBL). The narrative sections
  are LLM-generated over that evidence, grounded but not verified clinical fact.
- **A drug already approved for the queried indication reads 0% attrition** (a fact),
  detected from Open Targets `drug.indications` (EFO + subtype match).
- **Trial landscape** (second tab) is the harvested AMASS `trialcore` cache stratified
  by disease (`pipeline/trial_taxonomy.py`).
- The calibration backtest is the only illustrative piece (shown for the 4 authored
  demo pairs; coefficients are literature point estimates, not yet fitted).

## Backend (Supabase)

All UI data is served from Supabase (`pg_*` tables, public-read RLS):

| Table | Contents |
|-------|----------|
| `pg_diseases` | diseases offered in the UI + their EFO/MONDO id |
| `pg_targets` | Open Targets targets per disease, ranked, `modeled` flag |
| `pg_reports` | the 4 authored demo forecast reports (jsonb) |
| `pg_drugs` | ~16.7k ChEMBL approved + experimental drugs (type-ahead) |
| `pg_disease_terms` | AMASS MeSH conditions for the disease type-ahead |
| `pg_literature` | Elicit papers per authored pair |
| `pg_trials` / `pg_trial_disease` / `pg_trial_disease_stats` / `pg_trial_meta` | harvested AMASS trials + the landscape-tab distribution |
| `forecast_cache` | whole-forecast cache (keyed by `SCHEMA_VERSION\|disease\|target\|drugKey`) |
| `pg_evidence` | fine-grained cache-through: patents, drug trials, efficacy grades, discovery lists, drug approvals, disease descendants |

Static UI data is read via PostgREST (`web/src/lib/server-data.ts`) in a server
component. Live forecasts run in API routes (`/api/forecast`, `/api/forecast-by-drug`,
`/api/discover-drugs`, `/api/predict`) and cache through `forecast_cache` / `pg_evidence`.

## Refreshing the data

```bash
source .venv/bin/activate
# 1. (optional) re-harvest AMASS trials, needs AMASS_API_KEY + credits
python pipeline/pull.py
# 2. re-author reports if changed, then dump to seed:
cd web && npx tsx scripts/dump-forecast.ts > ../data/seed/forecast.json && cd ..
# 3. load everything into Supabase (Open Targets + reports + trials)
python pipeline/load_prognosis.py
# 4. the UI (force-dynamic) picks up the new data on next request
```

`pipeline/stratify_trials.py` writes the stratification seed JSON for inspection;
the live app uses the Supabase copy.

## Web app

```bash
cd web && npm install && npm run dev
```

Env (all server-side; never `NEXT_PUBLIC_`), in `web/.env.local` + Vercel:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (cache writes),
`ANTHROPIC_API_KEY` + `ELICIT_API_KEY` (live forecast), `AMASS_API_KEY` (patents/trials).
The loader also uses the root `.env`. See `.env.example`. Deploy: `cd web &&
npx vercel deploy --prod --yes` (uploads the working dir; not git-triggered).
