"""CLI entrypoint for the drug-repurposing engine.

Usage:
    python main.py "semaglutide"            # deterministic evidence table
    python main.py "semaglutide" --json     # machine-readable JSON
    python main.py "semaglutide" --agent    # + LLM ranking (needs ANTHROPIC_API_KEY)
"""

from __future__ import annotations

import argparse
import sys

from dotenv import load_dotenv

from amass_client import AmassClient
from repurposing import build_drug_evidence, DrugEvidence


def print_table(ev: DrugEvidence, top: int = 25) -> None:
    if not ev.resolved:
        print(f"Drug {ev.query_name!r} not found in Amass DrugCore.")
        return
    print(f"\n{'=' * 78}")
    print(f"DRUG: {ev.canonical_name}  [{ev.chembl_id}]  type={ev.drug_type}")
    if ev.description:
        print(f"  {ev.description}")
    if ev.targets:
        tgts = ", ".join(f"{t['symbol']} ({t['action']})" for t in ev.targets if t.get("symbol"))
        print(f"  Targets: {tgts}")
    print(f"{'=' * 78}")

    if ev.approved_indications:
        print("\nREGULATORY-APPROVED (verbatim excerpts):")
        for ai in ev.approved_indications[:8]:
            excerpt = (ai["therapeutic_indication_excerpt"] or "").replace("\n", " ")[:140]
            print(f"  [{ai['agency']}] {ai['brand_name']} "
                  f"({ai['authorization_status']}): {excerpt}")

    print(f"\nINDICATIONS STUDIED IN TRIALS  (from {ev.n_trials_examined} trials)")
    print(f"{'indication':<44} {'trials':>6} {'maxphase':>9} {'compl':>6} {'results':>7}")
    print("-" * 78)
    for ind in ev.indications[:top]:
        print(f"{ind['indication'][:43]:<44} {ind['n_trials']:>6} "
              f"{ind['max_phase']:>9} {ind['n_completed']:>6} {ind['n_with_results']:>7}")
    if len(ev.indications) > top:
        print(f"... and {len(ev.indications) - top} more indications")
    print(f"\nNote: {ev.coverage_note}")


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Amass drug-repurposing engine")
    ap.add_argument("drug", help="drug name, e.g. 'semaglutide'")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    ap.add_argument("--agent", action="store_true",
                    help="run the LLM ranking layer (needs ANTHROPIC_API_KEY)")
    ap.add_argument("--top", type=int, default=25, help="rows to show in the table")
    args = ap.parse_args(argv)

    client = AmassClient()
    ev = build_drug_evidence(client, args.drug)

    if args.json and not args.agent:
        print(ev.to_json())
        return 0

    print_table(ev, top=args.top)

    if args.agent:
        from agent import rank_repurposing_candidates
        print("\n" + "=" * 78)
        print("LLM REPURPOSING ANALYSIS")
        print("=" * 78)
        result = rank_repurposing_candidates(client, ev)
        print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
