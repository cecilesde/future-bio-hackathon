# CLAUDE.md — Attritio AI

Reference-class forecaster for **drug-program attrition**. Give it a disease + a drug (and
optionally a target); it computes how likely the program is to fail before approval, decomposes
the number, assembles the reference cohort of similar programs (with real trials + why they
stopped), proposes the likely **mechanism of action** (drug → target → disease, graded by
evidence), names the failure modes, prices the cheapest kill experiment, and shows the patent +
literature landscape. A disease alone yields a ranked table of candidate drugs, each with an
attrition estimate. A drug **already approved for the queried indication** short-circuits to 0%
attrition (a fact, not a forecast).

- **Name:** the product is **Attritio AI** (renamed 2026-07-05 from "Prognosis"). The Vercel
  project, alias, and the main React component (`Prognosis.tsx`) still carry the old
  `repurpose-engine` / `Prognosis` names; only user-visible strings were changed. Do not assume a
  file/route rename happened.
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
| **Per-program trial detail** | REAL — OT clinical reports + AMASS trialcore + `pg_trials` completion dates. The dropdown now surfaces the rich AMASS fields: primary/secondary outcome measures, arms (doses/comparators), design (randomized/masking/N), acronym, "results posted" link, and admin-vs-efficacy/safety stop classification (see §5 `amass.ts` / `Swimlanes`). |
| **Patents** | REAL — live AMASS `patentcore` |
| **Literature** | REAL — live Elicit semantic search. NB the Elicit key is rate-limited (100 req/24h); when exhausted it 429s and papers come back empty (confidence is now immune to this, see §3). |
| **The attrition score + decomposition** | REAL computed number (deterministic math; LLM supplies the grounded feature inputs) |
| **Confidence grade** | REAL — computed **deterministically** by `confidenceOf` (§3) from decided-cohort size, cohort consistency, validation strength, and the drug's phase. The LLM only writes the justification, never the grade. |
| **Approved-for-indication → 0% attrition** | REAL fact: live OT `drug.indications` ("APPROVAL" stage) matched to the queried EFO, a descendant subtype, **or a cross-ontology equivalent** (the disease's `dbXRefs`, e.g. obesity MONDO_0011122 ⇄ HP_0001513 — see §8). Hard-overrides the score to 0 (see §3). |
| **Blind retrospective validation (holdback)** | REAL, opt-in per (drug, disease). Prediction-as-of-cutoff: censors the drug's own post-cutoff trials + literature, self-excludes it from its cohort, computes the precedent term deterministically from censored data (NOT LLM labels), and scores the base rate at the as-of phase. The **number** is genuinely blind; the **prose** is not (the LLM knows the history) and the banner says so. Registry in `lib/holdback.ts` (Semagacestat/Alzheimer's is the hero). See §4. |
| **Mechanism of action** (new box) | LLM-generated over the retrieved literature + patents. Causal chain drug → target → disease with a 5-level confidence grade SPECIFIC to the mechanism (unknown/unsupported → low). Grounded, not verified clinical fact. |
| **The narrative** (verdict, failure modes, modality, de-risking, bull/bear) | LLM-generated over the retrieved evidence. Grounded, not verified clinical fact. |
| **Researcher notes** | REAL, user-authored. Shared markdown notes keyed by (drug, disease) ONLY (target ignored); persist in `pg_notes`, shown to anyone who reruns the same drug + indication. Append-only, unverified authorship (no login). See §5 `NotesPanel` / `/api/notes` / `lib/notes.ts` and §6. |
| **Calibration backtest panel** | ILLUSTRATIVE — only the 4 authored demo pairs; coefficients not fitted. Omitted on live forecasts. |
| **4 authored pairs** (`obesity:GLP1R/MC4R/GPR75`, `alzheimers:BACE1`) | Hand-written reports in `pg_reports`, used as the demo default + for the calibration panel. |

**The core design rule (do not break):** the attrition NUMBER is always produced by
`attritionMath` in `web/src/lib/attrition.ts`. The LLM produces the *inputs* to that math
(grounded feature values) and the qualitative prose. The LLM never emits the probability.
The **confidence grade** is likewise deterministic (`confidenceOf`); the LLM never emits it.

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

**One unified Compute button drives all three.** The user fills any of disease/target/drug and
presses **Compute** (`runCompute` in `Prognosis.tsx`); a derived `computeMode`
(none/discovery/target/targetfree) dispatches to the right lens and a hint line states which lens
will run. The disease input accepts **free text** (type + Enter), matching the target input, so a
typed disease registers without needing an autocomplete click (this was the cause of an earlier
"disease-only shows nothing" bug). The old scattered per-panel run buttons are gone; `LiveForecastPrompt`
and `DrugDiscoveryPanel` are now result/loading displays plus a discovery "refresh".

**Approved-for-indication override applies across the forecast lenses:** if the (lead) drug is
already approved for the queried disease (or a subtype), attrition is a hard 0 and the dashboard
shows an "Approved for this indication" state instead of the decomposition (see §3).

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

**Hard-0 override (approved-for-indication).** BEFORE the five-term math runs, both adapters check
an `approvedForIndication?: boolean` flag; when true they short-circuit and return
`approvedScore(diseaseName, lead)`, i.e. `{ attrition: 0, pos: 1, approved: true, components: [one
explanatory row] }`. This is a fact (the drug already cleared approval), not a forecast, so it
replaces the decomposition. The flag is computed in `forecast.ts` from live OT data (see §4). Note
`max_phase` is the drug's GLOBAL max phase (approved for anything); it only nudges the score to
~0.13, so it is NOT a substitute for the indication-specific override. `AttritionScore` carries an
optional `approved?: boolean` that the UI (`VerdictBand`, `AttritionComposition`) branches on.

Key functions (all exported):
- `attritionMath(features)` — the ONLY place the number is computed. Both lenses call it.
- `computeAttrition({report, target, drugs, diseaseName, approvedForIndication?})`: target lens
  adapter (used client-side for the authored pairs + server-side).
- `computeAttritionTargetFree({diseaseName, drug, report, efficacyEvidence, efficacyRationale,
  efficacyLevel, approvedForIndication?})`: target-free adapter; second-term label is "Drug
  efficacy evidence".
- `approvedScore(diseaseName, lead)`: the hard-0 `AttritionScore` for an approved indication.
- `buildScore(...)` — shared `Component[]` decomposition builder (second term parameterized).
- `areaOf`, `phaseOf` — exported helpers used by the scorers.
- `confidenceOf({decided, validation, cohortFailFraction, leadMaxPhase})` → `"High"|"Moderate"|
  "Low"`: **deterministic** confidence in the ESTIMATE (not the outcome). Points for a large
  decided cohort (≥5), strong validation/efficacy (≥0.6), a consistent cohort (|failFrac−0.5|≥0.3),
  and a late-stage drug (phase ≥3). Score ≥3 High, ≥1 Moderate, else Low. It never reads the live
  literature count, so an Elicit outage cannot move it; `judge` computes it and the LLM only writes
  the justification. (Confidence = how well-anchored the number is, NOT likelihood of success — so
  an approved drug reads High-confidence AND low-attrition.)
- `computeAttritionTargetFree` also takes optional `phaseOverride?` and `cohortFailFractionOverride?`
  used by holdback mode (§4) to score the base rate as-of a cutoff phase and to feed a
  deterministic censored precedent instead of the LLM-curated cohort's fail fraction.
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
  literature, AMASS patents (`getPatents`), AMASS drug trials (`getDrugTrials`). Also computes the
  **approved-for-indication** flag: `getDrugApprovals(chemblId)` (the drug's APPROVAL indication
  ids) + `getDiseaseDescendants(efo)`, matched by `isApprovedForIndication(...)` (queried EFO or a
  descendant). Both OT lookups are cached in `pg_evidence` and credit-free.
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
  curated cohort's real death reasons + literature + patents. Runs in parallel (`Promise.all`) with
  the mechanism stage.
- **Stage 2b, mechanism of action (LLM):** `mechanismLinkage(input, papers, patents, targetSymbol?)`
  reconstructs the likely causal chain drug → target → disease from the SAME already-fetched
  literature + patents (no extra Elicit/AMASS spend), with a 5-level confidence grade specific to the
  mechanism (unknown/unsupported → "Very low"). Produces `report.mechanism` (`MechanismOfAction`).
- **Stage 3, the number (deterministic):** `computeAttrition` / `computeAttritionTargetFree`,
  passed the Stage-0 `approvedForIndication` flag (hard-0 when true).
- **Stage 4 — verdict + adversarial (LLM); confidence is deterministic:** `judge` computes the
  confidence grade with `confidenceOf` (§3) BEFORE the LLM call and only asks the LLM to justify
  that given grade (it no longer emits the grade). Also produces verdict, exit phase, bull/bear.

Output is a `ForecastResult` (`report`, `score`, `papers`, `patents`, `provenance`), rendered by
the same `report-parts.tsx` components for both lenses. `provenance.efoId` is used client-side to
key researcher notes (§5).

**Blind retrospective validation (holdback mode), `lib/holdback.ts`:** `generateForecastTargetFree`
takes an optional `HoldbackConfig` (or auto-detects one from `HOLDBACK_CASES` for a registered
drug+disease, e.g. Semagacestat/Alzheimer's cutoff 2009-12-31). Effects: (a) `censorPapers` drops
post-cutoff Elicit papers; (b) `censorTrials` drops the subject drug's post-cutoff / stop-status
trials and nulls whyStopped; (c) `censorCandidates` self-excludes the drug and temporally censors
the reference cohort; (d) the efficacy grade is computed from the censored inputs and bypasses the
shared cache; (e) `approvedForIndication` is forced false; (f) `phaseOverride` scores the base rate
at the as-of phase; (g) **the precedent term uses a deterministic `rawFailFraction` over the CENSORED
raw cohort, NOT the LLM-curated labels** — critical, because the LLM curator otherwise re-labels
post-cutoff failures from parametric knowledge (see §8). `report.holdback` drives the `HoldbackBanner`.
The number is genuinely blind; the LLM prose is NOT (unclosable) and the banner states this.

**Discovery + ranked table:** `discoverDrugs(disease)` (`lib/discover.ts`) synthesizes a candidate
list (OT disease-drugs backbone + AMASS patents + Elicit lit via Claude), resolves each to a
`pg_drugs` record, then `scoreDrugsTargetFree(disease, drugs)` computes a target-free attrition per
drug: one shared disease cohort, per-drug efficacy grade (`efficacyFor`, bounded to 6 concurrent
LLM calls, cached), a blended `efficacyScoreOf` (bucket anchor + continuous evidence so same-tier
drugs still differentiate). Ranked ascending. The full `generateForecastTargetFree` reuses the same
cached efficacy grade so the table estimate and the dashboard agree. Each candidate also gets a
per-drug **`approvedForDisease`** flag (drug-centric: `getDrugApprovals(chemblId)` matched against
the queried EFO + descendants; distinct from the drug-level `status` "approved for anything");
approved-for-disease candidates are pinned to **attrition 0**, sorted to the top, badged, and can be
hidden via the panel's "hide approved" filter (default: shown) so a user can hunt for NEW drugs.
Because approved same-class drugs otherwise share near-identical model inputs (same phase/modality/
shared cohort/all "strong" efficacy) and cluster, the 0-override is what actually spreads the table.

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
- `attrition.ts` — the attrition math + both score adapters + `confidenceOf` (§3).
- `forecast.ts` — the forecast orchestration, both lenses, discovery scoring, holdback mode (§4).
  Also owns the trial helpers: `classifyStopReason` (admin vs efficacy/safety), `sortTrials`,
  `diseaseTokens`/`trialMatchesDisease` (disease-scope AMASS-only trials), `trialKey` (dedups
  per-country EU registrations).
- `holdback.ts` — blind-mode config + registry (`HOLDBACK_CASES`, `holdbackFor`) + pure censors
  (`censorPapers`/`censorTrials`/`censorCandidates`). See §4.
- `notes.ts` — `noteKey(diseaseKey, drugKey)` sha1 for shared researcher notes (server-only).
- `opentargets.ts` — live OT GraphQL client: `resolveDisease`, `resolveTarget`, `associationFor`,
  `cohortCandidates` (target), `diseaseCohortCandidates` (disease), `drugTargets` (drug→targets via
  mechanismsOfAction), `diseaseDrugCandidates` (disease→drugs, names only), plus the approval helpers
  `drugApprovalIndications(chemblId)` (APPROVAL indication ids), `diseaseDescendants(efoId)` (**now
  returns descendants PLUS the disease's `dbXRefs` cross-ontology equivalents**, normalized `:`→`_`),
  and the pure `isApprovedForIndication(approvedIds, efoId, related)`. **Approval stage string is the
  literal `"APPROVAL"`, NOT `"PHASE_4"`.**
- `amass.ts` — AMASS runtime client: `searchPatents` (patentcore), `searchDrugTrials` (trialcore).
  Sparing (small limits, single query, graceful `[]` on 403). `searchDrugTrials` now maps the rich
  fields (outcomes, arms, design, acronym, hasResults, conditions) surfaced in the dropdown.
- `evidence.ts` — `pg_evidence` cache-through: `getPatents`, `getDrugTrials` (kind `drug_trials_v2`),
  `getDrugApprovals` / `getDiseaseDescendants` (kind `disease_descendants_v2`), plus exported
  `keyOf`/`readCache`/`writeCache` for other caches (efficacy grades, discovery lists). NB:
  `evidence.ts` imports the raw queries from `opentargets.ts` (no cycle).
- `discover.ts` — `discoverDrugs(disease)` → ranked candidate drugs (cached `discovery_v6` per disease).
- `elicit.ts` — `searchPapers(query, n)`. `predict.ts` — `predictTargets`, `checkInteraction`.
- `llm.ts` — `extract(system, user, schema, opts)`: Anthropic `claude-opus-4-8` structured output.
- `supabase.ts` — `restQuery()` PostgREST fetch with the anon key (NOT `@supabase/supabase-js`;
  its realtime WS breaks on Node 20). Does NOT url-encode — encode path values yourself.
- `forecast-cache.ts` — `forecast_cache` helpers: `forecastCacheKey`, `drugKeyOf`,
  `readForecastCache`, `writeForecastCache`, `SCHEMA_VERSION` (currently **v14**; bump on report
  shape changes so stale rows miss).
- `server-data.ts` — builds the typed data objects `app/page.tsx` serves from Supabase.
- `data.ts` / `types.ts` — authored reports + the domain model (incl. the `Note` type + `MAX_NOTE_*`).

### web/src/app/api routes
- `/api/forecast` — target-based forecast (body `{disease, target, drugs}`; 400 without a target).
  `maxDuration=300`. Cache-through `forecast_cache`.
- `/api/forecast-by-drug` — target-free forecast (body `{disease, drug}`). `maxDuration=300`.
  Cache key uses a `_DRUGFREE_` sentinel target slot. Returns `+ drugTargets` (context). Auto-applies
  holdback for a registered drug+disease (§4).
- `/api/discover-drugs` — disease → ranked candidate drugs (body `{disease}`). `maxDuration=300`.
- `/api/notes` — shared researcher notes. **GET** `?diseaseId=&diseaseName=&drugChembl=&drugName=`
  lists notes (anon read); **POST** creates one (service-role write). Key computed server-side by
  `noteKey`; target is not part of the key.
- `/api/predict` — predict-the-third (Claude+Elicit). `/api/drugs|diseases|targets` — type-aheads.

### web/src/components
`Shell` (Forecast / Trial-landscape tabs) → `Prognosis` (3 inputs + unified **Compute** button that
dispatches by lens + discovery panel + live/target-free render; passes `noteContext` to `ReportView`).
`PickerInput` (disease/target type-ahead, both now `allowFreeText`), `DrugInput` (multi-select),
`PredictionPanel` (predict-the-third), `DrugDiscoveryPanel` (disease-only ranked table + "hide
approved" filter + per-disease approved badge), `Swimlanes` (expandable per-program survival chart;
the per-trial dropdown shows the rich AMASS detail + muted admin stops), `NotesPanel` (shared
markdown notes, above Publications, only when a drug is in the query), `report-parts` (verdict,
attrition composition, **mechanism of action**, failure modes, modality, adversarial, de-risking,
literature, patents, calibration, **`HoldbackBanner`**). `VerdictBand` and `AttritionComposition`
render an "Approved for this indication" state when `score.approved`. `TrialLandscape`.

---

## 6. Supabase (`pg_*` tables + caches, project `vkcendblgzjxvxsufldw`)

Read via PostgREST + anon key; writes via the service-role key (server-only).
- `pg_diseases`, `pg_targets`, `pg_reports` (4 authored), `pg_literature`, `pg_drugs`,
  `pg_disease_terms`, `pg_trials` (43k harvested AMASS trials, disease-mapped, **no drug column**),
  `pg_trial_disease`, `pg_trial_disease_stats`, `pg_trial_meta`.
- **`forecast_cache`** — whole-forecast cache keyed by `sha1(SCHEMA_VERSION|disease|target|drugKey)`.
  Columns incl. `report/score/papers/patents/provenance` jsonb. Anon read (RLS), service-role write.
  `SCHEMA_VERSION` is currently **v14** (bumped repeatedly this session: v8 holdback, v9 disease-scoped
  trials, v10 EU dedup, v11 rich trial fields, v12 refetch, v13 xref approval bridge, v14 deterministic
  confidence).
- **`pg_evidence`** — generic cache-through (`cache_key, kind, ref, items`). Kinds: `patents`,
  `drug_trials_v2` (was `drug_trials`; v2 added the rich AMASS fields), `efficacy` (per drug+disease
  grade), `discovery_v6` (ranked drug list per disease), `drug_approvals` (a drug's APPROVAL
  indication ids, by chemblId), `disease_descendants_v2` (subtype EFO ids **+ dbXRefs equivalents**,
  by efoId). This is what keeps AMASS/Elicit/LLM/OT spend to once-per-query. Anon read, service-role
  write. The mechanism-of-action object is NOT a separate kind: it rides inside the cached
  `forecast_cache` report. **When a mapped shape changes, bump the kind suffix (e.g. `_v2`) or the
  fix is hidden behind stale cached rows.**
- **`pg_notes`** — shared researcher notes (append-only, one row per note). Columns: `id`,
  `note_key` (`sha1((efoId||disease)|(chembl||drug))`, indexed), `disease_id`, `disease_name`,
  `drug_key`, `drug_name`, `author` (nullable, unverified), `body` (markdown), `created_at`. Anon
  SELECT via RLS policy `pg_notes_anon_read`; INSERT only via the service-role key (bypasses RLS).
  NOT keyed by target and NOT tied to `SCHEMA_VERSION`, so notes persist across cache bumps.

To create/alter tables use the Supabase MCP `apply_migration` (project id above) or the CLI.

---

## 7. Data sources & API keys (all server-side; never `NEXT_PUBLIC_`)

| Source | Key | Notes |
|---|---|---|
| Open Targets GraphQL | none | `api.platform.opentargets.org`. Live. `drugAndClinicalCandidates` exists on BOTH `target` and `disease`; `drug(chemblId).mechanismsOfAction` gives drug→targets. |
| ChEMBL / `pg_drugs` | none | drug universe + `search_blob` (name+synonyms) for name→record resolution. |
| **AMASS** | `AMASS_API_KEY` | **BACK IN CREDITS** (new key, this session). `api.amass.tech/api/v1/cores/{core}/records`. Cores used: `patentcore`, `trialcore`. Rate limit 60/min, `limit`≤300, no pagination. BE SPARING (single queries, cached in `pg_evidence`). |
| Elicit | `ELICIT_API_KEY` | `elicit.com/api/v1`. Papers + trials. No patents. **Rate-limited: 100 requests / 24h**; when exhausted it returns HTTP 429 and `searchPapers` yields `[]`. Live forecasts still work (literature panel empties, mechanism weakens); the deterministic number + confidence are unaffected. Pre-warm demo forecasts so they serve from cache. |
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
- **Cache invalidation:** bump `SCHEMA_VERSION` (forecast-cache, now **v14**) or the `pg_evidence`
  kind suffix (e.g. `discovery_v6`, `drug_trials_v2`, `disease_descendants_v2`) whenever the cached
  shape or scoring changes, else stale rows hide the fix. VERIFIED trap this session: adding rich
  AMASS trial fields did nothing until BOTH the per-drug `drug_trials` kind AND the whole-forecast
  `SCHEMA_VERSION` were bumped.
- **Approved-for-indication needs cross-ontology matching.** The disease-name search resolves to one
  ontology node (usually MONDO/EFO), but a drug's APPROVAL indication is often filed under a DIFFERENT
  node for the same concept (obesity resolves to MONDO_0011122 "obesity disorder", but semaglutide's
  obesity approval is under HP_0001513 "Obesity"). They are not in a descendant relationship, so a
  descendants-only match missed real approvals. `diseaseDescendants` now also returns the disease's
  `dbXRefs` (normalize `HP:0001513`→`HP_0001513`) so equivalents match.
- **Data holdback does NOT blind an LLM step.** Censoring the cohort data did not blind the precedent
  term, because the LLM cohort-curator re-labels post-cutoff failures (solanezumab, etc.) as "Failed"
  from parametric knowledge. Any value that must be as-of-cutoff has to be computed DETERMINISTICALLY
  from censored data (holdback uses `rawFailFraction` over censored candidates), never via an LLM.
- **Target-free results silently not rendering:** the render compares a stored `subjectKey` against a
  recomputed one; they must be built identically. A stale `_DRUGFREE_` sentinel in the stored key (vs
  an empty `symbol` in the compare key) made `liveForCurrent` always null — a 200 response with no UI
  and no console error. Store and compare keys with the same formula.
- **`open-chrome-devtools` / local `npm run dev` do not survive this sandbox** (background tasks get
  killed). Verify UI by deploying and driving the prod URL with the chrome-devtools MCP (port 9333),
  or run logic via a `tsx` script (`web/scripts/*.ts`).
- **`restQuery` does not URL-encode.** Encode `ilike`/`in` values yourself (but leave `*` wildcards).
- **`vercel deploy` ≠ git push.** Deploy uploads the working dir (live); push is the backup. Do both.
- **`@supabase/supabase-js` breaks on Node 20** (realtime WS) — use REST `fetch` (already done).
- **AMASS name collisions:** OT/AMASS may list an unrelated drug under the same name (e.g. two
  "AV-101"). The cohort trials attach whatever OT/AMASS links; accept it (source ground truth).
- **OT approval stage string is `"APPROVAL"`, not `"PHASE_4"`.** The per-indication field is
  `maxClinicalStage` (a String). A dead `/PHASE_?4/i` regex in `discover.ts` silently never matched,
  leaving approved-for-disease detection broken (approved drugs showed ~14% instead of 0%). Match on
  `=== "APPROVAL"` / `/APPROVAL/i`.
- **`max_phase` is drug-GLOBAL, not indication-specific.** A drug approved for anything has
  `max_phase=4`, which only nudges attrition to ~0.13. "Approved for THIS disease" must come from
  `drug.indications` (per-indication APPROVAL) matched against the queried EFO **plus its
  descendants** (`disease.descendants`), so a subtype approval (e.g. major depressive disorder)
  counts for a broader query (depression). Ancestor approvals do NOT count.
- **The approved-for-indication 0 is a deterministic override, not a model output.** It short-circuits
  in the adapters (`approvedScore`); `attritionMath` never returns 0 for an approved drug on its own.
- **Mixing `??` and `||` needs parens** or Turbopack fails the build ("Nullish coalescing operator
  requires parens when mixing with logical operators"). Write `a ?? (b || c)`.

---

## 9. Roadmap — PENDING

1. **Fit the attrition coefficients** on a held-out set so the calibration backtest is real, not
   illustrative. This is the biggest remaining credibility gap.
2. **Promote the frozen `data/cache/` to Supabase** (`pg_drug_trials` etc.) so the 43k-trial corpus
   becomes drug-queryable and the corpus self-accretes from runtime AMASS queries (credit-free from
   the local cache; runtime accretion is the Part F design in `docs/agentic-forecast-plan.md`).
3. **Within-tier differentiation.** Drugs approved for the queried disease are now hard-pinned to 0%
   (and filterable), which resolves the old "all approved drugs cluster at ~14%" problem. Remaining
   differentiation work is among the NON-approved candidates (still somewhat compressed because they
   share the base rate + shared disease cohort); fold in each drug's own trial count/recency for more
   spread if wanted.
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
