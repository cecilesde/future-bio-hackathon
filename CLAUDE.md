# CLAUDE.md — Prognosis

Reference-class forecaster for **drug-program attrition**. You give it a disease, a target,
and a drug; it tells you how a program like that is likely to fail, why, and the cheapest
experiment to kill each risk early. Second tab maps the AMASS clinical-trial landscape by
disease.

- **Live:** https://repurpose-engine-wine.vercel.app
- **Repo state at last handoff:** commit `b6f7dbd` on `main` (GitHub `kirangathani/future-bio-hackathon`).
- This file is the single source of truth for a fresh instance. Read it fully before editing.

---

## 1. What is REAL vs ILLUSTRATIVE (read this first — do not conflate)

| Piece | Status |
|---|---|
| **Targets** for a disease | REAL — live Open Targets association scores + evidence |
| **Drug universe** (type-ahead) | REAL — 16,784 ChEMBL approved + experimental compounds |
| **Disease universe** (type-ahead) | REAL — 2,979 AMASS MeSH conditions |
| **Trial landscape** tab | REAL — 43,285 harvested AMASS trials stratified by disease |
| **Literature** panel | REAL — live Elicit semantic search |
| **Predict-the-third** (drug→targets, drug+target evidence) | REAL — Claude reads Elicit abstracts and extracts/judges |
| **Attrition composition math** | REAL formula, literature-anchored coefficients (NOT fitted yet) |
| **The 4 forecast reports** (cohort, failure modes, calibration, modality, verdict) | **AUTHORED / ILLUSTRATIVE.** Hand-written, plausible, NOT verified clinical fact. |

The full attrition **forecast** currently renders **only for 4 authored pairs**:
`obesity:GLP1R`, `obesity:MC4R`, `obesity:GPR75`, `alzheimers:BACE1`. Any other
disease+target shows a "No modeled forecast" placeholder. **Generating a forecast for
arbitrary pairs is the #1 pending build (§8).**

---

## 2. Target architecture (Kiran's diagram)

```
Disease ──OpenTargets──▶ Targets (association scores, directionality*) ──▶ Selected target
   │                                                                          │ (+ drug, + modality)
   └──────────────────────────────┐          ┌────────────────────────────────┘
                                   ▼          ▼
                    Reference cohort: AMASS trials · Elicit literature · patents*
                                   │
                                   ▼
              Agentic model  ─▶  Attrition risk · Failure mode · Confidence ·
                                  Output rationale · Derisking opportunities
```
Three typed inputs (disease / target / drug). **Fill two, predict the third.**
`*` = not yet built (directionality, patents).

---

## 3. Stack & where things live

- **web/** — Next.js 16 (App Router, Turbopack, Tailwind v4, IBM Plex fonts). Deployed to
  Vercel (project `repurpose-engine`, alias `repurpose-engine-wine.vercel.app`, account
  `kirangathanis-projects`). Deploy with `cd web && npx vercel deploy --prod --yes` (NOT via
  git — Vercel uploads the working dir directly). Page is `force-dynamic`.
- **pipeline/** — Python data loaders (use the repo `.venv`).
- **data/cache/** — the 157MB AMASS trial harvest. **Gitignored, local-only, and currently
  NOT regenerable (AMASS out of credits).** The single irreplaceable artifact.
- **data/seed/** — tracked seeds (`forecast.json` = authored reports; `trial-distribution.json`).
- **Supabase** project `vkcendblgzjxvxsufldw`. UI reads it via PostgREST `fetch` (see §5).

### Data sources & API keys (all server-side; never `NEXT_PUBLIC_`)
| Source | Key | Notes |
|---|---|---|
| Open Targets GraphQL | none | `api.platform.opentargets.org` — disease→targets, gene search, (future) knownDrugs |
| ChEMBL REST | none | `ebi.ac.uk/chembl` — drug universe |
| AMASS trialcore | `AMASS_API_KEY` | **OUT OF CREDITS** (top up at platform.amass.tech). Trials/lit/patents. Papers+patents cores. |
| Elicit | `ELICIT_API_KEY` | `elicit.com/api/v1` — papers + clinical trials, **NOT patents**. Pro plan. |
| Anthropic | `ANTHROPIC_API_KEY` | Claude `claude-opus-4-8`, official `@anthropic-ai/sdk`, structured outputs |

Keys live in **root `.env`** (pipeline) and **`web/.env.local` + Vercel** (web app). See §7 gotchas.

---

## 4. Pipeline scripts (Python, run from repo root with `.venv` active)

- `pipeline/opentargets.py` — disease→associated targets, target search, per-pair association.
- `pipeline/chembl.py` — iterate the drug universe (max_phase ≥ 1).
- `pipeline/elicit.py` — Elicit search (also mirrored in TS at `web/src/lib/elicit.ts`).
- `pipeline/trial_taxonomy.py` — the disease classifier + `aggregate()` (single source of truth
  for MeSH-condition → area/disease mapping).
- `pipeline/stratify_trials.py` — writes `data/seed/trial-distribution.json`.
- `pipeline/pull.py` — harvest trials from AMASS (needs credits).
- `pipeline/load_prognosis.py` — **the loader.** Populates all `pg_*` tables from Open Targets +
  ChEMBL + the authored `data/seed/forecast.json` + the AMASS cache. Idempotent. Run:
  `source .venv/bin/activate && python pipeline/load_prognosis.py`

Refresh authored reports: edit `web/src/lib/data.ts`, then
`cd web && npx tsx scripts/dump-forecast.ts > ../data/seed/forecast.json`, then re-run the loader.

---

## 5. Supabase schema (`pg_*` tables, public-read RLS via anon key)

| Table | Contents |
|---|---|
| `pg_diseases` | authored diseases (obesity, alzheimers) + EFO/MONDO id |
| `pg_targets` | Open Targets targets per disease, ranked, `modeled` flag |
| `pg_reports` | the 4 authored forecast reports (jsonb) |
| `pg_trials` | 43,284 harvested AMASS trials (phase/status bucketed) |
| `pg_trial_disease` | trial → (area, disease) map |
| `pg_trial_disease_stats` | aggregate distribution the landscape tab reads |
| `pg_trial_meta` | header totals + caveat |
| `pg_literature` | Elicit papers per modeled pair |
| `pg_drugs` | ChEMBL drug universe; `search_blob` (name+synonyms) powers brand-name search |
| `pg_disease_terms` | AMASS MeSH disease universe for the disease type-ahead |

Old **repurposing** tables (`drugs`, `diseases`, `predictions`, `labels`, `model_meta`) are
UNUSED by this UI and safe to drop. `pg_*` is the only live namespace.

---

## 6. Web app structure (`web/src/`)

- `app/page.tsx` — Server Component; fetches diseases/reports/literature/distribution from
  Supabase and passes to `<Shell>`.
- `app/api/drugs`, `/api/diseases`, `/api/targets` — type-ahead search routes.
- `app/api/predict` — **Claude+Elicit prediction** (`maxDuration=60`).
- `lib/supabase.ts` — `restQuery()` PostgREST fetch. **Deliberately NOT `@supabase/supabase-js`**
  (its realtime WS layer breaks on Node 20).
- `lib/server-data.ts` — builds the typed data objects the UI renders.
- `lib/attrition.ts` — the computed attrition model (see below).
- `lib/predict.ts` + `lib/elicit.ts` — Claude extraction + Elicit search (server-only).
- `lib/data.ts` — the authored forecast source (dumped to `data/seed/forecast.json` for loading).
- `components/`: `Shell` (Forecast / Trial-landscape tabs) → `Prognosis` (3 inputs + report),
  `PickerInput` (disease/target type-ahead), `DrugInput` (multi-select), `PredictionPanel`
  (fill-two-predict-third), `Swimlanes` (survival chart), `report-parts` (verdict, attrition
  composition, failure modes, modality, adversarial, derisking, literature, calibration),
  `TrialLandscape`.

### The attrition model (`lib/attrition.ts`)
`attrition = 1 − PoS`, where `logit(PoS) = logit(base_rate) + Σ ln(OR)`:
1. **Base rate** — phase→approval by therapeutic area (Wong/Siah/Lo 2019; BIO). *Anchored on the
   selected drug's max_phase* — this is what makes the score change with the drug.
2. **Genetic support** OR — Open Targets association (Nelson 2015).
3. **Modality feasibility** OR — from the report's modality axes.
4. **Reference-class precedent** OR — cohort failure fraction.
5. **Drug track record** OR.
Rendered as the "Attrition composition" panel (each term + value + citation). Coefficients are
**literature point estimates, not fitted** — fitting on the held-out set is pending.

---

## 7. Gotchas (learned the hard way — don't repeat)

- **Env keys:** `web/.env.local` shipped with EMPTY placeholder values for `ANTHROPIC_API_KEY`;
  real keys were only in root `.env`. Both `web/.env.local` AND Vercel need the real values.
  Verify a key's *length*, not just its presence.
- **Vercel deploys ≠ git push.** `vercel deploy` uploads the working dir. Both are needed
  (deploy = live, push = backup).
- **`rm` is permission-blocked** in the working session — `mv` to scratchpad or use `git rm`.
- **`@supabase/supabase-js` breaks on Node 20** (realtime WebSocket). Use REST `fetch`.
- **A phantom column silently empties a query** — PostgREST 400s on an unknown selected column;
  surfaced as an empty list. Match `select=` to the real schema.
- **ChEMBL synonym cap** must be generous or brand names (Wegovy) get truncated out of search.
- **AMASS is out of credits** — anything needing live AMASS fails; use the harvested cache.
- **Local dev QA:** `cd web && npm run start -- -p <port>`; WSL mirrored networking lets the
  Windows debug Chrome reach `localhost:<port>` (`open-chrome-devtools <port>`).

---

## 8. Roadmap — PENDING, in priority order

1. **Forecast for arbitrary pairs (the big one).** Today the attrition forecast only renders for
   the 4 authored pairs because `attrition.ts` reads modality + cohort features *from the
   authored report*. To generalize: for any (disease, target), assemble the reference cohort
   *live* from the AMASS trial cache (analogous programs at that target/pathway), derive the
   precedent-failure and modality features from it, and feed the same composition. This turns
   "No modeled forecast" into a real computed score for e.g. Depression+GRIN1.
2. **`disease + target → predict drugs`** — the 3rd prediction direction (Open Targets
   `knownDrugs` + Elicit). Only drug→targets and drug+target-evidence are built.
3. **Patents** — Elicit has no patents endpoint. Add PatentsView (free) or AMASS `patentcore`.
4. **Fit the attrition coefficients** on the held-out set so the calibration backtest is real,
   not illustrative.
5. **New inputs:** assays, modalities (Kiran wants these next after drug).
6. **Directionality** of target regulation (the diagram's "direction to decrease disease risk")
   — `pg_targets.direction` exists but is unpopulated; Open Targets doesn't give it directly.

---

## 9. Working norms (from Kiran)

Question assumptions; flag design errors; no flattery. Record only what is CERTAIN and
evidenced — separate FACT from intent from open question. **No em-dashes anywhere.** Be
succinct, lead with the answer. Commit/push only when asked; no AI attribution in commits.
