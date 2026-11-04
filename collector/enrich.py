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

# Ord i titel og tekst, der peger på et felt. Titelord vægter 5, tekstord 1.
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
    "research": ["research", "forskning", "laborator", "lab ", "videnskabelig"],
    "engineering": ["mekanisk", "mechanical", "konstruktion", "cad", "ingeniør", "engineer", "elektronik", "electronics", "maskinmester", "skibsfører", "skibsofficer", "el-installatør", "elektriker", "bygningskonstruktør", "tekniker"],
    "health": ["sygepleje", "læge", "medicin", "patient", "hospital", "klinik", "sundhed", "pleje", "tandlæge", "tandpleje", "vagt"],
    "education": ["pædagog", "lærer", "lektie", "undervis", "sfo", "skole", "børn", "instruktor", "teaching", "tutor", "værksted"],
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
SENIOR_RE = re.compile(r"\b(senior|lead|head of|director|manager|direktør)\b|\w*leder\b|\w*chef\b", re.I)  # også "sektionsleder", "teamleder"

DANISH_REQUIRED = ["flydende dansk", "taler og skriver dansk", "mestrer dansk", "dansk på modersmål", "fluent in danish",
                   "fluent danish", "danish is required", "danish is a requirement", "native danish", "skal kunne tale dansk",
                   "både dansk og engelsk", "danish and english", "fluency in danish"]
DANISH_PLUS = ["dansk er en fordel", "danish is a plus", "danish is an advantage", "danish skills are a plus",
               "danish is nice to have", "kendskab til dansk"]
DANISH_STOPWORDS = [" og ", " at ", " du ", " vi ", " er ", " til ", " med ", " på ", " har ", " som ", " kan "]

# Landsdele. Hele Danmark er dækket: hver by og kommune hører til netop én landsdel.
AREA_TOWNS = {
    "kbh": "københavn copenhagen frederiksberg amager ørestad valby vanløse brønshøj nørrebro østerbro vesterbro sydhavn "
           "nordhavn kastrup tårnby dragør hvidovre avedøre rødovre glostrup brøndby albertslund ishøj vallensbæk "
           "høje-taastrup taastrup hedehusene ballerup måløv skovlunde herlev gladsaxe søborg bagsværd buddinge "
           "gentofte hellerup charlottenlund ordrup klampenborg lyngby lyngby-taarbæk virum furesø farum værløse "
           "rudersdal holte nærum birkerød greve solrød smørum egedal ølstykke stenløse storkøbenhavn hovedstaden "
           "hovedstadsområdet",
    "nsj": "nordsjælland hillerød helsingør fredensborg hørsholm allerød lillerød humlebæk espergærde snekkersten "
           "gribskov helsinge gilleleje frederikssund slangerup halsnæs frederiksværk hundested kokkedal nivå",
    "sj": "sjælland roskilde lejre køge stevns ringsted sorø slagelse korsør skælskør holbæk kalundborg odsherred "
          "faxe haslev midtsjælland vestsjælland",
    "ssj": "sydsjælland næstved vordingborg møn stege guldborgsund falster lolland nakskov maribo lolland-falster",
    "bh": "bornholm rønne nexø aakirkeby hasle",
    "fyn": "fyn odense svendborg nyborg middelfart assens faaborg faaborg-midtfyn ringe kerteminde nordfyn bogense "
           "langeland rudkøbing ærø ærøskøbing broby otterup munkebo",
    "sjy": "sønderjylland sønderborg aabenraa åbenrå haderslev tønder vojens gråsten padborg nordborg augustenborg toftlund",
    "svj": "sydvestjylland esbjerg varde vejen ribe fanø grindsted brørup rødding",
    "tre": "trekantområdet kolding fredericia vejle børkop christiansfeld give jelling billund hedensted",
    "oj": "østjylland aarhus århus viby højbjerg brabrand risskov tilst lystrup skejby åbyhøj hasselager odder "
          "skanderborg horsens juelsminde randers syddjurs ebeltoft norddjurs grenaa djursland favrskov hinnerup "
          "hadsten silkeborg samsø",
    "mvj": "midtjylland vestjylland herning ikast ikast-brande brande holstebro struer lemvig ringkøbing "
           "ringkøbing-skjern skjern viborg skive bjerringbro kjellerup karup",
    "nj": "nordjylland aalborg nørresundby hjørring frederikshavn skagen sæby brønderslev jammerbugt aabybro "
          "vesthimmerland aars rebild støvring mariagerfjord hobro thisted thy morsø læsø himmerland vendsyssel",
    "remote": "remote hjemmefra fjernarbejde",
}
# Flerordsnavne og navne, der ellers ville ramme forkert
AREA_PHRASES = {
    "region hovedstaden": "kbh", "capital region": "kbh", "region sjælland": "sj", "region zealand": "sj",
    "region syddanmark": "fyn", "region midtjylland": "oj", "central jutland": "oj", "region nordjylland": "nj",
    "north denmark": "nj", "midt- og vestjylland": "mvj", "nykøbing falster": "ssj", "nykøbing f": "ssj",
    "nykøbing sjælland": "sj", "nykøbing sj": "sj", "nykøbing mors": "nj", "kongens lyngby": "kbh", "kgs. lyngby": "kbh",
    "store heddinge": "sj", "work from home": "remote",
}
_TOWN_AREA = {t: a for a, towns in AREA_TOWNS.items() for t in towns.split()}
_TOWN_AREA.update(AREA_PHRASES)
_TOWN_RE = re.compile(r"(?<![a-zæøå])(" + "|".join(sorted(map(re.escape, _TOWN_AREA), key=len, reverse=True)) + r")(?![a-zæøå])")
OLD_REGION = {"cph": "kbh", "aar": "oj", "ode": "fyn", "aal": "nj"}
AREAS = set(AREA_TOWNS) | {"dk"}


def area_from_postcode(code: int) -> str | None:
    ranges = [(1000, 2969, "kbh"), (2970, 3699, "nsj"), (3700, 3799, "bh"), (4000, 4699, "sj"), (4700, 4999, "ssj"),
              (5000, 5999, "fyn"), (6000, 6099, "tre"), (6100, 6599, "sjy"), (6600, 6899, "svj"), (6900, 6999, "mvj"),
              (7000, 7199, "tre"), (7200, 7299, "svj"), (7300, 7399, "tre"), (7400, 7899, "mvj"), (7700, 7799, "nj"),
              (7900, 7999, "nj"), (8000, 8799, "oj"), (8800, 8899, "mvj"), (8900, 8999, "oj"), (9000, 9999, "nj")]
    hit = None
    for lo, hi, area in ranges:  # senere, smallere intervaller vinder (fx Thy 77xx)
        if lo <= code <= hi:
            hit = area
    return hit


def areas_in(text: str) -> list[str]:
    """Alle landsdele nævnt i en tekst, i den rækkefølge de står."""
    low = (text or "").lower()
    found = [_TOWN_AREA[m.group(1)] for m in _TOWN_RE.finditer(low)]
    if not found:
        for m in re.finditer(r"(?<!\d)(\d{4})(?=\s+[a-zæøå])", low):
            if (a := area_from_postcode(int(m.group(1)))):
                found.append(a)
    return list(dict.fromkeys(found))


def employer_area(employer: dict) -> str:
    found = [a for a in areas_in(employer.get("city", "")) if a != "remote"]
    if found:
        return found[0]
    r = (employer.get("region") or "").strip()
    return OLD_REGION.get(r, r if r in AREAS else "kbh")


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
    if NOT_STUDENT_RE.search(title) and not re.search(r"studenter|studentermedhjælp|student assistant|student worker", title, re.I):
        return False
    hours = detect_hours(text)
    if hours[0] >= 30 and not re.search(r"praktik|intern", f"{title} {commitment}", re.I):
        return False  # fuldtid er ikke et studiejob (praktik kan godt være fuldtid)
    # "intern kommunikation" er dansk for intern, ikke en praktikant
    t_student = re.sub(r"\bintern(?=\s+(?!(?:in|for|at|to|with|within)\b)[a-zæøå])", "", title)
    if STUDENT_RE.search(t_student) or STUDENT_RE.search(commitment or ""):
        return True
    if SENIOR_RE.search(title) or re.search(
            r"konsulent|koordinator|tekniker|serviceassistent|rådgiver|psykolog|afløser|weekend", title, re.I):
        return False
    return bool(STUDENT_TEXT_RE.search(text[:2500]))


def _has(text: str, word: str) -> bool:
    """Korte ord (fx "sfo", "hr") skal stå alene, så "transformation" ikke tæller som SFO. Lange ord må være en del af et ord."""
    w = word.strip()
    if len(w) <= 4:
        return re.search(rf"(?<![a-zæøå0-9]){re.escape(w)}(?![a-zæøå0-9])", text) is not None
    return word in text


def classify_families(title: str, text: str) -> tuple[str, list[str]]:
    t, d = f" {title.lower()} ", f" {text.lower()} "
    scores = {}
    for fam, words in FAMILY_WORDS.items():
        s = sum(5 for w in words if _has(t, w)) + sum(1 for w in words if _has(d, w))
        if s:
            scores[fam] = s
    if not scores:
        return "operations", []
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    top = ranked[0][1]
    return ranked[0][0], [f for f, s in ranked[1:3] if s >= 0.4 * top]


def family_confidence(title: str, fam: str) -> str:
    """'title' når titlen selv peger på feltet, ellers 'text' (et gæt ud fra opslagets tekst)."""
    t = f" {title.lower()} "
    return "title" if any(_has(t, w) for w in FAMILY_WORDS.get(fam, [])) else "text"


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
    """Landsdel ud fra opslagets arbejdssted. Nævner opslaget tre eller flere landsdele, er det landsdækkende ("dk")."""
    found = areas_in(location)
    if "remote" in found:
        return "remote", location
    if len(found) >= 3:
        return "dk", location
    if found:
        return found[0], location
    return OLD_REGION.get(fallback, fallback if fallback in AREAS else "kbh"), location or ""


def detect_skills(text: str) -> list[str]:
    low = f" {text.lower()} "
    found = [s for s in SKILLS if re.search(rf"(?<![a-zæøå]){re.escape(s.lower())}(?![a-zæøå])", low)]
    return found[:6]


# Sætninger om virksomheden selv, ikke om jobbet
BOILERPLATE_RE = re.compile(
    r"har sine rødder|grundlagt|founded|i dag er vi|today we are|we are a |vi er en |vi er et |medarbejdere i|"
    r"employees in|ansatte i|our mission|vores mission|is a leading|er en førende|er et førende|historie", re.I)
ROLE_RE = re.compile(r"\b(du|dig|you|your|opgave|tasks?|ansvar|responsib|skal|will)\b", re.I)


def make_blurb(text: str, limit: int = 220) -> str:
    sentences = [x for x in re.split(r"(?<=[.!?])\s+", text.strip()) if x]
    # Start ved den første sætning, der handler om jobbet, og spring virksomhedsreklame over
    start = next((i for i, x in enumerate(sentences) if ROLE_RE.search(x) and not BOILERPLATE_RE.search(x)), 0)
    sentences = [x for x in sentences[start:] if not BOILERPLATE_RE.search(x)] or sentences
    blurb = ""
    for s in sentences:
        if len(blurb) + len(s) > limit:
            break
        blurb = f"{blurb} {s}".strip()
    return blurb or text[:limit].rsplit(" ", 1)[0] + "…" if text else ""


# Job, der kun er for studerende på en bestemt uddannelse. Nøglen bruges af hjemmesiden.
REQUIRED_STUDY = [
    ("jura", r"studerende til juridisk|juridisk student|jurastud|stud\.?\s?jur|\bjurist|juridisk(?:e)? (?:student|studentermedhjælp)|law student|jurastudie"),
    ("sygepleje", r"sygeplejestuderende|sygeplejerskestuderende|nursing student"),
    ("medicin", r"medicinstuderende|stud\.?\s?med\b|lægestuderende|medical student"),
    ("farmaci", r"farmaceutstuderende|farmacistuderende|stud\.?\s?pharm"),
    ("psykologi", r"psykologistuderende|psykologstuderende|stud\.?\s?psych"),
    ("paedagog", r"pædagogstuderende"),
    ("socialraadgiver", r"socialrådgiverstuderende"),
    ("tandpleje", r"tandplejerstuderende|tandlægestuderende"),
    ("audiologopaedi", r"audiologopædi"),
    ("arkitekt", r"arkitektstuderende|arkitektpraktikant"),
    ("konstruktoer", r"bygningskonstruktør"),
    ("ingenioer", r"ingeniørpraktikant|ingeniørstuderende|engineering student|engineering intern"),
    ("maritim", r"skibsfører|skibsofficer|maskinmester"),
    ("oekonomi", r"stud\.?\s?polit|økonomistuderende|economics student"),
]


def detect_required_study(title: str) -> str | None:
    for key, rx in REQUIRED_STUDY:
        if re.search(rx, title, re.I):
            return key
    return None


def enrich_rules(raw: dict, employer: dict) -> dict | None:
    title, text = raw["title"], raw.get("description", "")
    if not title or not is_student_job(title, text, raw.get("commitment", "")):
        return None
    fam, sec = classify_families(title, text)
    hint = [f for f in raw.get("fam_hint") or [] if f in FAMILIES]
    if hint:  # kategorier fra jobportalen: vores eget gæt bestemmer kun rækkefølgen
        order = [f for f in [fam, *sec] if f in hint] + [f for f in hint if f not in (fam, *sec)]
        fam, sec = order[0], order[1:3]
    h_min, h_max = detect_hours(text)
    region, city = detect_region(raw.get("location", ""), employer_area(employer))
    if raw.get("region_hint") and (region not in ("remote",) or raw["region_hint"] == "remote"):
        region = raw["region_hint"]
    extra = {k: raw[k] for k in ("studies", "why", "openToAll") if raw.get(k)}
    if hint:
        extra["catFam"] = True
    return {**extra,
        "title": title,
        "co": raw.get("company") or employer["name"],
        "city": city or employer.get("city", ""),
        "region": region,
        "hMin": h_min, "hMax": h_max,
        "danish": detect_danish(f"{title} {text}"),
        "fam": fam, "sec": sec, "famConf": "title" if hint else family_confidence(title, fam),
        "skills": detect_skills(text),
        "industry": employer.get("industry") or "Andet",
        "postedAt": raw.get("posted_at"),
        "deadlineAt": raw.get("deadline_at"),
        "src": raw.get("source", "Virksomhedens karriereside"),
        "blurb": make_blurb(text),
        "req": detect_required_study(title),
        "url": raw.get("url", ""),
        "enrichedBy": "regler",
    }


# ---------- AI-laget ----------
AI_MODEL = os.environ.get("STUDIEMATCH_MODEL", "claude-haiku-5-5")
AI_URL = "https://api.anthropic.com/v1/messages"
AI_ERROR = ""  # første fejl fra AI-laget i denne kørsel

PROMPT = """Du hjælper en dansk side, der anbefaler studiejob til studerende. Læs jobopslaget og svar KUN med ét kompakt JSON-objekt på én linje, uden kodeblok og uden forklaring.

Felter:
- "is_student_job": true hvis jobbet er et studiejob, studentermedhjælper-job, deltidsjob for studerende eller praktik. Ellers false.
- "fam": det felt, jobbet bedst hører til. Vælg præcis én af: {families}
- "sec": op til 2 andre felter fra samme liste, som arbejdet også handler om.
- "danish": "required" hvis jobbet kræver dansk, "plus" hvis dansk er en fordel, "no" hvis engelsk er nok.
- "h_min", "h_max": timer om ugen som heltal, eller null hvis det ikke står.
- "skills": op til 5 konkrete kompetencer, opslaget efterspørger (korte navne).
- "deadline": ansøgningsfrist som "YYYY-MM-DD", eller null.
- "blurb_da": 1-2 korte sætninger på dansk om, hvad man laver i jobbet. Skriv konkret, uden reklamesprog.
- "studies": op til 8 uddannelser, som jobbet passer bedst til, med almindelige danske navne i små bogstaver,
  fx ["farmaci", "kemi", "biokemi"] eller ["erhvervsøkonomi", "ha", "cand.merc", "global business engineering"].
  Tænk på, hvad arbejdet kræver, ikke kun titlen. Et job i regulatory affairs passer fx til farmaci og jura.
- "open_to_all": true hvis studerende fra næsten alle uddannelser kan tage jobbet (fx kundeservice, butik, hjemmepleje uden krav).
- "why": én kort sætning på dansk om, hvorfor jobbet passer til de uddannelser.

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
    text, stop = "", ""
    try:
        resp = requests.post(AI_URL, timeout=60, headers={
            "x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json",
        }, json={"model": AI_MODEL, "max_tokens": 2000, "messages": [{"role": "user", "content": prompt}]})
        resp.raise_for_status()
        body_json = resp.json()
        stop = body_json.get("stop_reason", "")
        text = "".join(part.get("text", "") for part in body_json.get("content", []))
        data = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except (requests.RequestException, ValueError, KeyError) as err:
        global AI_ERROR
        if not AI_ERROR:  # vis den første fejl i rapporten, så en forkert nøgle eller model ikke går stille hen
            body = getattr(getattr(err, "response", None), "text", "") or ""
            AI_ERROR = f"{type(err).__name__}: {err} {body[:200]} (stop: {stop}, svar: {text[:160]!r})".strip()
            print("AI-fejl:", AI_ERROR)
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
    studies = [str(x).strip().lower()[:50] for x in data.get("studies") or [] if str(x).strip()]
    if studies:
        out["studies"] = studies[:8]
        out["why"] = str(data.get("why") or "")[:200]
    out["openToAll"] = bool(data.get("open_to_all"))
    out["enrichedBy"] = "ai"
    if base.get("catFam"):  # jobportalens egne kategorier og uddannelser vinder over AI'ens gæt
        for k in ("fam", "sec", "studies", "why"):
            if k in base:
                out[k] = base[k]
    return out
