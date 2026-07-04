# CLAUDE.md — Prognosis

Reference-class forecaster for **drug-program attrition**. Give it a disease + a drug (and
optionally a target); it computes how likely the program is to fail before approval, decomposes
the number, assembles the reference cohort of similar programs (with real trials + why they
stopped), names the failure modes, prices the cheapest kill experiment, and shows the patent +
literature landscape. A disease alone yields a ranked table of candidate drugs, each with an
attrition estimate.

- **Live:** https://repurpose-engine-wine.vercel.app (Vercel project `repurpose-engine`, account
  `kirangathanis-projects`, alias points at the latest prod deploy).
- **Repo:** GitHub `kirangathani/future-bio-hackathon`, branch `main`.
- Read this file fully before editing. It is the single source of truth for a fresh instance.

---

## 1. What is REAL vs ILLUSTRATIVE

| Piece | Status |
|---|---|
| **Targets for a disease** | REAL — live Open Targets association scores + evidence |
| **Drug universe** (type-ahead) | REAL — ~16.7k ChEMBL approved + experimental (`pg_drugs`) |
| **Disease universe** (type-ahead) | REAL — AMASS MeSH conditions (`pg_disease_terms`) |
| **Reference cohort** (swimlanes) | REAL — live Open Targets `drugAndClinicalCandidates` + AMASS trials |
| **Per-program trial detail** | REAL — OT clinical reports + AMASS trialcore + `pg_trials` completion dates |
| **Patents** | REAL — live AMASS `patentcore` |
| **Literature** | REAL — live Elicit semantic search |
| **The attrition score + decomposition** | REAL computed number (deterministic math; LLM supplies the grounded feature inputs) |
| **The narrative** (verdict, failure modes, modality, de-risking, bull/bear) | LLM-generated over the retrieved evidence. Grounded, not verified clinical fact. |
| **Calibration backtest panel** | ILLUSTRATIVE — only the 4 authored demo pairs; coefficients not fitted. Omitted on live forecasts. |
| **4 authored pairs** (`obesity:GLP1R/MC4R/GPR75`, `alzheimers:BACE1`) | Hand-written reports in `pg_reports`, used as the demo default + for the calibration panel. |

**The core design rule (do not break):** the attrition NUMBER is always produced by
`attritionMath` in `web/src/lib/attrition.ts`. The LLM produces the *inputs* to that math
(grounded feature values) and the qualitative prose. The LLM never emits the probability.

---

## 2. Two forecast lenses

The app forecasts from any of these input combinations:

1. **Disease + target (+ optional drug)** → **target-based** forecast. "How will this target
   fail." Reference cohort = programs hitting that target; validation term = the target's
   Open Targets genetic association to the disease. Entry: `generateForecast()` →
   `/api/forecast`. The 4 authored pairs render their hand-written report instead of computing.
2. **Disease + drug, no target** → **target-free** forecast. Attrition is a property of a
   drug-program aimed at an indication, not of a target. Reference cohort = programs developed
   for the **disease**; validation term = the **drug's own efficacy evidence** in the disease
   (its trials + literature, graded by an LLM). Entry: `generateForecastTargetFree()` →
   `/api/forecast-by-drug`. No target is selected; the drug's mechanism targets are shown only
   as context.
3. **Disease alone** → **discovery**: mine Open Targets disease-drugs + AMASS patents + Elicit
   literature for candidate drugs, compute a target-free attrition per drug, present a **ranked
   table** (lowest attrition first). Selecting a drug runs the full target-free forecast (#2).
   Entry: `discoverDrugs()` → `/api/discover-drugs`; selection → `/api/forecast-by-drug`.

There is also a **predict-the-third** panel (`/api/predict`, `lib/predict.ts`): drug+disease →
predict the drug's targets from literature; drug+target → check the interaction has literature
support. This is a helper, not the forecast.

(There was a "target tournament" — pick a drug's best target by lowest attrition — it was
**removed** and replaced by lens #2. Do not reintroduce it; it favoured under-studied targets.)

---

## 3. The attrition model (`web/src/lib/attrition.ts`)

`attrition = 1 − PoS`, `logit(PoS) = logit(base_rate) + Σ ln(OR)`. Five terms:

1. **Base rate** — P(approval | phase, therapeutic area). Area from a disease-name regex, phase
   from the lead drug's `max_phase`. (Wong/Siah/Lo 2019.) Drug+disease property.
2. **Validation** OR — *target lens:* genetic association (Open Targets, Nelson 2015).
   *Target-free lens:* **drug efficacy evidence** 0-1. Same OR formula, different input + label.
3. **Modality feasibility** OR — from the modality-feasibility score (drug type).
4. **Reference-class precedent** OR — cohort failure fraction. *Target lens:* the target's
   cohort. *Target-free lens:* the disease's cohort.
5. **Drug track record** OR — from the lead drug's `max_phase`.

Key functions (all exported):
- `attritionMath(features)` — the ONLY place the number is computed. Both lenses call it.
- `computeAttrition({report, target, drugs, diseaseName})` — target lens adapter (byte-identical
  to its pre-refactor output; used client-side for the authored pairs + server-side).
- `computeAttritionTargetFree({diseaseName, drug, report, efficacyEvidence, efficacyRationale,
  efficacyLevel})` — target-free adapter; second-term label is "Drug efficacy evidence".
- `buildScore(...)` — shared `Component[]` decomposition builder (second term parameterized).
- `areaOf`, `phaseOf` — exported helpers used by the scorers.
- Coefficients are **literature point estimates, NOT fitted.** Fitting on a held-out set is
  pending (roadmap). The UI says so.

---

## 4. The forecast pipeline (`web/src/lib/forecast.ts`)

Both `generateForecast` (target) and `generateForecastTargetFree` (drug+disease) share stages.
`ForecastInput` has an optional `subject?: {kind:"drug", drugName}` — **absent = target lens
(prompts reproduce the original literals byte-identically); present = target-free lens.**

Stages:
- **Stage 0 (deterministic):** resolve disease→EFO / target→Ensembl; assemble in parallel:
  cohort candidates (`cohortCandidates(ensembl)` OR `diseaseCohortCandidates(efo)`), Elicit
  literature, AMASS patents (`getPatents`), AMASS drug trials (`getDrugTrials`).
- **Stage 1 — cohort curation (LLM):** `curateCohort` selects/annotates real programs from the
  raw candidates (schema forbids inventing; each row carries a provenance `drugId`). Then
  `attachTrials` joins ground-truth OT trial reports back to each program (+ `pg_trials`
  completion dates by NCT id), and `enrichCohortWithAmass` pings AMASS `trialcore` per program
  to fill why-stopped / summary / enrollment and add AMASS-only trials. Trials capped 15/program,
  stoppage reasons first.
- **Validation input:** *target lens:* `associationFor(ensembl, efo)`. *Target-free lens:*
  `efficacyFor(drug, disease)` → an LLM efficacy grade (strong/moderate/weak/none + continuous
  0-1 evidence), cached per (drug, disease) in `pg_evidence`.
- **Stage 2 — modality + failure modes + de-risking (LLM):** `modalityAndRisks`, grounded in the
  curated cohort's real death reasons + literature + patents.
- **Stage 3 — the number (deterministic):** `computeAttrition` / `computeAttritionTargetFree`.
- **Stage 4 — verdict + confidence + adversarial (LLM):** `judge`. Confidence from an
  evidence-density rubric + a self-refutation pass.

Output is a `ForecastResult` (`report`, `score`, `papers`, `patents`, `provenance`), rendered by
the same `report-parts.tsx` components for both lenses.

**Discovery + ranked table:** `discoverDrugs(disease)` (`lib/discover.ts`) synthesizes a candidate
list (OT disease-drugs backbone + AMASS patents + Elicit lit via Claude), resolves each to a
`pg_drugs` record, then `scoreDrugsTargetFree(disease, drugs)` computes a target-free attrition per
drug: one shared disease cohort, per-drug efficacy grade (`efficacyFor`, bounded to 6 concurrent
LLM calls, cached), a blended `efficacyScoreOf` (bucket anchor + continuous evidence so same-tier
drugs still differentiate). Ranked ascending. The full `generateForecastTargetFree` reuses the same
cached efficacy grade so the table estimate and the dashboard agree.

---

## 5. Stack & where things live

- **web/** — Next.js 16 (App Router, Turbopack, Tailwind v4, IBM Plex fonts). Deployed to Vercel.
  Deploy: `cd web && npx vercel deploy --prod --yes` (uploads the working dir; NOT git-triggered).
  Page is `force-dynamic`. Local QA: `npm run start -- -p <port>` + `open-chrome-devtools <port>`.
- **pipeline/** — Python data loaders (repo `.venv`). Populate the `pg_*` tables offline.
- **data/cache/** — the frozen AMASS harvest (per-drug trials/regulatory, drugcore MoA, genes).
  Gitignored, local-only. 271 resolved drugs. NOT in Supabase (drug→trial link lives only here).
- **data/seed/** — tracked seeds (`forecast.json` = authored reports; `trial-distribution.json`).

### web/src/lib modules
- `attrition.ts` — the attrition math + both score adapters (§3).
- `forecast.ts` — the forecast orchestration, both lenses, discovery scoring (§4).
- `opentargets.ts` — live OT GraphQL client: `resolveDisease`, `resolveTarget`, `associationFor`,
  `cohortCandidates` (target), `diseaseCohortCandidates` (disease), `drugTargets` (drug→targets via
  mechanismsOfAction), `diseaseDrugCandidates` (disease→drugs, names only).
- `amass.ts` — AMASS runtime client: `searchPatents` (patentcore), `searchDrugTrials` (trialcore).
  Sparing (small limits, single query, graceful `[]` on 403).
- `evidence.ts` — `pg_evidence` cache-through: `getPatents`, `getDrugTrials` (each AMASS query
  spends a credit at most once), plus exported `keyOf`/`readCache`/`writeCache` for other caches
  (efficacy grades, discovery lists).
- `discover.ts` — `discoverDrugs(disease)` → ranked candidate drugs (cached per disease).
- `elicit.ts` — `searchPapers(query, n)`. `predict.ts` — `predictTargets`, `checkInteraction`.
- `llm.ts` — `extract(system, user, schema, opts)`: Anthropic `claude-opus-4-8` structured output.
- `supabase.ts` — `restQuery()` PostgREST fetch with the anon key (NOT `@supabase/supabase-js`;
  its realtime WS breaks on Node 20). Does NOT url-encode — encode path values yourself.
- `forecast-cache.ts` — `forecast_cache` helpers: `forecastCacheKey`, `drugKeyOf`,
  `readForecastCache`, `writeForecastCache`, `SCHEMA_VERSION` (currently **v5**; bump on report
  shape changes so stale rows miss).
- `server-data.ts` — builds the typed data objects `app/page.tsx` serves from Supabase.
- `data.ts` / `types.ts` — authored reports + the domain model.

### web/src/app/api routes
- `/api/forecast` — target-based forecast (body `{disease, target, drugs}`; 400 without a target).
  `maxDuration=300`. Cache-through `forecast_cache`.
- `/api/forecast-by-drug` — target-free forecast (body `{disease, drug}`). `maxDuration=300`.
  Cache key uses a `_DRUGFREE_` sentinel target slot. Returns `+ drugTargets` (context).
- `/api/discover-drugs` — disease → ranked candidate drugs (body `{disease}`). `maxDuration=300`.
- `/api/predict` — predict-the-third (Claude+Elicit). `/api/drugs|diseases|targets` — type-aheads.

### web/src/components
`Shell` (Forecast / Trial-landscape tabs) → `Prognosis` (3 inputs + discovery panel + live/target-
free render). `PickerInput` (disease/target type-ahead), `DrugInput` (multi-select), `PredictionPanel`
(predict-the-third), `DrugDiscoveryPanel` (disease-only ranked table), `Swimlanes` (expandable
per-program survival chart with outcome badges + trial detail), `report-parts` (verdict, attrition
composition, failure modes, modality, adversarial, de-risking, literature, patents, calibration),
`TrialLandscape`.

---

## 6. Supabase (`pg_*` tables + caches, project `vkcendblgzjxvxsufldw`)

Read via PostgREST + anon key; writes via the service-role key (server-only).
- `pg_diseases`, `pg_targets`, `pg_reports` (4 authored), `pg_literature`, `pg_drugs`,
  `pg_disease_terms`, `pg_trials` (43k harvested AMASS trials, disease-mapped, **no drug column**),
  `pg_trial_disease`, `pg_trial_disease_stats`, `pg_trial_meta`.
- **`forecast_cache`** — whole-forecast cache keyed by `sha1(SCHEMA_VERSION|disease|target|drugKey)`.
  Columns incl. `report/score/papers/patents/provenance` jsonb. Anon read (RLS), service-role write.
- **`pg_evidence`** — generic cache-through (`cache_key, kind, ref, items`). Kinds: `patents`,
  `drug_trials`, `efficacy` (per drug+disease grade), `discovery_v4` (ranked drug list per disease).
  This is what keeps AMASS/Elicit/LLM spend to once-per-query. Anon read, service-role write.

To create/alter tables use the Supabase MCP `apply_migration` (project id above) or the CLI.

---

## 7. Data sources & API keys (all server-side; never `NEXT_PUBLIC_`)

| Source | Key | Notes |
|---|---|---|
| Open Targets GraphQL | none | `api.platform.opentargets.org`. Live. `drugAndClinicalCandidates` exists on BOTH `target` and `disease`; `drug(chemblId).mechanismsOfAction` gives drug→targets. |
| ChEMBL / `pg_drugs` | none | drug universe + `search_blob` (name+synonyms) for name→record resolution. |
| **AMASS** | `AMASS_API_KEY` | **BACK IN CREDITS** (new key, this session). `api.amass.tech/api/v1/cores/{core}/records`. Cores used: `patentcore`, `trialcore`. Rate limit 60/min, `limit`≤300, no pagination. BE SPARING (single queries, cached in `pg_evidence`). |
| Elicit | `ELICIT_API_KEY` | `elicit.com/api/v1`. Papers + trials. No patents. |
| Anthropic | `ANTHROPIC_API_KEY` | Claude `claude-opus-4-8`, official SDK, structured outputs. |
| Supabase | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | anon for reads, service-role for cache writes. |

Keys live in **root `.env`** (pipeline) and **`web/.env.local` + Vercel** (web app). The web app
had the OLD out-of-credits AMASS key + an empty service-role key at various points — if AMASS or
cache-writes silently no-op, **check the key VALUE (length), not just presence**, in all three
places (root `.env`, `web/.env.local`, `vercel env`). The current working AMASS key + service-role
key are synced across all three.

---

## 8. Gotchas (learned the hard way this session — don't repeat)

- **Open Targets disease-row has NO `diseases` field** (the target-row does). Querying it on the
  disease `drugAndClinicalCandidates` is a GraphQL error → `post()` throws → cohort silently empties.
  `opentargets.ts` uses two selections (`TARGET_ROWS` vs `DISEASE_ROWS`), one shared mapper.
- **4-bucket efficacy collapse flattens the ranked table** (all approved drugs graded "strong" →
  identical). Fixed by blending the bucket with the model's continuous 0-1 evidence (`efficacyScoreOf`).
  If a ranking looks flat within a tier, that's the cause.
- **Backticks in `git commit -m` bodies get shell-substituted** (``the `x` field`` runs `x`). Avoid
  backticks in commit messages, or use a file.
- **Stale browser bundle after deploy.** The document is `no-store`, but an open tab keeps the old
  JS. If the UI shows old behaviour after a deploy, hard-refresh. To confirm the deploy is live,
  grep the served `/_next/static/chunks/*.js` for a new string.
- **Cache invalidation:** bump `SCHEMA_VERSION` (forecast-cache) or the `pg_evidence` kind suffix
  (e.g. `discovery_v4`) whenever the cached shape or scoring changes, else stale rows are served.
- **`restQuery` does not URL-encode.** Encode `ilike`/`in` values yourself (but leave `*` wildcards).
- **`vercel deploy` ≠ git push.** Deploy uploads the working dir (live); push is the backup. Do both.
- **`@supabase/supabase-js` breaks on Node 20** (realtime WS) — use REST `fetch` (already done).
- **AMASS name collisions:** OT/AMASS may list an unrelated drug under the same name (e.g. two
  "AV-101"). The cohort trials attach whatever OT/AMASS links; accept it (source ground truth).

---

## 9. Roadmap — PENDING

1. **Fit the attrition coefficients** on a held-out set so the calibration backtest is real, not
   illustrative. This is the biggest remaining credibility gap.
2. **Promote the frozen `data/cache/` to Supabase** (`pg_drug_trials` etc.) so the 43k-trial corpus
   becomes drug-queryable and the corpus self-accretes from runtime AMASS queries (credit-free from
   the local cache; runtime accretion is the Part F design in `docs/agentic-forecast-plan.md`).
3. **Within-tier differentiation for approved drugs** is modest (they all cleared approval, so little
   attrition remains) — the ranked table is most informative when the candidate set includes
   experimental drugs. Fold in each drug's own trial count/recency if more spread is wanted.
4. **Directionality** of target regulation (`pg_targets.direction` unpopulated).
5. **Assays / modalities** as first-class inputs (Kiran wanted these).

`docs/agentic-forecast-plan.md` holds the fuller architecture rationale + the Part F (AMASS
accretion) and patents design, kept up to date through this session.

---

## 10. Working norms (from Kiran)

Question assumptions; flag design errors; no flattery. Record only what is CERTAIN and evidenced —
separate FACT from intent from open question. **No em-dashes anywhere** (prose, code, commits). Be
succinct, lead with the answer. Commit/push only when asked; no AI attribution in commits. Prefer
the robust path over the fastest fragile MVP (AI-speed makes robustness cheap). When something is
deployed but unverified, say so.
