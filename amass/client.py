"""Thin client over the Amass life-sciences REST API.

Amass is the retrieval layer: 500M+ documents indexed server-side across six
"cores". We query it and get relevance-ranked records back. There is NO
client-side vector store to build.

Hard API facts (probed against the live API, 2026-07):
  - Base: https://api.amass.tech/api/v1
  - Auth: `Authorization: Bearer amass_...`
  - Endpoint: GET /cores/{core}/records?query=<fulltext>&limit=<=300
  - `limit` is capped at 300 by the server (400 BAD_REQUEST above that).
  - There is NO pagination. `offset`/`page` are silently ignored and return the
    SAME first page (verified: offset=0 and offset=300 both return the same first
    record). An empty query is rejected; `query=*` returns 0. So a single query
    yields at most the top-300 ranked records for that term.
  - ENUMERATION STRATEGY (the only way to widen coverage): union many meaningful
    queries. To harvest "all" approvals/trials we union a large disease/drug
    vocabulary; each term surfaces up to 300 records, and the union approximates
    full coverage. Coverage is never guaranteed complete: record that honestly.
  - Rate limit: 60 requests / 60s.
  - Response shape: {"data": [ {...record...}, ... ]}  (no total, no cursor).
"""

from __future__ import annotations

import os
import time
from typing import Any, Iterable

import requests

CORES = (
    "biomedcore",     # 40M+ papers
    "trialcore",      # 1.2M+ clinical trials
    "drugcore",       # harmonized drug records (ChEMBL-derived)
    "regulatorycore", # FDA / EMA authorizations
    "genecore",       # gene records (Open Targets-style: tractability, constraint)
    "patentcore",     # patents (preview)
)

MAX_LIMIT = 300  # server-enforced ceiling; see module docstring
RATE_LIMIT_PER_MIN = 60


class AmassError(RuntimeError):
    pass


class AmassClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 timeout: float = 30.0, max_retries: int = 4,
                 min_interval: float = 60.0 / RATE_LIMIT_PER_MIN):
        self.api_key = api_key or os.environ.get("AMASS_API_KEY")
        if not self.api_key:
            raise AmassError("No AMASS_API_KEY (pass api_key= or set the env var).")
        self.base_url = (base_url or os.environ.get("AMASS_BASE_URL")
                         or "https://api.amass.tech/api/v1").rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        # Client-side pacing so we stay under the 60/min limit without relying on
        # 429s. min_interval is the minimum gap between requests.
        self.min_interval = min_interval
        self._last_request_ts = 0.0
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {self.api_key}"

    def _pace(self) -> None:
        # monotonic clock is allowed; we only need relative spacing
        now = time.monotonic()
        gap = self.min_interval - (now - self._last_request_ts)
        if gap > 0:
            time.sleep(gap)
        self._last_request_ts = time.monotonic()

    def search(self, core: str, query: str, limit: int = 50,
               **params: Any) -> list[dict]:
        """One query against one core. Returns the list of record dicts.

        limit is clamped to MAX_LIMIT. Retries on 429 / 5xx with backoff.
        """
        if core not in CORES:
            raise AmassError(f"Unknown core {core!r}; valid: {', '.join(CORES)}")
        if not query or not query.strip():
            return []  # the API rejects empty queries; treat as no-op
        if limit > MAX_LIMIT:
            limit = MAX_LIMIT  # silent clamp: callers can't get more anyway
        url = f"{self.base_url}/cores/{core}/records"
        q = {"query": query, "limit": limit, **params}

        last_exc: Exception | None = None
        for attempt in range(self.max_retries):
            self._pace()
            resp = self._session.get(url, params=q, timeout=self.timeout)
            if resp.status_code == 200:
                body = resp.json()
                return body.get("data", []) if isinstance(body, dict) else []
            if resp.status_code == 429 or resp.status_code >= 500:
                wait = float(resp.headers.get("Retry-After", 2 ** attempt))
                last_exc = AmassError(f"{resp.status_code} on {core}: {resp.text[:200]}")
                time.sleep(min(wait, 30))
                continue
            # 4xx other than 429: not retryable
            raise AmassError(f"{resp.status_code} {core} query={query!r}: {resp.text[:300]}")
        raise AmassError(f"Gave up after {self.max_retries} retries: {last_exc}")

    def search_union(self, core: str, queries: Iterable[str], limit: int = MAX_LIMIT,
                     dedupe_key: str = "amassId",
                     progress: bool = False) -> list[dict]:
        """Run several queries and union the results, deduped by dedupe_key.

        A single query returns only the top-300 ranked hits with no pagination,
        so unioning distinct query terms is the only way to widen recall.
        """
        seen: set = set()
        out: list[dict] = []
        queries = list(queries)
        for i, query in enumerate(queries):
            if not query:
                continue
            for rec in self.search(core, query, limit=limit):
                key = rec.get(dedupe_key)
                if key is None:
                    out.append(rec)  # keep unkeyed records rather than drop them
                    continue
                if key in seen:
                    continue
                seen.add(key)
                out.append(rec)
            if progress and (i + 1) % 25 == 0:
                print(f"  [{core}] {i + 1}/{len(queries)} queries, {len(out)} unique")
        return out
