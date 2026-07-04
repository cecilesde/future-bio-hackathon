"""Load the Prognosis backend into Supabase (pg_* tables).

Populates:
  - pg_diseases         the diseases offered in the UI (+ their EFO ids)
  - pg_targets          targets from Open Targets, ranked by association, with
                        authored-report targets unioned in and flagged modeled
  - pg_reports          the authored forecast reports (jsonb)
  - pg_trials           the harvested AMASS trials (deduped)
  - pg_trial_disease    trial -> (area, disease) map
  - pg_trial_disease_stats  aggregate distribution the UI reads
  - pg_trial_meta       header totals + caveat

Idempotent: upserts on natural keys; the trial_disease map is rebuilt each run.
Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

import elicit
import opentargets as ot
import trial_taxonomy as tax

PAPER_FIELDS = ("title", "authors", "year", "abstract", "doi", "pmid", "venue",
                "citedByCount", "urls")

ROOT = Path(tax.ROOT)
SEED = ROOT / "data" / "seed" / "forecast.json"

# UI diseases -> Open Targets EFO/MONDO id (the disease node of the architecture)
EFO = {
    "obesity": "MONDO_0011122",
    "alzheimers": "MONDO_0004975",
}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def client():
    load_dotenv(ROOT / ".env")
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def load_forecast(sb, forecast):
    diseases = forecast["diseases"]
    reports = forecast["reports"]  # keyed "disease:SYMBOL"

    sb.table("pg_diseases").upsert(
        [{"id": d["id"], "name": d["name"], "synonym": d["synonym"],
          "efo_id": EFO.get(d["id"])} for d in diseases],
        on_conflict="id",
    ).execute()

    # authored reports -> pg_reports, and index modeled symbols per disease
    modeled = {}  # disease_id -> set(symbols)
    report_rows = []
    for key, rep in reports.items():
        did, sym = key.split(":", 1)
        modeled.setdefault(did, set()).add(sym)
        report_rows.append({"disease_id": did, "symbol": sym, "report": rep})
    sb.table("pg_reports").upsert(report_rows, on_conflict="disease_id,symbol").execute()

    # targets from Open Targets, per disease
    for d in diseases:
        did = d["id"]
        efo = EFO.get(did) or (ot.resolve_disease(d["name"]) or {}).get("id")
        if not efo:
            print(f"  ! no EFO id for {did}; skipping targets")
            continue
        rows = ot.associated_targets(efo, size=15)
        have = {r["symbol"] for r in rows}
        # union authored targets that fell outside the top-N so they stay selectable
        for sym in modeled.get(did, set()):
            if sym not in have:
                extra = ot.association_for(sym, efo)
                if extra:
                    rows.append(extra)
                    print(f"  + unioned authored target {sym} ({extra['association']}) into {did}")
                else:
                    print(f"  ! {sym} not associated with {efo} in Open Targets; skipped")
        rows.sort(key=lambda r: -(r["association"] or 0))
        target_rows = [{
            "disease_id": did,
            "symbol": r["symbol"],
            "ensembl_id": r["ensembl_id"],
            "name": r["name"],
            "association": r["association"],
            "datatype_scores": r["datatype_scores"],
            "evidence": r["evidence"],
            "modeled": r["symbol"] in modeled.get(did, set()),
            "rank": i + 1,
        } for i, r in enumerate(rows)]
        # rebuild this disease's targets cleanly
        sb.table("pg_targets").delete().eq("disease_id", did).execute()
        sb.table("pg_targets").insert(target_rows).execute()
        print(f"  {did}: {len(target_rows)} targets "
              f"({sum(t['modeled'] for t in target_rows)} modeled)")


def _date(v):
    return v if isinstance(v, str) and DATE_RE.match(v) else None


def load_trials(sb):
    trial_rows, map_rows = [], []
    for r in tax.load_records():
        nct = r.get("nctId") or r.get("amassId")
        if not nct:
            continue
        pairs = tax.diseases_for(r)
        trial_rows.append({
            "nct_id": nct,
            "brief_title": r.get("briefTitle"),
            "phase": r.get("phase"),
            "phase_bucket": tax.phase_bucket(r.get("phase")),
            "overall_status": r.get("overallStatus"),
            "status_bucket": tax.status_bucket(r.get("overallStatus")),
            "enrollment": r.get("enrollment") if isinstance(r.get("enrollment"), int) else None,
            "sponsor_name": r.get("sponsorName"),
            "sponsor_type": r.get("sponsorType"),
            "start_date": _date(r.get("startDate")),
            "completion_date": _date(r.get("completionDate")),
            "source_url": r.get("sourceUrl"),
            "conditions": [c for c in (r.get("conditions") or []) if isinstance(c, str)][:25],
            "mesh_terms": [c for c in (r.get("conditionMeshTerms") or []) if isinstance(c, str)][:25],
        })
        for (area, disease) in pairs:
            map_rows.append({"nct_id": nct, "area": area, "disease": disease})

    print(f"  upserting {len(trial_rows)} trials ...")
    for batch in chunks(trial_rows, 500):
        sb.table("pg_trials").upsert(batch, on_conflict="nct_id").execute()

    # rebuild the trial->disease map
    sb.table("pg_trial_disease").delete().neq("nct_id", "").execute()
    print(f"  inserting {len(map_rows)} trial-disease rows ...")
    for batch in chunks(map_rows, 1000):
        sb.table("pg_trial_disease").insert(batch).execute()

    # aggregate stats + meta (single source: trial_taxonomy.aggregate)
    dist = tax.aggregate()
    stat_rows = []
    for a in dist["areas"]:
        for d in a["diseases"]:
            ph, st = d["phases"], d["status"]
            stat_rows.append({
                "area": a["area"], "disease": d["disease"], "trials": d["trials"],
                "p1": ph["P1"], "p2": ph["P2"], "p3": ph["P3"], "p4": ph["P4"], "na": ph["NA"],
                "completed": st["completed"], "ongoing": st["ongoing"],
                "stopped": st["stopped"], "other": st["other"], "enrollment": d["enrollment"],
            })
    sb.table("pg_trial_disease_stats").delete().neq("area", "").execute()
    for batch in chunks(stat_rows, 500):
        sb.table("pg_trial_disease_stats").insert(batch).execute()

    m = dist["meta"]
    sb.table("pg_trial_meta").upsert({
        "id": 1, "total_unique": m["totalUniqueTrials"], "mapped": m["mappedTrials"],
        "excluded_nondisease": m["excludedNonDisease"], "unmapped_mentions": m["unmappedConditionMentions"],
        "n_areas": m["areas"], "note": m["note"],
    }, on_conflict="id").execute()
    print(f"  stats: {len(stat_rows)} area-disease rows; meta loaded")


def load_literature(sb, forecast):
    """Elicit literature for each modeled (disease, target) pair -> pg_literature.
    Skipped silently if ELICIT_API_KEY is absent."""
    if not os.environ.get("ELICIT_API_KEY"):
        print("  (no ELICIT_API_KEY; skipping literature)")
        return
    dnames = {d["id"]: d["name"] for d in forecast["diseases"]}
    rows = []
    for key in forecast["reports"]:
        did, sym = key.split(":", 1)
        q = f"{sym} as a therapeutic target for {dnames.get(did, did)}: clinical trial outcomes, efficacy and safety"
        try:
            res = elicit.search_papers(q, max_results=8)
        except Exception as e:
            print(f"  ! elicit failed for {key}: {e}")
            continue
        papers = [{k: p.get(k) for k in PAPER_FIELDS} for p in res.get("papers", [])]
        rows.append({"disease_id": did, "symbol": sym, "papers": papers})
        print(f"  {key}: {len(papers)} papers")
    if rows:
        sb.table("pg_literature").upsert(rows, on_conflict="disease_id,symbol").execute()


def main():
    sb = client()
    forecast = json.loads(SEED.read_text())
    print("== forecast (Open Targets + authored reports) ==")
    load_forecast(sb, forecast)
    print("== literature (Elicit) ==")
    load_literature(sb, forecast)
    print("== trials (AMASS harvest) ==")
    load_trials(sb)
    print("done.")


if __name__ == "__main__":
    main()
