"""Gør rå jobopslag til de felter, Studiematchs matching bruger.

To lag:
1. Regler (kører altid, gratis): studiejob ja/nej, felt, sprogkrav, timer, by og kompetencer.
2. AI (valgfri): hvis ANTHROPIC_API_KEY er sat, læser en AI-model opslaget og forbedrer felterne
   og skriver en kort dansk beskrivelse. Svaret gemmes i cache.json, så hvert job kun læses én gang.
"""
from __future__ import annotations

import json
import os
import re

import requests

FAMILIES = [
    "supply", "procurement", "pmo", "bizdev", "strategy", "salesops", "logistics", "operations", "bi",
    "finance", "marketing", "product", "software", "datasci", "hr", "sustain", "customer", "legal",
    "research", "engineering", "health", "education", "social", "public",
]

# Ord i titel og tekst, der peger på et felt. Titelord vægter 3, tekstord 1.
FAMILY_WORDS = {
    "supply": ["supply chain", "demand", "planning", "planlægning", "forsyningskæde", "lager", "inventory"],
    "procurement": ["procurement", "purchasing", "sourcing", "indkøb", "buyer", "leverandør"],
    "pmo": ["project", "projekt", "pmo", "koordinator", "coordinator"],
    "bizdev": ["business development", "forretningsudvikling", "partnership", "growth", "lead generation"],
    "strategy": ["strategy", "strategi", "consult", "konsulent", "analyse og politik", "politik", "public affairs"],
    "salesops": ["sales", "salg", "crm", "commercial"],
    "logistics": ["logistics", "logistik", "transport", "freight", "fragt", "shipping", "spedition"],
    "operations": ["operations", "drift", "process", "proces", "production", "produktion", "lean"],
    "bi": ["business intelligence", "power bi", "data analyst", "dataanalytiker", "analytics", "rapportering", "reporting", "tableau", "sql"],
    "finance": ["finance", "økonomi", "controlling", "accounting", "regnskab", "revision", "audit", "bogholder", "bogføring", "skat", "løn", "payroll"],
    "marketing": ["marketing", "kommunikation", "communication", "content", "brand", "sociale medier", "social media", "seo", "presse"],
    "product": ["product", "produkt", " ux", "ux ", "design", "figma", "user research"],
    "software": ["software", "developer", "udvikler", "frontend", "backend", "full stack", "programmør", "it-support", "it support", "it operations"],
    "datasci": ["data scien", "machine learning", "bioinformatic", "ai ", "artificial intelligence", "python"],
    "hr": ["hr ", "human resources", "rekruttering", "recruit", "people", "talent", "onboarding"],
    "sustain": ["esg", "bæredygtig", "sustainab", "klima", "climate", "miljø", "csrd"],
    "customer": ["customer", "kunde", "support", "service", "reception", "call"],
    "legal": ["legal", "jura", "juridisk", "jurist", "advokat", "kontrakt", "contract", "compliance", "erhvervsjura", "opholds"],
    "research": ["research", "forskning", "laborator", "lab ", "videnskabelig", "studie "],
    "engineering": ["mekanisk", "mechanical", "konstruktion", "cad", "ingeniør", "engineer", "elektronik", "electronics", "maskinmester", "skibsfører", "skibsofficer", "el-installatør", "elektriker", "bygningskonstruktør", "arkitekt", "tekniker"],
    "health": ["sygepleje", "læge", "medicin", "patient", "hospital", "klinik", "sundhed", "pleje", "tandlæge", "tandpleje", "vagt"],
    "education": ["pædagog", "lærer", "lektie", "undervis", "sfo", "skole", "børn", "instruktor", "teaching"],
    "social": ["social", "bosted", "rådgiv", "familie", "udsatte"],
    "public": ["kommune", "styrelse", "ministeri", "region ", "offentlig", "forvaltning", "borgerservice", "sagsbehandl"],
}

SKILLS = ["Excel", "Bogføring", "Regnskab", "Løn", "Power BI", "SQL", "Python", "SAP", "Salesforce", "Tableau", "Lean",
          "Figma", "JavaScript", "React", "Statistik", "R", "PowerPoint", "CRM", "CAD", "LCA", "Stata", "SPSS",
          "Dokumentation", "Kundeservice", "Rekruttering", "Copywriting", "Sociale medier", "Projektkoordinering",
          "Dataanalyse", "Forhandling", "Blodprøvetagning", "Patientkontakt"]

STUDENT_RE = re.compile(
    r"student|studentermedhjælp|studentermedarbejder|studiejob|studerende|studenterjob|working student|"
    r"student assistant|student worker|deltidsjob for studerende|praktikant|internship|\bintern\b", re.I)
SENIOR_RE = re.compile(r"\b(senior|lead|head of|director|chef|manager|direktør|leder)\b", re.I)

DANISH_REQUIRED = ["flydende dansk", "taler og skriver dansk", "mestrer dansk", "dansk på modersmål", "fluent in danish",
                   "fluent danish", "danish is required", "danish is a requirement", "native danish", "skal kunne tale dansk",
                   "både dansk og engelsk", "danish and english", "fluency in danish"]
DANISH_PLUS = ["dansk er en fordel", "danish is a plus", "danish is an advantage", "danish skills are a plus",
               "danish is nice to have", "kendskab til dansk"]
DANISH_STOPWORDS = [" og ", " at ", " du ", " vi ", " er ", " til ", " med ", " på ", " har ", " som ", " kan "]

CITY_REGION = {
    "københavn": "cph", "copenhagen": "cph", "frederiksberg": "cph", "lyngby": "cph", "ballerup": "cph",
    "søborg": "cph", "hvidovre": "cph", "glostrup": "cph", "kastrup": "cph", "valby": "cph", "herlev": "cph",
    "hellerup": "cph", "gentofte": "cph", "taastrup": "cph", "brøndby": "cph", "rødovre": "cph", "albertslund": "cph",
    "roskilde": "cph", "køge": "cph", "hillerød": "cph", "ishøj": "cph", "amager": "cph", "ørestad": "cph",
    "aarhus": "aar", "århus": "aar", "horsens": "aar", "herning": "aar", "randers": "aar", "silkeborg": "aar", "viby": "aar",
    "odense": "ode", "kolding": "ode", "vejle": "ode", "svendborg": "ode", "esbjerg": "ode", "sønderborg": "ode", "fredericia": "ode",
    "aalborg": "aal", "hjørring": "aal", "nørresundby": "aal",
    "remote": "remote", "hjemmefra": "remote", "fjernarbejde": "remote",
}


# Stillinger, der aldrig er studiejob, selvom "studerende" står i teksten
NOT_STUDENT_RE = re.compile(
    r"ph\.?\s?d|postdoc|professor|lektor|adjunkt|introduktionsstilling|hoveduddannelse|overlæge|afdelingslæge|"
    r"speciallæge|barselsvikar|underviser|teaching assistant professorship|fellowship", re.I)
# Kun disse udtryk i selve teksten tæller, når titlen ikke siger det
STUDENT_TEXT_RE = re.compile(
    r"studentermedhjælp|studentermedarbejder|student assistant|student worker|working student|studiejob|"
    r"ved siden af (?:dit|dine) studi|sideløbende med (?:dit|dine) studi|while (?:you are )?studying|"
    r"part-time student|deltidsjob for studerende", re.I)


# Svenske og norske opslag fra nordiske koncerner (fx "studentmedarbetare", "vi söker")
FOREIGN_NORDIC_RE = re.compile(r"medarbetare|vi söker|tjänst|ansökan|söknad|stillingen er ledig i norge|arbeidssted", re.I)


def is_student_job(title: str, text: str, commitment: str = "") -> bool:
    if FOREIGN_NORDIC_RE.search(title) or len(FOREIGN_NORDIC_RE.findall(text[:2000])) >= 2:
        return False
    if NOT_STUDENT_RE.search(title):
        return False
    hours = detect_hours(text)
    if hours[0] >= 30 and not re.search(r"praktik|intern", title, re.I):
        return False  # fuldtid er ikke et studiejob (praktik kan godt være fuldtid)
    if STUDENT_RE.search(title) or STUDENT_RE.search(commitment or ""):
        return True
    if SENIOR_RE.search(title) or re.search(
            r"konsulent|koordinator|tekniker|serviceassistent|rådgiver|psykolog|afløser|weekend", title, re.I):
        return False
    return bool(STUDENT_TEXT_RE.search(text[:2500]))


def classify_families(title: str, text: str) -> tuple[str, list[str]]:
    t, d = f" {title.lower()} ", f" {text.lower()} "
    scores = {}
    for fam, words in FAMILY_WORDS.items():
        s = sum(3 for w in words if w in t) + sum(1 for w in words if w in d)
        if s:
            scores[fam] = s
    if not scores:
        return "operations", []
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    top = ranked[0][1]
    return ranked[0][0], [f for f, s in ranked[1:3] if s >= 0.4 * top]


def detect_danish(text: str) -> str:
    low = f" {text.lower()} "
    if any(p in low for p in DANISH_REQUIRED):
        return "required"
    if any(p in low for p in DANISH_PLUS):
        return "plus"
    danish_hits = sum(low.count(w) for w in DANISH_STOPWORDS)
    return "required" if danish_hits >= 8 else "no"  # et opslag skrevet på dansk kræver næsten altid dansk


def detect_hours(text: str) -> tuple[int, int]:
    low = text.lower()
    m = re.search(r"(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(timer|t\.|hours|hrs|t/uge)", low)
    if m:
        a, b = int(m[1]), int(m[2])
        if 0 < a <= b <= 40:
            return a, b
    m = re.search(r"(\d{1,2})\s*(timer|hours|t\.)\s*(om|pr\.?|per|a|i)\s*(ugen|uge|week)", low)
    if m and 0 < int(m[1]) <= 40:
        return int(m[1]), int(m[1])
    return 0, 0  # ukendt: siden viser "Timer: se opslag"


def detect_region(location: str, fallback: str) -> tuple[str, str]:
    low = (location or "").lower()
    for city, region in CITY_REGION.items():
        if city in low:
            return region, location or city.title()
    return fallback, location or ""


def detect_skills(text: str) -> list[str]:
    low = f" {text.lower()} "
    found = [s for s in SKILLS if re.search(rf"(?<![a-zæøå]){re.escape(s.lower())}(?![a-zæøå])", low)]
    return found[:6]


def make_blurb(text: str, limit: int = 220) -> str:
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    blurb = ""
    for s in sentences:
        if len(blurb) + len(s) > limit:
            break
        blurb = f"{blurb} {s}".strip()
    return blurb or text[:limit].rsplit(" ", 1)[0] + "…" if text else ""


def enrich_rules(raw: dict, employer: dict) -> dict | None:
    title, text = raw["title"], raw.get("description", "")
    if not title or not is_student_job(title, text, raw.get("commitment", "")):
        return None
    fam, sec = classify_families(title, text)
    h_min, h_max = detect_hours(text)
    region, city = detect_region(raw.get("location", ""), employer.get("region") or "cph")
    return {
        "title": title,
        "co": raw.get("company") or employer["name"],
        "city": city or employer.get("city", ""),
        "region": region,
        "hMin": h_min, "hMax": h_max,
        "danish": detect_danish(f"{title} {text}"),
        "fam": fam, "sec": sec,
        "skills": detect_skills(text),
        "industry": employer.get("industry") or "Andet",
        "postedAt": raw.get("posted_at"),
        "deadlineAt": raw.get("deadline_at"),
        "src": raw.get("source", "Virksomhedens karriereside"),
        "blurb": make_blurb(text),
        "url": raw.get("url", ""),
        "enrichedBy": "regler",
    }


# ---------- AI-laget ----------
AI_MODEL = os.environ.get("STUDIEMATCH_MODEL", "claude-haiku-5-5")
AI_URL = "https://api.anthropic.com/v1/messages"

PROMPT = """Du hjælper en dansk side, der anbefaler studiejob til studerende. Læs jobopslaget og svar KUN med JSON.

Felter:
- "is_student_job": true hvis jobbet er et studiejob, studentermedhjælper-job, deltidsjob for studerende eller praktik. Ellers false.
- "fam": det felt, jobbet bedst hører til. Vælg præcis én af: {families}
- "sec": op til 2 andre felter fra samme liste, som arbejdet også handler om.
- "danish": "required" hvis jobbet kræver dansk, "plus" hvis dansk er en fordel, "no" hvis engelsk er nok.
- "h_min", "h_max": timer om ugen som heltal, eller null hvis det ikke står.
- "skills": op til 5 konkrete kompetencer, opslaget efterspørger (korte navne).
- "deadline": ansøgningsfrist som "YYYY-MM-DD", eller null.
- "blurb_da": 1-2 korte sætninger på dansk om, hvad man laver i jobbet. Skriv konkret, uden reklamesprog.

Jobopslag:
Titel: {title}
Arbejdsgiver: {company}
Sted: {location}
Tekst: {text}
"""


def enrich_ai(raw: dict, base: dict, api_key: str) -> dict:
    """Forbedrer et regel-beriget job med AI. Returnerer base uændret, hvis noget går galt."""
    prompt = PROMPT.format(families=", ".join(FAMILIES), title=raw["title"], company=base["co"],
                           location=raw.get("location", ""), text=raw.get("description", "")[:6000])
    try:
        resp = requests.post(AI_URL, timeout=60, headers={
            "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json",
        }, json={"model": AI_MODEL, "max_tokens": 600, "messages": [{"role": "user", "content": prompt}]})
        resp.raise_for_status()
        text = "".join(part.get("text", "") for part in resp.json().get("content", []))
        data = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except (requests.RequestException, ValueError, KeyError):
        return base
    if data.get("is_student_job") is False:
        return {**base, "skip": True}
    out = dict(base)
    if data.get("fam") in FAMILIES:
        out["fam"] = data["fam"]
        out["sec"] = [f for f in data.get("sec") or [] if f in FAMILIES and f != data["fam"]][:2]
    if data.get("danish") in ("required", "plus", "no"):
        out["danish"] = data["danish"]
    if isinstance(data.get("h_min"), int) and isinstance(data.get("h_max"), int) and 0 < data["h_min"] <= data["h_max"] <= 40:
        out["hMin"], out["hMax"] = data["h_min"], data["h_max"]
    if data.get("skills"):
        out["skills"] = [str(s)[:30] for s in data["skills"]][:5]
    if data.get("deadline") and not out.get("deadlineAt"):
        out["deadlineAt"] = f"{data['deadline']}T23:59:00+00:00"
    if data.get("blurb_da"):
        out["blurb"] = str(data["blurb_da"])[:300]
    out["enrichedBy"] = "ai"
    return out
