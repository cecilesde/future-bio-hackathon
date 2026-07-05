# Runtime Agentic Forecast — Plan

Goal: for any user-supplied (disease, target, drug), compute the full forecast dashboard
at runtime, the way `obesity:GLP1R`, `obesity:MC4R`, `obesity:GPR75`, `alzheimers:BACE1`
are shown today. That dashboard is: Total Attrition Risk, Failure Modes, LLM Confidence,
Output Rationale, De-risking Opportunities, and the Mathematical Decomposition of the score.

This doc separates **FACT** (current state, read from the code) from **PROPOSAL** (design to
debate). Read Part A before Part C.

> **NOTE (2026-07-05):** this is a design/history doc; Parts A-F are the original plan and are now
> partly superseded. For the CURRENT architecture, read the repo-root **`CLAUDE.md`** (single source
> of truth). **Part H** at the bottom records what shipped after Part G (target-free lens, disease-only
> discovery, unified Compute button, mechanism-of-action box, approved-for-indication 0% override, and
> the rename to **Attritio AI**). AMASS is back in credits (Part A6's "out of credits" is stale).

---

## Part A — Current backend infrastructure (FACT)

### A1. Serving layer
- `web/` Next.js 16 App Router, deployed to Vercel, `page.tsx` is a Server Component with
  `force-dynamic`.
- On each page load, `page.tsx` reads four things from Supabase over PostgREST
  (`lib/supabase.ts restQuery`, deliberately not `@supabase/supabase-js`): diseases+targets,
  authored reports, per-pair literature, trial distribution.
- Type-ahead API routes (`/api/drugs`, `/api/diseases`, `/api/targets`) query Supabase.
- `/api/predict` is the only route that calls an LLM live (`maxDuration=60`).

### A2. Persistence — Supabase `pg_*` tables (all precomputed offline)
Everything the UI serves is loaded ahead of time by `pipeline/load_prognosis.py`, not computed
at request time:
- `pg_diseases`, `pg_targets` (Open Targets associations + `modeled` flag), `pg_reports`
  (the 4 authored forecast JSON blobs), `pg_literature` (Elicit papers for the 4 pairs),
  `pg_trials` (43,284 AMASS trials, deduped), `pg_trial_disease` (trial → area/disease),
  `pg_trial_disease_stats`, `pg_trial_meta`, `pg_drugs` (16,784 ChEMBL), `pg_disease_terms`.

### A3. What is computed at runtime today vs precomputed
- **Runtime:** only the attrition decomposition math (`lib/attrition.ts`, pure TS, runs in the
  client component per selection) and the `/api/predict` LLM call.
- **Precomputed / authored:** the entire forecast narrative. The 4 reports in `pg_reports` are
  hand-written (`lib/data.ts` → `data/seed/forecast.json` → loader). For any other pair the UI
  renders the `NotModeled` placeholder (`Prognosis.tsx` `getReport` returns null → `NotModeled`).

### A4. The one live agentic path — `lib/predict.ts`
Official Anthropic SDK, `claude-opus-4-8`, structured outputs (`output_config.format.json_schema`,
`effort: "low"`). Two directions only:
- `predictTargets(drug, disease)`: Elicit `searchPapers` (8 abstracts) → Claude extracts the
  targets the drug acts through, each with `evidence: strong|moderate|weak`.
- `checkInteraction(drug, target)`: Elicit search → Claude judges whether literature supports the
  interaction (`hasEvidence`, `confidence`, `verdict`, `mechanism`).

It does **not** produce a forecast. It is a single-shot extract/judge, not an orchestrated agent,
and has no tools beyond the one Elicit call baked into each function.

### A5. The attrition math and why it is locked to the 4 pairs (FACT)
`computeAttrition({ report, target, drugs, diseaseName })` works in log-odds space:
`logit(PoS) = logit(base) + Σ ln(OR)`, `attrition = 1 − PoS`. Five terms:
1. **Base rate** `BASE_RATE[area][phase]` — area from a regex on the disease name; phase from the
   lead selected drug's `max_phase`. (Wong/Siah/Lo 2019.)
2. **Genetic support OR** — from `target.association` (Open Targets). *Live-derivable.*
3. **Modality feasibility OR** — from `report.modality.overall`. **Authored.**
4. **Reference-class precedent OR** — from `cohortFailFraction(report.cohort)`. **Authored.**
5. **Drug track-record OR** — from lead `max_phase`. *Live-derivable.*

Terms 3 and 4 read fields that exist only inside a hand-written `Report`. That, not the math, is
the blocker: **the math is already general; its two cohort/modality inputs are not.**

### A6. External sources and status (FACT)
- Open Targets GraphQL (no key, live): `associated_targets`, `resolve_target`, `association_for`.
  Does **not** yet call `knownDrugs` (drugs at a target).
- ChEMBL REST (no key): drug universe, already loaded.
- Elicit (key, Pro): papers + trials semantic search. No patents.
- Anthropic (key): `claude-opus-4-8`.
- **AMASS: out of credits.** Anything needing live AMASS fails. The harvest is frozen.

### A7. The frozen AMASS cache — the asset that makes target-matched cohorts possible (FACT)
`data/cache/` (gitignored, local-only, ~157MB) holds more than the 43k disease-mapped trials in
Supabase:
- `drugcore.json` — 271 resolved drugs, each with `mechanismsOfAction` → **drug → target
  symbol(s)**, plus `drugType`, `maxClinicalStage`, SMILES.
- `trials/<slug>.json` — 265 per-drug trial files (phase, status, conditions, sponsor, dates).
- `regulatory/<slug>.json` — approvals per drug (the outcome labels).
- `genes.json` — per-target tractability/constraint/safety priors.

**Key fact:** the drug→target→trials→approval linkage needed to build a *target-matched
reference cohort* exists in this local cache but is **not in Supabase**. `pg_trials` is mapped by
disease/area only, with no target or mechanism column. So today nothing in the serving path can
answer "which programs hit this target, and how did they end."

---

## Part B — The precise gap

To turn `NotModeled` into a live forecast for an arbitrary pair, the backend must synthesise, per
request, the inputs the UI + math currently read from an authored `Report`:

| Needed field | Feeds | Today | Live source |
|---|---|---|---|
| `modality.overall` + axes | attrition term 3, Modality panel | authored | drug `drugType`/SMILES + genecore tractability + LLM |
| `cohort[]` (matched programs, outcomes) | attrition term 4, Swimlanes | authored | AMASS cache by target/MoA (or OT knownDrugs) |
| `failureModes[]` | Failure Modes panel | authored | cohort + literature + LLM |
| `verdict`, `confidence`, `confidenceReason` | Verdict band | authored | LLM over assembled evidence |
| `bull`/`bear` | Adversarial panel | authored | LLM |
| `derisking[]` | De-risking panel | authored | LLM, keyed to failure modes |
| `calibration` | Calibration panel | authored/illustrative | genuinely needs a fitted model + held-out set (Part D4) |

Terms 1, 2, 5 of the math already work live. The build is: assemble the evidence, derive 3 and 4
from it, and generate the narrative fields, all grounded in retrieved evidence rather than authored.

---

## Part C — PROPOSAL: target-state backend + agentic model

### C0. The one design principle to agree first
**Keep the number deterministic; let the model produce the number's inputs and the prose, never the
number itself.**

The "Mathematical Decomposition" is the product's credibility. If an LLM emits the final attrition
probability, the decomposition becomes post-hoc narration and every term is unfalsifiable. Instead:
- `attrition.ts` (or a server port of it) stays the **sole** computer of PoS/attrition.
- The agent's job is to produce **evidence-grounded feature values** (association already live;
  modality feasibility 0–1; cohort failure fraction from real matched programs; drug track record)
  each with citations, plus the **qualitative** report sections.
- Every numeric feature the agent supplies carries its source rows. The decomposition then shows
  `term = f(feature)` with the feature's provenance. This matches the house rule: record only what
  is evidenced, and separate fact from inference.

If we later disagree and want the LLM to adjust the score, do it as an explicit, bounded, logged
"analyst override OR" term in the same log-odds sum, never as a replacement of the computation.

### C1. Runtime request flow (proposed)
New route `POST /api/forecast` (`maxDuration` 120–300s, Fluid Compute), body `{disease, target,
drug[]}`. Because a full agentic run is slow and costly, it is a **cache-through**:

```
request (disease,target,drug-set)
   │  hash → forecast_cache lookup (Supabase)
   ├─ hit  → return cached Report (+ recompute math live so drug edits stay instant)
   └─ miss → run the agent → persist Report to cache → return
```

Split the fast path from the slow path: the **math** (terms 1–5) is cheap and must stay
interactive on every drug/target tweak (keep it client-side as now). The **evidence assembly +
narrative** is the slow agent, cached per (disease, target) and reused across drug edits (drug only
moves base rate + track-record OR, which the client already recomputes).

### C2. Evidence assembly layer (deterministic tools the agent calls)
Before any LLM reasoning, gather structured evidence. These are plain functions/tools, not model
calls:
1. `otAssociation(disease, target)` — association + datatype breakdown (exists).
2. `otKnownDrugs(target)` — **new**: Open Targets `knownDrugs` → drugs at the target, phase,
   indication. Live, no key. This is the primary cohort source now that AMASS is dry.
3. `cohortFromCache(target, disease)` — **new**: query the promoted AMASS cache (see C4) for
   programs hitting this target/MoA, with phase reached, status, sponsor, approval. This is the
   real reference class; `otKnownDrugs` backfills where the cache is thin.
4. `literature(disease, target)` — Elicit `searchPapers` (exists).
5. `drugFeatures(drug)` — ChEMBL/drugcore: `drugType`, `maxClinicalStage`, SMILES → modality class
   and a first-pass developability prior.
6. `genecore(target)` — tractability/constraint/safety priors (from `genes.json`, promoted).

### C3. The agentic model (proposed design)

**Shape:** a bounded orchestration, not a free-roaming ReAct loop. Deterministic tool-gathering
first (C2), then a small number of specialised LLM stages with structured outputs, then the
deterministic math, then an adversarial check. This keeps latency, cost, and auditability under
control and fits the existing `predict.ts` structured-output pattern.

Model: `claude-opus-4-8`, structured outputs per stage. Effort `low` for extraction stages,
`high` for the judgement/verdict stage.

**Stage 0 — Resolve & assemble (deterministic).** Normalise the three inputs (reuse
`predictTargets`/`checkInteraction` when one of the three is missing so "fill two, predict the
third" still holds). Run all C2 tools in parallel. Produce one `EvidenceBundle` object: association,
cohort rows, literature abstracts, drug/modality features, gene priors. No LLM yet.

**Stage 1 — Cohort curation (LLM, grounded).** Input: raw cohort rows from OT knownDrugs + cache.
Output (schema): the matched `cohort[]` the UI renders — for each program, `similarity` (mechanistic
analogy to the subject), `outcome`, `deathPhase`, `reason`. The model *selects and annotates* real
rows; it may not invent programs (schema requires an `nct_id`/`chembl_id` provenance field on every
row). This yields the real `cohortFailFraction` for math term 4.

**Stage 2 — Modality feasibility (LLM, grounded).** Input: drug type, SMILES-derived properties,
target tissue/localisation, gene tractability. Output: `modality.overall` (0–1) + the named axes
(stability, permeability, bioavailability, tissue access, CMC) each with a note. Feeds math term 3.

**Stage 3 — Failure modes + de-risking (LLM, grounded).** Input: the curated cohort's actual death
reasons + literature + modality axes. Output: `failureModes[]` (mechanism, probability share,
evidence quote, kill experiment, cost, timeline, signal) and `derisking[]` keyed to those modes.
Probabilities are a share of total attrition and must sum≈1; the *level* of attrition comes from the
math, not from here.

**Stage 4 — Compute the math (deterministic).** Feed association (Stage 0), `modality.overall`
(Stage 2), `cohortFailFraction` (Stage 1), drug/phase (Stage 0) into the existing
`computeAttrition`. Out: attrition, PoS, and the 5-term decomposition with citations. **This is the
only place the number is produced.**

**Stage 5 — Verdict, confidence, adversarial (LLM, high effort).** Input: everything above,
including the computed number. Output: `verdict`, `bull[]`/`bear[]`, and `confidence` +
`confidenceReason`. Confidence is derived from **evidence density**, not vibes: cohort size,
association strength, literature agreement, and cache/knownDrugs coverage. Encode a rubric (e.g.
High = ≥5 matched programs and association ≥0.5 and consistent literature; Low = sparse cohort or
contested mechanism). An adversarial sub-step asks the model to try to refute its own verdict; if
the refutation lands, confidence is capped.

**How each of the six required outputs is produced:**
- **Attrition risk** — Stage 4, deterministic.
- **Failure mode** — Stage 3, grounded in real cohort death reasons.
- **LLM confidence** — Stage 5, from an evidence-density rubric + adversarial pass.
- **Output rationale** — Stage 5 `verdict` + each term's citation string from Stage 4.
- **De-risking opportunities** — Stage 3, one experiment per live failure mode, priced.
- **Mathematical decomposition** — Stage 4, the 5 terms with values, inputs, and citations
  (already the `Component[]` shape in `attrition.ts`).

### C4. Infrastructure changes required
1. **Promote the AMASS cache into Supabase** so runtime cohort assembly works without live AMASS.
   New tables: `pg_drug_targets` (drug → target symbol, from `drugcore.mechanismsOfAction`),
   `pg_drug_trials` (the per-drug trial rows, with a target join), `pg_drug_regulatory`
   (approvals/outcomes), `pg_genes` (tractability priors). One-off loader from `data/cache/`.
   Without this, C2 tool 3 has no data and cohorts fall back to OT knownDrugs only.
2. **`forecast_cache` table** keyed by hash(disease,target,drug-set) → Report jsonb + generated_at
   + evidence provenance. Cache-through in `/api/forecast`.
3. **Move `attrition.ts` math to a shared module** callable server-side (route) and client-side
   (instant drug edits). Currently client-only.
4. **New route `/api/forecast`** on Fluid Compute, longer `maxDuration`. Stream stage-by-stage
   status to the UI so a 60–180s run shows progress rather than a spinner.
5. **Elicit rate/latency:** Stage 0 fires several Elicit calls; batch and cache per (disease,target)
   in `pg_literature` generalised beyond the 4 pairs.

### C5. Provenance / honesty guarantees to bake in
- Every cohort row and every numeric feature carries a source id; the UI can show "why this number."
- The report stores which fields were evidenced vs model-inferred, so the "illustrative vs real"
  table in CLAUDE.md stays honest as coverage grows.
- Calibration stays explicitly labelled illustrative until Part D4 is done.

---

## Part D — Build phases (proposed order)

> **AMASS credits are NOT required for D1–D4.** The frozen `data/cache/` is already on disk;
> promoting it to Supabase (D2) reads local files, not the API. The live cohort source (Open
> Targets `knownDrugs`) and drug features (ChEMBL) need no AMASS. Credits only *widen* coverage
> beyond the 271-drug seed set and enable patent/refresh work (see the "with credits" note per phase).


1. **D1 — Generalise the math server-side.** Port `attrition.ts` to a shared module; add the OT
   `knownDrugs` tool and a `drugFeatures` tool. Now terms 1,2,5 + a knownDrugs-only cohort (term 4)
   run live for any pair, with a crude modality prior (term 3). Ship a "beta forecast" that is real
   but thin. Lowest effort, unblocks arbitrary pairs immediately.
2. **D2 — AMASS trial corpus: seed + runtime accretion** (see Part F). Credit-free step first:
   promote the frozen `data/cache/` to Supabase as the seed corpus (C4.1). Then, once credits
   return, add the runtime AMASS drug-trial search that grows the corpus per query and enriches
   the cohort where Open Targets is thin.
3. **D3 — The agent (C3 stages 1–5)** producing the narrative sections + evidence-density
   confidence + adversarial check. This is the "agentic model" proper.
4. **D4 — Fit the coefficients** on a held-out set so calibration is earned, not illustrative
   (Roadmap item 4 in CLAUDE.md). Requires the promoted cache as labels.
5. **D5 — Patents** (PatentsView free, or AMASS patentcore if credits return) and directionality.

---

## Part E — Open questions to settle before building

1. **Does the LLM ever touch the number?** Proposal says no (C0). Agree, or allow a bounded logged
   override term?
2. **Cohort source priority — RESOLVED (see Part F).** OT `drugAndClinicalCandidates` is live but
   has real coverage holes (verified: it returns 0 rows for LRRK2 in Parkinson's despite active
   clinical programs). The decision is neither-alone: promote the frozen cache as the seed now, and
   add runtime AMASS drug-trial accretion when credits return, so the corpus grows per query and
   backfills where OT is thin.
3. **Latency budget:** a full 5-stage agent is 60–180s. Acceptable with streamed progress + cache,
   or do we want a faster degraded mode for the first paint?
4. **Coverage honesty:** as forecasts go live for arbitrary pairs, how do we keep the "real vs
   illustrative" line visible to users (per-field provenance badges)?
5. **Confidence rubric:** agree the exact evidence-density thresholds for High/Moderate/Low.
6. **Cost ceiling per forecast** (Opus, 5 stages, several Elicit calls) and whether to cache
   aggressively per (disease,target) and only recompute math on drug change.

---

## Part F — Runtime AMASS drug-trial accretion (PROPOSAL, AMASS-credit-gated)

### F0. The idea (Kiran)
Today the Supabase AMASS corpus (`pg_trials`, 43k trials) is a static harvest built from a fixed
list of 493 seed drugs. When a user enters a drug at runtime that is outside that seed set, we have
no clinical-trial data for it. So: at runtime, when the user supplies a drug (approved OR
experimental), fire a **live AMASS `trialcore` search for that drug**, then (1) write the returned
trials into Supabase so the corpus permanently grows, and (2) feed those trials into the attrition
prediction for the current query.

This turns the corpus from a fixed snapshot into a **self-accreting** one: every drug a user asks
about is harvested once and thereafter permanently enriches the DB for all future queries.

### F1. Why this matters (evidence)
The live OT cohort source has real holes. Verified 2026-07-04: `drugAndClinicalCandidates` returns
**0 rows for LRRK2** in Parkinson's, even though Denali/Biogen have active clinical LRRK2 programs.
For Depression+GRIN1 it returned 8 correct programs; for LRRK2 it returned none. A runtime AMASS
search keyed on the drug (and its target) backfills exactly these gaps with primary trial records.

### F2. Two distinct trial sets, two distinct roles
Keep these separate; they feed different parts of the model:
- **Subject-drug trials** (trials *of the drug the user typed*): the subject program's own clinical
  history. Informs the **base-rate phase anchor** (what phase the drug is actually at) and the
  **drug track-record OR** (term 5), and grounds the verdict's read on where this specific asset is.
- **Target-matched cohort trials** (trials of *other* drugs hitting the same target): the reference
  class. Informs the **precedent OR** (term 4). Built from OT + the frozen cache + any accreted
  AMASS rows for drugs known to hit the target.

### F3. Where it plugs into the agent
A new deterministic Stage-0 tool, `amassTrialsForDrug(drug)` (mirrors `pipeline/pull.py`'s
`search_union("trialcore", terms)` but slimmed for one drug and run in the request path):
1. Resolve the drug's query terms (name + trade names + a couple of synonyms), as `pull.py` does.
2. AMASS `trialcore` union search, trimmed to the `_TRIAL_KEEP` fields.
3. **Write-through to Supabase** (`pg_trials` upsert on `nct_id`, plus a `pg_drug_trials` link row
   tagging which drug/target the trial was harvested under), so the corpus grows. Dedup on `nct_id`.
4. Return the trial rows to the agent, joined into the two sets in F2.

The frozen `data/cache/trials/*` promotion (D2 seed step) uses the *same* `pg_trials`/`pg_drug_trials`
schema, so the seed and the runtime accretion are one corpus, not two.

### F4. How it changes the attrition computation
- **Term 5 (drug track record):** currently a coarse `max_phase>=4 ? 1.2 : 1.0`. With the subject
  drug's real trials, upgrade to a graded OR from its actual trial record (n trials, furthest phase
  reached, any terminated-for-safety signals).
- **Term 1 (base rate):** phase-anchor on the drug's *observed* furthest phase from its trials,
  not just ChEMBL `max_phase` (which can lag).
- **Term 4 (precedent):** accreted target-matched trials enlarge the reference class where OT is
  thin, so the cohort-failure fraction is computed over more real programs (the LRRK2 case stops
  being an empty cohort).
- All three remain deterministic; AMASS supplies better *inputs*, never the number (Part C0 holds).

### F5. Infrastructure
- **Reuse the AMASS client** (`amass/client.py` `search_union`) logic; port a minimal TS caller for
  the route, or expose a small internal Python/edge endpoint. TS-in-route is simplest given the
  rest of the agent is TS.
- **Schema:** `pg_trials` (exists) + new `pg_drug_trials(drug_key, nct_id, target_symbol,
  harvested_at)` link table. Both written with the service role from the route.
- **Rate limits & latency:** AMASS is 60/min. Cache per-drug: once a drug is harvested, mark it
  (`pg_drugs.amass_harvested_at`) and skip re-hitting AMASS on subsequent queries. First query for a
  novel drug pays one AMASS round-trip (~1-3s); repeats are free.
- **Credit-gated & inert-until-ready:** with no credits the tool no-ops (logs "AMASS unavailable")
  and the forecast falls back to OT + frozen cache exactly as it does today. The code path can be
  scaffolded now and switches on the moment credits are topped up, with no other change.

### F6. Honesty / provenance
Accreted trials carry `harvested_at` and the query drug/target they came in under, so the corpus
stays auditable and we can always tell seed rows from runtime-accreted rows. The forecast's
provenance block gains `amassTrialsUsed` counts (subject-drug, target-cohort) so the UI can show
"cohort enriched with N live AMASS trials."

---

## Part F-built — AMASS patents + runtime drug-trial search (SHIPPED 2026-07-04)

Once the new AMASS key landed, the credit-gated parts of Part F were built and verified live:
- **`web/src/lib/amass.ts`** — runtime callers: `searchPatents` (patentcore) and `searchDrugTrials`
  (trialcore). Sparing by design: single query, small limits (6 patents / 15 trials), no bulk
  `search_union`, graceful `[]` on 403 (out of credits) so the forecast still runs AMASS-free.
- **`web/src/lib/evidence.ts` + `pg_evidence` table** — cache-through so each AMASS query spends a
  credit AT MOST ONCE ever: patents keyed by (disease+target), drug-trials keyed by drug name. On
  out-of-credits nothing is cached, so a later top-up retries cleanly. Verified: a 2nd identical
  `getPatents` call served from cache in 85ms with no AMASS hit.
- **Patents folded into the same evidence stream as Elicit** — passed into the modality/failure-mode
  stage and the verdict stage (competitive / freedom-to-operate / differentiation signal), returned
  in the forecast result, and rendered as a "Patent landscape" panel (report-parts `PatentsPanel`).
- **Runtime drug-trial search** — for each drug the user types, its AMASS trials are fetched (cached
  per drug) and merged into the matching cohort program's trials; counts surface in provenance.
- **Verified in prod:** obesity/GLP1R → 6 real patents (vTv, Novartis, Regeneron); T2D+GLP1R with
  semaglutide → 6 patents + 15 semaglutide trials merged, attrition 1.6% (approved drug, correct).
- Still deferred: writing accreted AMASS trials into `pg_trials`/`pg_drug_trials` as a growing
  corpus (D2 seed promotion). Patents/drug-trials currently persist in `pg_evidence`, not `pg_trials`.

## Part G — Build status (what is live)

**Shipped (2026-07-04), D1 + D3, AMASS-free, live in production:**
- `web/src/lib/opentargets.ts` — live OT client (resolve disease/target, association,
  `drugAndClinicalCandidates` cohort).
- `web/src/lib/forecast.ts` — the agent: Stage 0 evidence assembly (OT + Elicit), Stage 1 cohort
  curation (grounded, provenance-locked), Stage 2 modality + failure modes + derisking, Stage 3
  deterministic `computeAttrition`, Stage 4 verdict + evidence-density confidence + adversarial.
- `web/src/lib/llm.ts` — shared Anthropic structured-output helper.
- `web/src/app/api/forecast/route.ts` — cache-through route (`maxDuration=300`), Supabase
  `forecast_cache` table (keyed by hash of disease|target|drug-set).
- `web/src/components/Prognosis.tsx` — non-authored pairs now render a live forecast through the
  same report components (calibration panel omitted for live, with an honest provenance banner).

**Verified end-to-end:** Depression+GRIN1 → 8 real programs (esketamine approved; rapastinel,
lanicemine, AV-101 failed), 96.5% attrition, High confidence, full decomposition. Parkinson+LRRK2 →
empty OT cohort handled honestly (Low confidence, 91%), which motivated Part F.

**Not yet built:** Part F (runtime AMASS accretion, credit-gated), D2 frozen-cache promotion, D4
coefficient fitting, patents/directionality.

## Part H: Shipped since Part G (2026-07-05, live in production)

The full current architecture is in the repo-root `CLAUDE.md`; this is a delta summary.

- **Second forecast lens, target-free (disease + drug, no target).** `generateForecastTargetFree` →
  `/api/forecast-by-drug`. Cohort is the DISEASE's programs (`diseaseCohortCandidates`); the
  validation term is the drug's own **efficacy evidence** (LLM-graded, cached in `pg_evidence`)
  instead of a target's genetics. `computeAttritionTargetFree` in `attrition.ts`.
- **Disease-only discovery.** `discoverDrugs(disease)` → `/api/discover-drugs` mines OT disease-drugs
  + AMASS patents + Elicit literature into a ranked candidate-drug table, each scored target-free
  (`scoreDrugsTargetFree`, per-drug efficacy grade). Cached as `pg_evidence` kind `discovery_v5`.
- **Unified Compute button.** One action in `Prognosis.tsx` (`runCompute`) dispatches by a derived
  `computeMode` (discovery / target / target-free). Disease input now accepts free text.
- **Mechanism-of-action box.** `mechanismLinkage` (Stage 2b, parallel with modality) reconstructs
  drug → target → disease from the already-fetched literature + patents, with a 5-level confidence
  grade specific to the mechanism. `report.mechanism`; rendered by `MechanismPanel`.
- **Approved-for-indication → 0% attrition:** a deterministic hard override. From live OT
  `drug.indications` (stage string `"APPROVAL"`) matched to the queried EFO or a descendant subtype
  (`disease.descendants`); `approvedScore()` short-circuits both adapters and `AttritionScore.approved`
  drives an "Approved for this indication" UI state. Discovery pins approved-for-disease drugs to 0
  and offers a "hide approved" filter. New OT helpers `drugApprovalIndications` / `diseaseDescendants`
  / `isApprovedForIndication`, cached as `pg_evidence` kinds `drug_approvals` / `disease_descendants`.
  This fixed a latent bug: a dead `/PHASE_?4/` regex never matched OT's `"APPROVAL"` string.
- **Removed:** the "target tournament" (auto-picked a drug's best target by lowest attrition); it
  favoured under-studied targets and was replaced by the target-free lens. Do not reintroduce.
- **Rename:** product is now **Attritio AI** (user-visible strings only; Vercel project, alias, and
  the `Prognosis.tsx` component keep the old names).
- `forecast_cache` `SCHEMA_VERSION` is now **v7**.
