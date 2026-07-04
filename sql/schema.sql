-- Drug-repurposing predictor: Supabase schema.
-- Serving tables (drugs, diseases, predictions) are public-readable via the anon
-- key. Internal tables (labels, model_meta) are service-role only.
-- The predictions row is designed to populate the UI's ResultRow contract
-- (web/src/lib/types.ts) directly, for BOTH directions from one table.

create table if not exists drugs (
  id                    serial primary key,
  name                  text not null unique,   -- canonical name shown in UI + autocomplete
  chembl_id             text,
  drug_type             text,                   -- SMALL_MOLECULE / ANTIBODY / ...
  smiles                text,
  inchikey              text,
  max_clinical_stage    text,
  targets               jsonb default '[]',     -- [{symbol, ensemblId, action}]
  approved_for          jsonb default '[]'      -- ["type 2 diabetes", ...] -> UI subtitle
);

create table if not exists diseases (
  id                    serial primary key,
  name                  text not null unique,   -- canonical disease label = autocomplete item
  mesh_id               text,
  therapeutic_area      text,
  n_approved_drugs      int default 0
);

create table if not exists predictions (
  drug_id               int not null references drugs(id) on delete cascade,
  disease_id            int not null references diseases(id) on delete cascade,
  score                 real not null,          -- calibrated approval-resemblance prob 0..1
  is_already_approved   boolean default false,  -- true = existing use, not a repurposing hit
  confidence            text,                   -- high | medium | low
  evidence_tier         text,                   -- clinical_trial | mechanism_or_literature
  furthest_phase        text,                   -- e.g. PHASE3 / NA (evidence, not a feature)
  n_trials              int default 0,
  rationale             text,                   -- one-sentence grounded reason
  supporting_trials     jsonb default '[]',     -- ["NCT...", ...] real ids for deep links
  top_features          jsonb default '{}',     -- explainability: feature -> contribution
  rank_for_disease      int,                    -- rank among drugs for this disease
  rank_for_drug         int,                    -- rank among diseases for this drug
  primary key (drug_id, disease_id)
);

create index if not exists idx_pred_disease on predictions (disease_id, rank_for_disease);
create index if not exists idx_pred_drug    on predictions (drug_id, rank_for_drug);

-- ground-truth positives (audit / retraining), service-role only
create table if not exists labels (
  drug_id                   int references drugs(id) on delete cascade,
  disease_id                int references diseases(id) on delete cascade,
  agency                    text,               -- FDA | EMA
  first_authorization_date  date,
  primary key (drug_id, disease_id, agency)
);

-- one row per training/scoring run, for provenance + the honesty caveat
create table if not exists model_meta (
  run_id                text primary key,
  trained_at            timestamptz default now(),
  cutoff_t              date,
  metrics               jsonb default '{}',      -- auroc/auprc/hits@k vs popularity floor
  feature_importance    jsonb default '{}',
  coverage_note         text,                    -- passed through to the UI unchanged
  notes                 text
);

-- ---- Row-level security: public read on serving tables only ----
alter table drugs        enable row level security;
alter table diseases     enable row level security;
alter table predictions  enable row level security;
alter table labels       enable row level security;
alter table model_meta   enable row level security;

drop policy if exists "public read drugs"       on drugs;
drop policy if exists "public read diseases"    on diseases;
drop policy if exists "public read predictions" on predictions;
create policy "public read drugs"       on drugs       for select using (true);
create policy "public read diseases"    on diseases    for select using (true);
create policy "public read predictions" on predictions for select using (true);
-- labels + model_meta: no anon policy => readable only by service_role (bypasses RLS).
