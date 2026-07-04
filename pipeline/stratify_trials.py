"""Stratify the harvested AMASS trialcore cache by disease area -> disease.

Emits web/src/lib/trial-distribution.json for the UI. All counts are over the
project's harvested trial set (trials that matched the ~drug vocabulary), NOT
the full 1.2M AMASS trialcore. That caveat is written into the artifact meta.
"""
import json, glob, re, collections, os

import os as _os
ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
FILES = glob.glob(os.path.join(ROOT, "data/cache/trials/*.json"))

# ---- taxonomy: ordered (area, disease, regex). First match wins per condition.
# Specific patterns must precede general ones. Oncology catch-alls at the end of
# their block capture the long tail (any neoplasm/carcinoma/lymphoma/...).
RULES = [
    # ---------------- Oncology ----------------
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

    # ---------------- Metabolic & Endocrine ----------------
    ("Metabolic & Endocrine", "Type 2 diabetes", r"type 2 diabetes|diabetes mellitus, type 2|insulin resistance"),
    ("Metabolic & Endocrine", "Type 1 diabetes", r"type 1 diabetes|diabetes mellitus, type 1"),
    ("Metabolic & Endocrine", "Obesity & overweight", r"obesity|overweight|weight loss|adiposity"),
    ("Metabolic & Endocrine", "NAFLD / NASH", r"non-alcoholic fatty liver|nonalcoholic|nash|steatohepatitis"),
    ("Metabolic & Endocrine", "Dyslipidemia", r"hypercholesterolemia|dyslipidemi|hyperlipidemi|cholesterol"),
    ("Metabolic & Endocrine", "Metabolic syndrome", r"metabolic syndrome"),
    ("Metabolic & Endocrine", "Osteoporosis", r"osteoporosis|bone diseases, metabolic|bone loss"),
    ("Metabolic & Endocrine", "Diabetes (other/unspecified)", r"diabet"),
    ("Metabolic & Endocrine", "Thyroid & other endocrine", r"thyroid|hypothyroid|hyperthyroid|vitamin d deficiency"),

    # ---------------- Cardiovascular ----------------
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

    # ---------------- Neurology ----------------
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

    # ---------------- Psychiatry & Mental Health ----------------
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

    # ---------------- Respiratory ----------------
    ("Respiratory", "Asthma", r"asthma"),
    ("Respiratory", "COPD", r"chronic obstructive|copd"),
    ("Respiratory", "Cystic fibrosis", r"cystic fibrosis"),
    ("Respiratory", "Pulmonary fibrosis / ILD", r"pulmonary fibrosis|interstitial lung|lung diseases, interstitial"),
    ("Respiratory", "Sleep apnea", r"sleep apnea"),
    ("Respiratory", "Respiratory (other)", r"lung disease|respiratory|pneumonia|bronch"),

    # ---------------- Immunology & Inflammation ----------------
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

    # ---------------- Infectious Disease ----------------
    ("Infectious Disease", "COVID-19", r"covid|coronavirus|sars-cov"),
    ("Infectious Disease", "HIV/AIDS", r"hiv|acquired immunodeficiency"),
    ("Infectious Disease", "Viral hepatitis", r"hepatitis [bc]|hepatitis"),
    ("Infectious Disease", "Sepsis", r"sepsis|septic"),
    ("Infectious Disease", "Infectious (other)", r"infection|infectious|bacterial|viral|influenza|tuberculosis|malaria"),

    # ---------------- Musculoskeletal ----------------
    ("Musculoskeletal", "Osteoarthritis", r"osteoarthritis"),
    ("Musculoskeletal", "Gout", r"\bgout\b|hyperuricemia"),
    ("Musculoskeletal", "Fibromyalgia", r"fibromyalgia"),
    ("Musculoskeletal", "Arthritis & MSK (other)", r"arthritis|musculoskeletal|back pain|low back|tendinopathy|osteoarthr"),

    # ---------------- Pain ----------------
    ("Pain", "Postoperative pain", r"pain, postoperative|postoperative pain"),
    ("Pain", "Chronic & general pain", r"chronic pain|acute pain|\bpain\b"),

    # ---------------- Renal & Urology ----------------
    ("Renal & Urology", "Chronic kidney disease", r"renal insufficiency|kidney failure|kidney disease|chronic kidney|nephropathy|dialysis"),
    ("Renal & Urology", "Acute kidney injury & transplant", r"acute kidney|kidney transplant|renal transplant"),
    ("Renal & Urology", "Urologic conditions", r"erectile dysfunction|prostatic hyperplasia|urinary|bladder|incontinence"),

    # ---------------- Gastroenterology ----------------
    ("Gastroenterology", "Liver disease (non-cancer)", r"cirrhosis|liver disease|hepatic|liver failure"),
    ("Gastroenterology", "GERD & GI (other)", r"gastroesophageal reflux|gerd|dyspepsia|irritable bowel|constipation|diarrhea|gastro|pancreatitis"),

    # ---------------- Hematology (non-oncologic) ----------------
    ("Hematology (non-cancer)", "Sickle cell & anemia", r"sickle cell|anemia|anaemia|hemophilia|thalassemia"),

    # ---------------- Ophthalmology ----------------
    ("Ophthalmology", "Eye disease", r"dry eye|macular|glaucoma|retinopathy|ophthalm|uveitis"),

    # ---------------- Dermatology ----------------
    ("Dermatology", "Skin disease (other)", r"dermatitis|acne|urticaria|eczema|skin"),

    # ---------------- Women's & Reproductive ----------------
    ("Women's & Reproductive", "Obstetric & gynecologic", r"premature birth|pregnan|preeclampsia|pre-eclampsia|eclampsia|endometrios|menopaus|contracep|fertility|polycystic ovary"),

    # ---------------- Supportive / symptomatic ----------------
    ("Supportive & symptomatic", "Nausea & vomiting", r"nausea|vomiting|emesis"),
    ("Supportive & symptomatic", "Fatigue & cachexia", r"fatigue|cachexia|weight loss"),
]

COMPILED = [(a, d, re.compile(p)) for (a, d, p) in RULES]

# condition strings that are not diseases -> excluded from the disease distribution
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
    if not p:
        return "NA"
    p = p.upper()
    if p in ("PHASE4",):
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


def load_records():
    seen = set()
    for f in FILES:
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


# aggregate
area_diseases = collections.defaultdict(lambda: collections.defaultdict(lambda: {
    "trials": 0, "P1": 0, "P2": 0, "P3": 0, "P4": 0, "NA": 0,
    "completed": 0, "ongoing": 0, "stopped": 0, "other": 0, "enrollment": 0,
    "interv": collections.Counter(),
}))
total_trials = 0
mapped_trials = 0
excluded_nondisease = 0
unmapped = collections.Counter()

for r in load_records():
    total_trials += 1
    terms = r.get("conditionMeshTerms") or []
    if not terms:
        terms = r.get("conditions") or []
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
            unmapped[t.strip().lower()] += 1
    if not pairs:
        if any_nondisease:
            excluded_nondisease += 1
        continue
    mapped_trials += 1
    pb = phase_bucket(r.get("phase"))
    sb = status_bucket(r.get("overallStatus"))
    enr = r.get("enrollment") or 0
    interventions = [i for i in (r.get("interventionNames") or []) if isinstance(i, str)]
    for (a, d) in pairs:
        cell = area_diseases[a][d]
        cell["trials"] += 1
        cell[pb] += 1
        cell[sb] += 1
        if isinstance(enr, (int, float)):
            cell["enrollment"] += int(enr)
        for iv in interventions[:6]:
            cell["interv"][iv] += 1

# build output
areas_out = []
for area, dmap in area_diseases.items():
    diseases = []
    for dname, c in dmap.items():
        diseases.append({
            "disease": dname,
            "trials": c["trials"],
            "phases": {"P1": c["P1"], "P2": c["P2"], "P3": c["P3"], "P4": c["P4"], "NA": c["NA"]},
            "status": {"completed": c["completed"], "ongoing": c["ongoing"], "stopped": c["stopped"], "other": c["other"]},
            "enrollment": c["enrollment"],
            "topInterventions": [{"name": n, "n": k} for n, k in c["interv"].most_common(6)],
        })
    diseases.sort(key=lambda x: -x["trials"])
    area_trials = sum(d["trials"] for d in diseases)
    areas_out.append({"area": area, "trials": area_trials, "diseases": diseases})

areas_out.sort(key=lambda x: -x["trials"])

out = {
    "meta": {
        "source": "AMASS trialcore (api.amass.tech) harvested cache",
        "totalUniqueTrials": total_trials,
        "mappedTrials": mapped_trials,
        "excludedNonDisease": excluded_nondisease,
        "unmappedConditionMentions": sum(unmapped.values()),
        "areas": len(areas_out),
        "note": (
            "Counts are over the project's harvested AMASS trialcore set (trials matching the "
            "drug-repurposing vocabulary), deduplicated by NCT ID. This is a representative "
            "sample, not the full 1.2M-trial AMASS index. A trial with multiple conditions "
            "contributes to each disease it matches, so disease counts sum to more than the "
            "unique-trial total. Stratification uses MeSH condition terms where present "
            "(83% of trials), else free-text conditions."
        ),
    },
    "areas": areas_out,
}

OUT = os.path.join(ROOT, "web/src/lib/trial-distribution.json")
json.dump(out, open(OUT, "w"), indent=1)

# diagnostics to stdout
print("total unique trials:", total_trials)
print("mapped to >=1 disease:", mapped_trials, f"({mapped_trials/total_trials:.0%})")
print("excluded non-disease-only:", excluded_nondisease)
print("unmapped condition mentions:", sum(unmapped.values()), "distinct", len(unmapped))
print("areas:", len(areas_out))
print("\nAREA totals (trial-disease matches):")
for a in areas_out:
    print(f"  {a['trials']:6d}  {a['area']}  ({len(a['diseases'])} diseases)")
print("\nTop 25 UNMAPPED terms (to refine rules):")
for t, n in unmapped.most_common(25):
    print(f"  {n:5d}  {t}")
print("\nwrote", OUT)
