"""Open Targets Platform client — the target-generation step of the pipeline.

Given a disease (EFO/MONDO id, or a name to resolve), returns the targets most
strongly associated with it, with the overall association score and the
per-datatype evidence breakdown. This is the real `Disease -> OpenTargets ->
Targets` edge of the architecture: targets are generated from Open Targets, not
hand-picked.

Public GraphQL API, no key required.
"""
from __future__ import annotations

import requests

API = "https://api.platform.opentargets.org/api/v4/graphql"

# datatype id -> UI-facing evidence label
DATATYPE_LABELS = {
    "genetic_association": "Genetic association",
    "genetic_literature": "Genetic (literature)",
    "somatic_mutation": "Somatic mutation",
    "known_drug": "Drugs (approved/clinical)",
    "affected_pathway": "Pathways",
    "literature": "Literature",
    "rna_expression": "Expression",
    "animal_model": "Animal models",
    "clinical": "Clinical",
}


def _post(query: str, variables: dict) -> dict:
    r = requests.post(API, json={"query": query, "variables": variables}, timeout=45)
    r.raise_for_status()
    body = r.json()
    if "errors" in body:
        raise RuntimeError(f"Open Targets GraphQL error: {body['errors']}")
    return body["data"]


def resolve_disease(name: str) -> dict | None:
    """Resolve a disease name to an Open Targets disease entity, preferring
    EFO/MONDO ids over phenotype (HP) ids."""
    q = """query($q:String!){search(queryString:$q,entityNames:["disease"],
        page:{index:0,size:5}){hits{id name entity}}}"""
    hits = _post(q, {"q": name})["search"]["hits"]
    if not hits:
        return None
    for h in hits:
        if h["id"].startswith(("MONDO", "EFO")):
            return h
    return hits[0]


def associated_targets(efo_id: str, size: int = 12) -> list[dict]:
    """Top associated targets for a disease id, ranked by overall association."""
    q = """query($efo:String!,$size:Int!){
      disease(efoId:$efo){
        id name
        associatedTargets(page:{index:0,size:$size}){
          count
          rows{
            score
            target{id approvedSymbol approvedName}
            datatypeScores{id score}
          }
        }
      }
    }"""
    d = _post(q, {"efo": efo_id, "size": size})["disease"]
    if not d:
        return []
    out = []
    for row in d["associatedTargets"]["rows"]:
        dts = {x["id"]: x["score"] for x in row["datatypeScores"]}
        # evidence chips: strongest datatypes first, mapped to friendly labels
        top = sorted(dts.items(), key=lambda kv: -kv[1])
        evidence = [DATATYPE_LABELS.get(k, k.replace("_", " ").title())
                    for k, v in top if v >= 0.1][:4]
        out.append({
            "symbol": row["target"]["approvedSymbol"],
            "ensembl_id": row["target"]["id"],
            "name": row["target"]["approvedName"],
            "association": round(row["score"], 3),
            "datatype_scores": {k: round(v, 3) for k, v in dts.items()},
            "evidence": evidence,
        })
    return out


def resolve_target(symbol: str) -> dict | None:
    """Resolve a gene symbol to an Open Targets target (Ensembl id + name)."""
    q = """query($s:String!){search(queryString:$s,entityNames:["target"],
        page:{index:0,size:1}){hits{id name}}}"""
    hits = _post(q, {"s": symbol})["search"]["hits"]
    return hits[0] if hits else None


def association_for(symbol: str, efo_id: str) -> dict | None:
    """Association of a specific target to a specific disease, for targets that
    fall outside a disease's top-N (e.g. a well-known but lower-ranked target we
    still want selectable). Returns None if the pair is not associated."""
    tgt = resolve_target(symbol)
    if not tgt:
        return None
    q = """query($t:String!){target(ensemblId:$t){approvedSymbol approvedName
        associatedDiseases{rows{score disease{id} datatypeScores{id score}}}}}"""
    d = _post(q, {"t": tgt["id"]})["target"]
    for row in d["associatedDiseases"]["rows"]:
        if row["disease"]["id"] == efo_id:
            dts = {x["id"]: x["score"] for x in row["datatypeScores"]}
            top = sorted(dts.items(), key=lambda kv: -kv[1])
            evidence = [DATATYPE_LABELS.get(k, k.replace("_", " ").title())
                        for k, v in top if v >= 0.1][:4]
            return {
                "symbol": d["approvedSymbol"],
                "ensembl_id": tgt["id"],
                "name": d["approvedName"],
                "association": round(row["score"], 3),
                "datatype_scores": {k: round(v, 3) for k, v in dts.items()},
                "evidence": evidence,
            }
    return None


if __name__ == "__main__":
    import json
    import sys
    name = sys.argv[1] if len(sys.argv) > 1 else "obesity"
    dis = resolve_disease(name)
    print("resolved:", dis)
    if dis:
        print(json.dumps(associated_targets(dis["id"], 8), indent=2))
