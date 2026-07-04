"""Elicit API client — literature (and clinical-trial) retrieval.

Elicit searches 138M+ academic papers and ClinicalTrials.gov. It does NOT cover
patents (verified against docs.elicit.com, 2026-07); patents must come from a
different source (AMASS patentcore, PatentsView, Lens, ...).

Auth: Bearer key (elk_live_...), Pro plan or above. Docs: https://docs.elicit.com/
"""
from __future__ import annotations

import os

import requests
from dotenv import load_dotenv

BASE = "https://elicit.com/api/v1"


class ElicitError(RuntimeError):
    pass


def _key() -> str:
    load_dotenv()
    k = os.environ.get("ELICIT_API_KEY")
    if not k:
        raise ElicitError("No ELICIT_API_KEY in env (add it to .env).")
    return k


def _post(path: str, body: dict) -> dict:
    r = requests.post(
        f"{BASE}{path}",
        json=body,
        headers={"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"},
        timeout=90,
    )
    if r.status_code == 401:
        raise ElicitError("401 from Elicit: check ELICIT_API_KEY / plan tier.")
    r.raise_for_status()
    return r.json()


def search_papers(query: str, max_results: int = 10, corpus: str = "elicit",
                  search_mode: str = "semantic", filters: dict | None = None) -> dict:
    """POST /search. corpus: 'elicit' (138M) or 'pubmed'. Returns raw JSON.

    NOTE: the response wrapper key must be confirmed against a live call before
    downstream code depends on it (do not assume the top-level shape). Per-paper
    fields are: title, authors, year, abstract, doi, pmid, elicitId, venue,
    citedByCount, urls.
    """
    body: dict = {"query": query, "maxResults": max_results, "corpus": corpus,
                  "searchMode": search_mode}
    if filters:
        body["filters"] = filters
    return _post("/search", body)


def search_trials(query: str, max_results: int = 10) -> dict:
    """POST /search/trials. Returns raw JSON (shape TBD, confirm on live call)."""
    return _post("/search/trials", {"query": query, "maxResults": max_results})


if __name__ == "__main__":
    import json
    import sys

    q = sys.argv[1] if len(sys.argv) > 1 else "GLP-1 receptor agonist obesity clinical outcomes"
    print(json.dumps(search_papers(q, max_results=3), indent=2)[:3000])
