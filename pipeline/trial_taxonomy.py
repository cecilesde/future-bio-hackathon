"""Shared disease taxonomy for the AMASS trial cache.

Single source of truth for: the MeSH/condition -> (therapeutic area, disease)
classifier, phase/status bucketing, deduplicated record iteration over the
harvested cache, and the aggregate distribution. Used by both
stratify_trials.py (emits the seed JSON) and load_prognosis.py (loads Supabase).
"""
from __future__ import annotations

import collections
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = glob.glob(os.path.join(ROOT, "data/cache/trials/*.json"))

# ordered (area, disease, regex). First match wins per condition. Specific
# patterns precede general ones; oncology/other catch-alls end each block.
RULES = [
    ("Oncology", "Breast cancer", r"breast (neoplasm|cancer|carcinoma)"),
    ("Oncology", "Prostate cancer", r"prostat.*(neoplasm|cancer|carcinoma)|prostatic neoplasms"),
    ("Oncology", "Lung cancer", r"lung (neoplasm|cancer)|non-small-cell lung|small cell lung|nsclc|sclc"),
    ("Oncology", "Colorectal cancer", r"colorectal|colonic neoplasm|rectal neoplasm"),
    ("Oncology", "Melanoma", r"melanoma"),
    ("Oncology", "Multiple myeloma", r"multiple myeloma"),
    ("Oncology", "Leukemia", r"leukemia|leukaemia|myelodysplastic"),
    ("Oncology", "Lymphoma", r"lymphoma|hodgkin"),
    ("Oncology", "Ovarian cancer", r"ovarian neoplasm|ovarian cancer"),
    ("Oncology", "Pancreatic cancer", r"pancreatic neoplasm|pancreatic cancer"),
    ("Oncology", "Liver cancer", r"hepatocellular|liver neoplasm"),
    ("Oncology", "Kidney cancer", r"renal cell|kidney neoplasm"),
    ("Oncology", "Brain cancer / glioma", r"glioblastoma|glioma|brain neoplasm"),
    ("Oncology", "Gastric cancer", r"stomach neoplasm|gastric cancer"),
    ("Oncology", "Head & neck cancer", r"head and neck|squamous cell carcinoma of head"),
    ("Oncology", "Bladder cancer", r"bladder neoplasm|urinary bladder"),
    ("Oncology", "Cervical cancer", r"cervical neoplasm|uterine cervical"),
    ("Oncology", "Sarcoma", r"sarcoma"),
    ("Oncology", "Other solid & blood cancers", r"neoplasm|carcinoma|cancer|tumou?r|malignan|blastoma|oncolog|metastas"),
    ("Metabolic & Endocrine", "Type 2 diabetes", r"type 2 diabetes|diabetes mellitus, type 2|insulin resistance"),
    ("Metabolic & Endocrine", "Type 1 diabetes", r"type 1 diabetes|diabetes mellitus, type 1"),
    ("Metabolic & Endocrine", "Obesity & overweight", r"obesity|overweight|weight loss|adiposity"),
    ("Metabolic & Endocrine", "NAFLD / NASH", r"non-alcoholic fatty liver|nonalcoholic|nash|steatohepatitis"),
    ("Metabolic & Endocrine", "Dyslipidemia", r"hypercholesterolemia|dyslipidemi|hyperlipidemi|cholesterol"),
    ("Metabolic & Endocrine", "Metabolic syndrome", r"metabolic syndrome"),
    ("Metabolic & Endocrine", "Osteoporosis", r"osteoporosis|bone diseases, metabolic|bone loss"),
    ("Metabolic & Endocrine", "Diabetes (other/unspecified)", r"diabet"),
    ("Metabolic & Endocrine", "Thyroid & other endocrine", r"thyroid|hypothyroid|hyperthyroid|vitamin d deficiency"),
    ("Cardiovascular", "Pulmonary hypertension", r"pulmonary arterial hypertension|hypertension, pulmonary"),
    ("Cardiovascular", "Hypertension", r"hypertension"),
    ("Cardiovascular", "Heart failure", r"heart failure"),
    ("Cardiovascular", "Coronary artery disease / ACS", r"coronary|myocardial (infarction|ischemia)|acute coronary|angina|st elevation"),
    ("Cardiovascular", "Atrial fibrillation & arrhythmia", r"atrial fibrillation|arrhythmi|tachycardia"),
    ("Cardiovascular", "Stroke", r"stroke|cerebrovascular"),
    ("Cardiovascular", "Atherosclerosis", r"atherosclerosis"),
    ("Cardiovascular", "Venous thromboembolism", r"venous thrombo|pulmonary embolism|thrombosis|thromboembolism"),
    ("Cardiovascular", "Peripheral arterial disease", r"peripheral arterial|peripheral vascular|claudication"),
    ("Cardiovascular", "Cardiovascular (other)", r"cardiovascular|heart disease|cardiac|coronary disease|vascular disease|hemorrhage"),
    ("Neurology", "Alzheimer's disease", r"alzheimer"),
    ("Neurology", "Parkinson's disease", r"parkinson"),
    ("Neurology", "Migraine & headache", r"migraine|headache|cluster headache"),
    ("Neurology", "Epilepsy", r"epilep|seizure|convulsion"),
    ("Neurology", "Multiple sclerosis", r"multiple sclerosis"),
    ("Neurology", "ALS & motor neuron", r"amyotrophic lateral sclerosis|motor neuron|muscular atrophy, spinal"),
    ("Neurology", "Dementia & cognitive impairment", r"dementia|cognitive (dysfunction|impairment)|agnosia|mild cognitive"),
    ("Neurology", "Neuropathy & neuropathic pain", r"neuralgia|neuropath"),
    ("Neurology", "Brain & spinal cord injury", r"brain injur|traumatic brain|spinal cord injur|concussion"),
    ("Neurology", "Restless legs & movement", r"restless legs|dystonia|tremor|huntington"),
    ("Psychiatry & Mental Health", "Schizophrenia & psychosis", r"schizophreni|psychotic|psychosis"),
    ("Psychiatry & Mental Health", "Depression", r"depress|mood disorder"),
    ("Psychiatry & Mental Health", "Bipolar disorder", r"bipolar|mania"),
    ("Psychiatry & Mental Health", "ADHD", r"attention deficit|hyperactivity"),
    ("Psychiatry & Mental Health", "Anxiety & PTSD", r"anxiety|post-traumatic|panic|obsessive"),
    ("Psychiatry & Mental Health", "Substance use disorders", r"alcoholism|alcohol use|opioid|substance-related|cocaine|tobacco use|smoking cessation|nicotine|addiction|substance use|marijuana|cannabis|behavior, addictive|drug abuse"),
    ("Psychiatry & Mental Health", "Delirium", r"delirium"),
    ("Psychiatry & Mental Health", "Autism spectrum", r"autis"),
    ("Psychiatry & Mental Health", "Sleep disorders", r"sleep initiation|sleep wake|insomnia|sleep disorder"),
    ("Psychiatry & Mental Health", "Other mental health", r"mental disorder"),
    ("Respiratory", "Asthma", r"asthma"),
    ("Respiratory", "COPD", r"chronic obstructive|copd"),
    ("Respiratory", "Cystic fibrosis", r"cystic fibrosis"),
    ("Respiratory", "Pulmonary fibrosis / ILD", r"pulmonary fibrosis|interstitial lung|lung diseases, interstitial"),
    ("Respiratory", "Sleep apnea", r"sleep apnea"),
    ("Respiratory", "Respiratory (other)", r"lung disease|respiratory|pneumonia|bronch"),
    ("Immunology & Inflammation", "Rheumatoid arthritis", r"arthritis, rheumatoid|rheumatoid arthritis"),
    ("Immunology & Inflammation", "Psoriasis & psoriatic arthritis", r"psorias"),
    ("Immunology & Inflammation", "Inflammatory bowel disease", r"crohn|ulcerative coliti|inflammatory bowel"),
    ("Immunology & Inflammation", "Lupus", r"lupus"),
    ("Immunology & Inflammation", "Ankylosing spondylitis", r"spondyliti|ankylosing"),
    ("Immunology & Inflammation", "Atopic dermatitis", r"atopic|dermatitis, atopic"),
    ("Immunology & Inflammation", "Allergic rhinitis & allergy", r"rhinitis|allerg"),
    ("Immunology & Inflammation", "Graft-vs-host & transplant immunity", r"graft vs host|graft-versus-host|transplant"),
    ("Immunology & Inflammation", "Scleroderma & connective tissue", r"scleroderma|connective tissue|sjogren|vasculiti"),
    ("Immunology & Inflammation", "Autoimmune / inflammatory (other)", r"autoimmune|hypersensitiv|inflammation|colitis"),
    ("Infectious Disease", "COVID-19", r"covid|coronavirus|sars-cov"),
    ("Infectious Disease", "HIV/AIDS", r"hiv|acquired immunodeficiency"),
    ("Infectious Disease", "Viral hepatitis", r"hepatitis [bc]|hepatitis"),
    ("Infectious Disease", "Sepsis", r"sepsis|septic"),
    ("Infectious Disease", "Infectious (other)", r"infection|infectious|bacterial|viral|influenza|tuberculosis|malaria"),
    ("Musculoskeletal", "Osteoarthritis", r"osteoarthritis"),
    ("Musculoskeletal", "Gout", r"\bgout\b|hyperuricemia"),
    ("Musculoskeletal", "Fibromyalgia", r"fibromyalgia"),
    ("Musculoskeletal", "Arthritis & MSK (other)", r"arthritis|musculoskeletal|back pain|low back|tendinopathy|osteoarthr"),
    ("Pain", "Postoperative pain", r"pain, postoperative|postoperative pain"),
    ("Pain", "Chronic & general pain", r"chronic pain|acute pain|\bpain\b"),
    ("Renal & Urology", "Chronic kidney disease", r"renal insufficiency|kidney failure|kidney disease|chronic kidney|nephropathy|dialysis"),
    ("Renal & Urology", "Acute kidney injury & transplant", r"acute kidney|kidney transplant|renal transplant"),
    ("Renal & Urology", "Urologic conditions", r"erectile dysfunction|prostatic hyperplasia|urinary|bladder|incontinence"),
    ("Gastroenterology", "Liver disease (non-cancer)", r"cirrhosis|liver disease|hepatic|liver failure"),
    ("Gastroenterology", "GERD & GI (other)", r"gastroesophageal reflux|gerd|dyspepsia|irritable bowel|constipation|diarrhea|gastro|pancreatitis"),
    ("Hematology (non-cancer)", "Sickle cell & anemia", r"sickle cell|anemia|anaemia|hemophilia|thalassemia"),
    ("Ophthalmology", "Eye disease", r"dry eye|macular|glaucoma|retinopathy|ophthalm|uveitis"),
    ("Dermatology", "Skin disease (other)", r"dermatitis|acne|urticaria|eczema|skin"),
    ("Women's & Reproductive", "Obstetric & gynecologic", r"premature birth|pregnan|preeclampsia|pre-eclampsia|eclampsia|endometrios|menopaus|contracep|fertility|polycystic ovary"),
    ("Supportive & symptomatic", "Nausea & vomiting", r"nausea|vomiting|emesis"),
    ("Supportive & symptomatic", "Fatigue & cachexia", r"fatigue|cachexia|weight loss"),
]

COMPILED = [(a, d, re.compile(p)) for (a, d, p) in RULES]

NONDISEASE = re.compile(
    r"^(healthy|healthy volunteers?|healthy subjects?|healthy participants?|volunteers?|motor activity|"
    r"recurrence|disease|emergencies|smoking|tobacco use disorder|quality of life|prevention|aging|adult|"
    r"inflammation|pharmacokinetics|pharmacodynamics|drug interaction|bioequivalence|safety|wounds and injuries|"
    r"congenital abnormalities|body weight|blood pressure)$"
)


def classify(text):
    t = text.strip().lower()
    if not t or NONDISEASE.match(t):
        return None
    for a, d, rx in COMPILED:
        if rx.search(t):
            return (a, d)
    return None


def phase_bucket(p):
    p = (p or "").upper()
    if p == "PHASE4":
        return "P4"
    if p in ("PHASE3", "PHASE2/PHASE3"):
        return "P3"
    if p in ("PHASE2", "PHASE1/PHASE2"):
        return "P2"
    if p in ("PHASE1", "EARLY_PHASE1"):
        return "P1"
    return "NA"


def status_bucket(s):
    s = (s or "").upper()
    if s == "COMPLETED":
        return "completed"
    if s in ("RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION", "NOT_YET_RECRUITING"):
        return "ongoing"
    if s in ("TERMINATED", "WITHDRAWN", "SUSPENDED"):
        return "stopped"
    return "other"


def load_records(files=None):
    """Yield each unique trial record from the harvested cache (dedup by nctId)."""
    seen = set()
    for f in (files or FILES):
        try:
            data = json.load(open(f))
        except Exception:
            continue
        if isinstance(data, list):
            recs = data
        elif isinstance(data, dict) and "data" in data:
            recs = data["data"]
        elif isinstance(data, dict):
            recs = sum([v for v in data.values() if isinstance(v, list)], [])
        else:
            recs = []
        for r in recs:
            if not isinstance(r, dict):
                continue
            nid = r.get("nctId") or r.get("amassId")
            if nid in seen:
                continue
            seen.add(nid)
            yield r


def diseases_for(rec):
    """Return the set of (area, disease) a trial maps to. MeSH terms preferred."""
    terms = rec.get("conditionMeshTerms") or rec.get("conditions") or []
    pairs = set()
    for t in terms:
        if isinstance(t, str):
            res = classify(t)
            if res:
                pairs.add(res)
    return pairs


def aggregate():
    """Full distribution: {meta, areas:[{area, trials, diseases:[...]}]}.

    Mirrors the shape the UI/Supabase serving layer expects.
    """
    cells = collections.defaultdict(lambda: {
        "trials": 0, "P1": 0, "P2": 0, "P3": 0, "P4": 0, "NA": 0,
        "completed": 0, "ongoing": 0, "stopped": 0, "other": 0, "enrollment": 0,
    })
    total = mapped = excluded = 0
    unmapped_mentions = 0
    for r in load_records():
        total += 1
        terms = r.get("conditionMeshTerms") or r.get("conditions") or []
        pairs = set()
        any_nondisease = False
        for t in terms:
            if not isinstance(t, str):
                continue
            res = classify(t)
            if res:
                pairs.add(res)
            elif NONDISEASE.match(t.strip().lower()):
                any_nondisease = True
            else:
                unmapped_mentions += 1
        if not pairs:
            if any_nondisease:
                excluded += 1
            continue
        mapped += 1
        pb, sb = phase_bucket(r.get("phase")), status_bucket(r.get("overallStatus"))
        enr = r.get("enrollment") or 0
        for key in pairs:
            c = cells[key]
            c["trials"] += 1
            c[pb] += 1
            c[sb] += 1
            if isinstance(enr, (int, float)):
                c["enrollment"] += int(enr)

    by_area = collections.defaultdict(list)
    for (area, disease), c in cells.items():
        by_area[area].append({
            "disease": disease,
            "trials": c["trials"],
            "phases": {k: c[k] for k in ("P1", "P2", "P3", "P4", "NA")},
            "status": {k: c[k] for k in ("completed", "ongoing", "stopped", "other")},
            "enrollment": c["enrollment"],
        })
    areas = []
    for area, ds in by_area.items():
        ds.sort(key=lambda x: -x["trials"])
        areas.append({"area": area, "trials": sum(d["trials"] for d in ds), "diseases": ds})
    areas.sort(key=lambda x: -x["trials"])

    meta = {
        "source": "AMASS trialcore (api.amass.tech) harvested cache",
        "totalUniqueTrials": total,
        "mappedTrials": mapped,
        "excludedNonDisease": excluded,
        "unmappedConditionMentions": unmapped_mentions,
        "areas": len(areas),
        "note": (
            "Counts are over the project's harvested AMASS trialcore set (trials matching the "
            "drug-repurposing vocabulary), deduplicated by NCT ID. This is a representative "
            "sample, not the full 1.2M-trial AMASS index. A trial with multiple conditions "
            "contributes to each disease it matches, so disease counts sum to more than the "
            "unique-trial total. Stratification uses MeSH condition terms where present, else "
            "free-text conditions."
        ),
    }
    return {"meta": meta, "areas": areas}
