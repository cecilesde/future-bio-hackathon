# Prognosis

Reference-class forecasting for drug-program attrition. Pick a disease, see the
targets Open Targets associates with it, pick one, and get a forecast built from
the historical programs most mechanistically like it: how they died, each
failure mode, and the cheapest experiment that resolves it early. A second tab
maps the AMASS clinical-trial landscape by disease.

Live: https://repurpose-engine-wine.vercel.app

## Architecture

```
Disease ──Open Targets──> Targets (association scores) ──> Selected target
                                                              │
                        ┌─────────────────────────────────────┘
                        v
        Reference cohort (AMASS trials, patents, literature)
                        │
                        v
     Forecast: attrition risk · failure modes · kill experiments ·
               modality feasibility · calibration backtest
```

- **Targets are generated from Open Targets** (`pipeline/opentargets.py`), not
  hand-picked: the GraphQL Platform API returns each disease's associated
  targets with real association scores and evidence breakdown.
- **Trial landscape** is the harvested AMASS `trialcore` cache stratified by
  disease (`pipeline/trial_taxonomy.py`).
- The **forecast reports themselves are still authored/illustrative** placeholders
  for the agentic model (AMASS + Elicit + reasoning) that produces the attrition
  score. That model is the next build; the data backbone around it is real.

## Backend (Supabase)

All UI data is served from Supabase (`pg_*` tables, public-read RLS):

| Table | Contents |
|-------|----------|
| `pg_diseases` | diseases offered in the UI + their EFO/MONDO id |
| `pg_targets` | Open Targets targets per disease, ranked, `modeled` flag |
| `pg_reports` | authored forecast reports (jsonb) |
| `pg_trials` | harvested AMASS trials (deduped) |
| `pg_trial_disease` | trial to (area, disease) map |
| `pg_trial_disease_stats` | aggregate distribution the landscape tab reads |
| `pg_trial_meta` | header totals + caveat |

The Next.js app reads these via PostgREST (`web/src/lib/server-data.ts`) in a
server component; nothing computes at request time beyond the query.

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
cd web && npm install && npm run dev   # needs SUPABASE_URL + SUPABASE_ANON_KEY
```

Requires `SUPABASE_URL`, `SUPABASE_ANON_KEY` (web) and, for the loader,
`SUPABASE_SERVICE_ROLE_KEY`, `AMASS_API_KEY` (root `.env`). See `.env.example`.
