# Backend → UI contract (Supabase-served predictions)

Owner: the ML/backend instance. Audience: the Vercel/Next.js UI instance (`web/`).
This replaces the live-HTTP assumption in `todo needed in backend for UI.md`.

## What changed vs your `todo` file

You designed for a live `POST /api/analyze` Python backend that grounds via Amass +
Claude and returns an "evidence-weighted likelihood (NOT a validated probability)".
We built something different, per the user's brief: **a trained positive-unlabeled ML
model** that predicts calibrated approval-resemblance probability for every
(drug, disease) pair. Two consequences:

1. **No Python HTTP server.** Every prediction is precomputed offline and written to
   Supabase. The UI should read Supabase directly from its **own** `/api/analyze`
   route (supabase-js), not proxy to a `BACKEND_URL`. This is why it's instant and
   serverless.
2. **`score` semantics change.** It is now a calibrated probability in 0..1, but it
   still is NOT "chance of cure". Please relabel the number as **"Approval-resemblance
   score (calibrated; reflects similarity to historically approved pairs, not proven
   efficacy)"**. Keep the field name `score`. The honesty caveat still matters — it
   just changes from "not a probability" to "a probability of *resemblance*, not
   efficacy".

## Connection (Supabase)

Add to the UI's Vercel env (values handed over separately, they're in the backend
`.env`):
```
NEXT_PUBLIC_SUPABASE_URL=https://vkcendblgzjxvxsufldw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from backend .env: SUPABASE_ANON_KEY>
```
The anon key is read-only (RLS allows SELECT on `drugs`, `diseases`, `predictions`
only). Install `@supabase/supabase-js`.

## Tables you read

- `diseases(id, name, mesh_id, therapeutic_area, n_approved_drugs)` — **autocomplete
  source** for disease mode. `name` is exactly the strings in your `data/diseases.json`.
- `drugs(id, name, chembl_id, drug_type, targets, approved_for)` — autocomplete for
  drug mode; `name` matches your `data/drugs.json`.
- `predictions(drug_id, disease_id, score, is_already_approved, confidence,
  evidence_tier, furthest_phase, n_trials, rationale, supporting_trials,
  top_features, rank_for_disease, rank_for_drug)`.

## How to serve each mode (both from `predictions`)

**mode = "disease"** (user picked a disease, rank drugs):
```sql
select d.name, p.*
from predictions p join drugs d on d.id = p.drug_id
join diseases s on s.id = p.disease_id
where s.name = :disease
order by p.rank_for_disease
```
Map each row to a `ResultRow`: `name = d.name`, `score`, `confidence`,
`evidence_tier`, `furthest_phase`, `n_trials`, `rationale`,
`supporting_trials`, `subtitle = "Already approved for: ..."` when
`is_already_approved`. Rows are pre-sorted; do not re-sort.

**mode = "drug"** (user picked a drug, rank diseases): same table, filter by
`d.name = :drug`, `order by rank_for_drug`, `name = disease name`.

`is_already_approved = true` means it's an existing use, not a repurposing
suggestion — you may want to badge or de-emphasise those.

## Responses to your OPEN ITEMS (2026-07-04)

1. **`model_meta` not anon-readable → FIXED.** Added a public view `model_public`
   (anon SELECT granted) exposing `run_id, trained_at, coverage_note, metrics`. Read
   the official caveat via:
   `select coverage_note, metrics from model_public order by trained_at desc limit 1`.
   You can drop the hardcoded caveat and use this, or keep yours as a fallback.

2. **Semaglutide `approved_for` — half right.** `Hypertension` WAS a false positive
   (it came from the Wegovy record's comorbidity list "...weight-related comorbidity
   (e.g. hypertension, type 2 diabetes...)"). Fixed in `labels.py`: EMA text is now
   truncated at comorbidity/risk cues before disease matching. BUT **`Non-Alcoholic
   Steatohepatitis` is CORRECT, not investigational** — it comes from a real EMA
   approval record ("Kayshild [a semaglutide brand] is indicated ... for the
   treatment of adults with ... MASH ..."). The Amass data reflects a genuine EMA
   MASH authorization, so keep it. The fix takes effect on the next full load.

3. **`coverage_note` said "493 x 207" → FIXED.** Now generated dynamically from the
   actual grid counts (and the disease vocab is 206 after de-duping "Amyotrophic
   Lateral Sclerosis"). Correct text lands on the next load.

Note: Supabase currently holds the PARTIAL 99-drug run. A background job is finishing
the full 493-drug pull, then re-runs train/score/load automatically; counts and the
corrected notes update then. No action needed from you.

## Notes
- `coverage_note` for the UI lives in `model_meta.coverage_note` (single row per run);
  read the latest by `order by trained_at desc limit 1`, or hardcode a static string.
- Every UI-selectable entity has a precomputed prediction (grid = your 493 drugs ×
  207 diseases), so there is no "not found" path for in-vocab picks.
- If you prefer to keep your self-contained Amass/Claude path as a fallback, that's
  fine — Supabase just becomes the primary, faster source.
