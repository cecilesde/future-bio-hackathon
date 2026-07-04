# UI <-> backend coordination

Owner: the UI agent. Audience: the agents building the Python/ML pipeline.
Last verified by the UI agent: 2026-07-04.

## CURRENT STATE (verified, not assumed)

The architecture now matches Kiran's diagram: **the UI is a ranked table lookup
against the Supabase `predictions` table** (the "Prediction Score Database"). No
per-request LLM at serving time.

Verified by direct query / live test on 2026-07-04:
- Supabase project `vkcendblgzjxvxsufldw` ("repurposing-predictor") is linked and
  populated:
  - `drugs` = 99 rows, `diseases` = 206 rows.
  - `predictions` = 20,394 rows (the full 99 x 206 grid), 60 with
    `is_already_approved = true`.
  - `labels` = 71, `model_meta` = 1 run.
- `model_meta` metrics: AUPRC 0.712 (model) vs 0.133 (popularity floor) vs 0.0029
  (random), lift 5.36x, recall@50 0.617. The model beats baselines.
- The UI reads `predictions` directly with the anon/publishable key (RLS public
  read). BOTH directions tested working end to end:
  - drug -> indications (ranked by `rank_for_drug`, `is_already_approved=false`).
  - disease -> drugs (ranked by `rank_for_disease`, `is_already_approved=false`).
- Autocomplete now reads the `drugs` / `diseases` tables (so users can only pick
  entities that actually have predictions), falling back to bundled lists if
  Supabase is unreachable.

So my earlier asks (build the reverse direction; expose an HTTP API; provide a
disease vocabulary) are RESOLVED by the predictions table + populated vocab tables.
The UI needs nothing more to serve. The LLM path is now only a dormant fallback for
entities with no predictions rows (see "Fallback" below).

## Env set in Vercel (UI project `repurpose-engine`)
`SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable) — the serving path.
`AMASS_API_KEY`, `AMASS_BASE_URL`, `AMASS_AGENT_MODEL`, `ANTHROPIC_API_KEY` — only
used by the dormant LLM preview fallback; not needed once every queried entity has
predictions.

## NEW: per-candidate risk assessment (UI is ready, needs data)

Kiran wants each candidate's expanded row to show a development-risk readout. The UI
renders it now with `{THIS IS A PLACEHOLDER}` for every value until you supply these.
Please add columns to `predictions` (or a joined table) and populate them:

- `attrition_risk`  real/int  -- overall attrition risk as a PERCENT 0..100 (prob it
                                  fails in development; roughly the inverse of success).
- `failure_mode`    text      -- e.g. "Safety-driven, not efficacy-driven".
- `assessment_confidence` text -- "Low" | "Moderate" | "High" (distinct from the
                                  existing `confidence` column; this rates the risk call).
- `reasons`         jsonb     -- ordered array of short strings (main reasons), e.g.
                                  ["Broad immune pathway involvement", "Known pathway
                                   safety concerns from related mechanisms", ...].
- `derisking`       jsonb     -- ordered array of short strings (recommended de-risking
                                  experiments), e.g. ["Human primary immune-cell
                                  selectivity panel", ...].

The UI maps these straight onto `RiskAssessment` in `web/src/lib/types.ts`. Once the
columns exist, tell me and I will add them to the `predictions` select in
`web/src/lib/serve.ts` (I cannot select columns that do not exist yet without the
query erroring, so the select stays as-is until then).

## OPEN ITEMS for the backend/ML agents (please check)

1. **`model_meta` is service-role-only under RLS**, so the UI (anon key) cannot read
   its `coverage_note` or `metrics`. If you want the exact model caveat / headline
   metrics shown in the UI, expose them to anon: either add a public read policy on
   `model_meta`, or (cleaner) a small public `model_public` view exposing just
   `coverage_note` + a few metrics. Until then the UI shows an accurate hardcoded
   caveat.

2. **Possible label-quality issue.** `drugs.approved_for` for Semaglutide returns
   `["Hypertension", "Non-Alcoholic Steatohepatitis", "Obesity"]`. Hypertension and
   NASH are not Semaglutide approvals (it is T2DM + obesity/weight; NASH is
   investigational). Looks like the FDA/EMA indication extraction is picking up
   risk-population or comorbidity mentions. Worth auditing `pipeline/labels.py`
   `_extract_indication` against a few known drugs. (This is your data; flagging, not
   changing it.)

3. **`model_meta.coverage_note` text says "493 drugs x 207 diseases"** but the actual
   grid is 99 x 206. Minor, but the note is user-facing if you later expose it.

## Contract the UI consumes (for reference / if the schema changes)

The UI reads these columns from `predictions` (+ joined `drugs`/`diseases`):
`score, confidence, evidence_tier, furthest_phase, n_trials, rationale,
supporting_trials, is_already_approved, rank_for_drug, rank_for_disease`, plus
`drugs.name`, `drugs.approved_for`, `diseases.name`, `diseases.therapeutic_area`.
Keep `score` as 0..1 and the ranks populated. The UI renders `score` as a
percentage with a bar RELATIVE to the top candidate in each list (absolute scores
are small: top ~1%), labelled as an evidence-weighted likelihood, not a validated
probability. It does not re-sort — it trusts `rank_for_drug` / `rank_for_disease`.

## Fallback (dormant)
If a queried entity has no `predictions` rows, `/api/analyze` falls back to an
on-the-fly LLM ranking (Claude + light Amass grounding), clearly labelled
"preview (LLM)" vs "trained model" in the UI. With the full grid populated this
should almost never fire. Can be removed on request if you want the UI to strictly
mirror the diagram (show "no prediction yet" instead).
