"""LLM reasoning layer: rank repurposing candidates over the Amass evidence.

The deterministic engine (repurposing.py) assembles objective trial/regulatory
evidence. This layer hands that evidence to Claude and lets it:
  - separate genuinely NOVEL repurposing candidates from the drug's already-
    approved indications and from noise (comparator arms, secondary endpoints),
  - pull extra mechanistic literature from Amass on demand (agentic tool-use),
  - emit a ranked, structured report with an explicit rationale, the supporting
    trial IDs, and a calibrated confidence per candidate.

Requires ANTHROPIC_API_KEY. The model is configurable via AMASS_AGENT_MODEL.
"""

from __future__ import annotations

import json
import os

from amass_client import AmassClient
from repurposing import DrugEvidence

DEFAULT_MODEL = os.environ.get("AMASS_AGENT_MODEL", "claude-fable-5")

SYSTEM = """You are a drug-repurposing analyst. You are given structured evidence \
about an APPROVED drug, assembled from the Amass life-sciences database (clinical \
trials, regulatory authorizations, drug mechanism). Your job: identify indications \
OTHER than the drug's originally approved indication(s) that it may be useful for, \
grounded strictly in evidence.

Rules:
- Ground every claim in the provided evidence or in results you retrieve with the \
tools. Do NOT invent trials, phases, or outcomes. If evidence is weak, say so.
- Distinguish clearly: (a) already-approved indications (exclude these from \
"repurposing candidates" but list them as known), (b) actively-investigated \
candidates with trial evidence, (c) mechanism-based hypotheses with only literature \
support.
- Treat a raw trial condition as weak on its own: a phase-4 tag can come from a \
comparator arm or a secondary endpoint, not a dedicated efficacy study. Use the \
search_trials / search_literature tools to check the strongest candidates before \
assigning high confidence.
- Confidence must reflect evidence quality: completed phase 2/3 trials with posted \
results in the target indication = higher; a single early-phase or mechanism-only \
signal = lower.
- When done, call submit_report exactly once with the structured result. Do not \
write prose outside the tool call."""

TOOLS = [
    {
        "name": "search_trials",
        "description": "Full-text search Amass TrialCore for clinical trials. Use to "
                       "verify a candidate indication: how many dedicated trials, what "
                       "phase, completed?, results posted?",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string",
                          "description": "e.g. 'semaglutide Alzheimer disease'"},
                "limit": {"type": "integer", "default": 20},
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_literature",
        "description": "Full-text search Amass BiomedCore (40M+ papers) for mechanistic "
                       "or clinical evidence supporting a drug-indication hypothesis.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "submit_report",
        "description": "Submit the final ranked repurposing report. Call exactly once.",
        "input_schema": {
            "type": "object",
            "properties": {
                "drug": {"type": "string"},
                "approved_indications_summary": {
                    "type": "string",
                    "description": "Brief plain-language summary of what the drug is "
                                   "already approved for.",
                },
                "candidates": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "indication": {"type": "string"},
                            "evidence_tier": {
                                "type": "string",
                                "enum": ["clinical_trial", "mechanism_or_literature"],
                            },
                            "furthest_phase": {"type": "string"},
                            "supporting_trials": {
                                "type": "array", "items": {"type": "string"},
                                "description": "NCT IDs backing this candidate",
                            },
                            "rationale": {"type": "string"},
                            "confidence": {
                                "type": "string",
                                "enum": ["high", "medium", "low"],
                            },
                        },
                        "required": ["indication", "evidence_tier", "rationale",
                                     "confidence"],
                    },
                },
            },
            "required": ["drug", "candidates"],
        },
    },
]


def _run_tool(client: AmassClient, name: str, args: dict) -> str:
    """Execute an agent tool call and return a compact JSON string for the model.

    We trim fields hard here so retrieved records don't blow up the context; this
    is the token-efficiency lever (server can't filter for us)."""
    if name == "search_trials":
        rows = client.search("trialcore", args["query"], limit=min(args.get("limit", 20), 50))
        trimmed = [{
            "nctId": r.get("nctId"),
            "phase": r.get("phase"),
            "status": r.get("overallStatus"),
            "hasResults": r.get("hasResults"),
            "conditions": (r.get("conditionMeshTerms") or r.get("conditions") or [])[:4],
            "title": (r.get("briefTitle") or "")[:120],
        } for r in rows]
        return json.dumps({"count": len(trimmed), "trials": trimmed})
    if name == "search_literature":
        rows = client.search("biomedcore", args["query"], limit=min(args.get("limit", 10), 25))
        trimmed = [{
            "pmid": r.get("pmid"),
            "doi": r.get("doi"),
            "year": (r.get("publicationDate") or "")[:4],
            "title": r.get("title"),
            "abstract": (r.get("abstract") or "")[:400],
        } for r in rows]
        return json.dumps({"count": len(trimmed), "papers": trimmed})
    return json.dumps({"error": f"unknown tool {name}"})


def rank_repurposing_candidates(client: AmassClient, ev: DrugEvidence,
                                model: str | None = None, max_turns: int = 12) -> str:
    """Run the agentic loop; return a formatted repurposing report string."""
    try:
        import anthropic
    except ImportError:
        return "anthropic SDK not installed. `pip install anthropic`."
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return ("ANTHROPIC_API_KEY not set. The deterministic evidence above is "
                "complete; add the key to enable LLM ranking.")

    llm = anthropic.Anthropic()
    model = model or DEFAULT_MODEL

    # Feed the deterministic evidence (trim indications to the top 40 for context).
    evidence = json.loads(ev.to_json())
    evidence["indications"] = evidence["indications"][:40]
    user = ("Here is the assembled Amass evidence for the drug. Identify repurposing "
            "candidates (indications beyond what it is already approved for), verify "
            "the strongest ones with the tools, then call submit_report.\n\n"
            + json.dumps(evidence))

    messages = [{"role": "user", "content": user}]
    for _ in range(max_turns):
        resp = llm.messages.create(
            model=model, max_tokens=4096, system=SYSTEM,
            tools=TOOLS, messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})

        if resp.stop_reason != "tool_use":
            # model spoke without a tool call; return whatever text it produced
            return "".join(b.text for b in resp.content if b.type == "text") or \
                   "(model produced no report)"

        tool_results = []
        report = None
        for block in resp.content:
            if block.type != "tool_use":
                continue
            if block.name == "submit_report":
                report = block.input
                tool_results.append({
                    "type": "tool_result", "tool_use_id": block.id,
                    "content": "Report received.",
                })
            else:
                out = _run_tool(client, block.name, block.input)
                tool_results.append({
                    "type": "tool_result", "tool_use_id": block.id, "content": out,
                })
        messages.append({"role": "user", "content": tool_results})
        if report is not None:
            return _format_report(report)

    return "Reached max turns without a submitted report."


def _format_report(r: dict) -> str:
    lines = [f"Drug: {r.get('drug')}"]
    if r.get("approved_indications_summary"):
        lines.append(f"Already approved for: {r['approved_indications_summary']}")
    lines.append("")
    lines.append("REPURPOSING CANDIDATES (ranked):")
    for i, c in enumerate(r.get("candidates", []), 1):
        trials = ", ".join(c.get("supporting_trials", []) or []) or "-"
        lines.append(
            f"\n{i}. {c['indication']}  [{c['confidence'].upper()} confidence, "
            f"{c['evidence_tier']}, phase={c.get('furthest_phase', 'NA')}]"
        )
        lines.append(f"   trials: {trials}")
        lines.append(f"   rationale: {c['rationale']}")
    return "\n".join(lines)
