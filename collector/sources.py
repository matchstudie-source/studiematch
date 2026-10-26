"""Henter job fra de kildetyper, Studiematch må bruge.

Hver kilde har en ren parse-funktion (tekst ind, job ud), så den kan testes uden netværk,
og en fetch-funktion, der henter teksten. Alle job returneres i samme råformat:

    {"title", "company", "location", "description", "url", "posted_at", "deadline_at", "source"}
"""
from __future__ import annotations

import html
import json
import re
import time
import urllib.robotparser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

USER_AGENT = "StudiematchBot/0.1 (studiejob-anbefalinger; +https://studiematch.dk)"
TIMEOUT = 20
PAUSE_SECONDS = 1.0  # høflig pause mellem kald til samme side

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "da,en;q=0.8"})


def _get(url: str, **kw) -> requests.Response:
    resp = _session.get(url, timeout=TIMEOUT, **kw)
    resp.raise_for_status()
    time.sleep(PAUSE_SECONDS)
    return resp


def _post(url: str, **kw) -> requests.Response:
    resp = _session.post(url, timeout=TIMEOUT, **kw)
    resp.raise_for_status()
    time.sleep(PAUSE_SECONDS)
    return resp


# Ord der viser, at et job er i Danmark. Bruges til store, internationale virksomheder,
# hvis jobsystem også indeholder job i andre lande.
DK_PLACE = re.compile(
    r"denmark|danmark|\bdk\b|københavn|copenhagen|kobenhavn|aarhus|århus|odense|aalborg|esbjerg|kolding|vejle|"
    r"horsens|randers|roskilde|herning|silkeborg|næstved|lyngby|ballerup|søborg|bagsværd|måløv|kalundborg|"
    r"hillerød|helsingør|frederiksberg|glostrup|taastrup|brøndby|hvidovre|hellerup|ørestad|billund|sønderborg|"
    r"fredericia|viborg|holstebro|skive|hørsholm|birkerød|nordborg|bjerringbro|hedehusene|køge|slagelse|remote",
    re.I)


def in_denmark(location: str) -> bool:
    return not location or bool(DK_PLACE.search(location))


ABROAD = re.compile(
    r"\b(norway|norge|oslo|bergen|sweden|sverige|stockholm|göteborg|gothenburg|malmö|malmo|finland|helsinki|germany|"
    r"deutschland|berlin|hamburg|munich|münchen|united kingdom|london|poland|warsaw|kraków|krakow|india|bangalore|"
    r"united states|usa|new york|chicago|china|shanghai|singapore|netherlands|amsterdam|spain|madrid|barcelona|"
    r"france|paris|lithuania|vilnius|portugal|lisbon|ireland|dublin)\b", re.I)


def clearly_abroad(location: str) -> bool:
    """Sand, når et job tydeligvis ligger i et andet land og ikke også i Danmark."""
    return bool(location) and bool(ABROAD.search(location)) and not DK_PLACE.search(location)


def html_to_text(raw: str | None) -> str:
    if not raw:
        return ""
    text = BeautifulSoup(html.unescape(raw), "html.parser").get_text(" ")
    return re.sub(r"\s+", " ", text).strip()


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _parse_any_date(value) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):  # millisekunder (Lever)
        return _iso(datetime.fromtimestamp(value / 1000, tz=timezone.utc))
    s = str(value).strip()
    try:
        return _iso(parsedate_to_datetime(s))  # RSS-format
    except (TypeError, ValueError):
        pass
    try:
        return _iso(datetime.fromisoformat(s.replace("Z", "+00:00")))
    except ValueError:
        pass
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return _iso(datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=timezone.utc))
    return None


# ---------- Teamtailor (offentligt RSS-feed: <karriereside>/jobs.rss) ----------
TT_NS = "{https://teamtailor.com/locations}"


def parse_teamtailor_rss(xml_text: str, company: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    jobs = []
    for item in root.iter("item"):
        cities = [c.text for c in item.iter(f"{TT_NS}city") if c.text]
        names = [n.text for n in item.iter(f"{TT_NS}name") if n.text]
        remote = (item.findtext("remoteStatus") or "").lower()
        location = ", ".join(cities or names)
        if remote in ("fully", "remote", "fully_remote") and not location:
            location = "Remote"
        jobs.append({
            "title": (item.findtext("title") or "").strip(),
            "company": company,
            "location": location,
            "description": html_to_text(item.findtext("description")),
            "url": (item.findtext("link") or "").strip(),
            "posted_at": _parse_any_date(item.findtext("pubDate")),
            "deadline_at": None,
            "source": "Virksomhedens rekrutteringssystem",
        })
    return jobs


def fetch_teamtailor(base_url: str, company: str) -> list[dict]:
    base = base_url.rstrip("/")
    jobs, offset = [], 0
    while True:
        resp = _get(f"{base}/jobs.rss", params={"offset": offset, "per_page": 100})
        page = parse_teamtailor_rss(resp.text, company)
        jobs += page
        if len(page) < 100:
            return jobs
        offset += 100


# ---------- Greenhouse (åbent API uden login) ----------
def parse_greenhouse_json(data: dict, company: str) -> list[dict]:
    jobs = []
    for j in data.get("jobs", []):
        jobs.append({
            "title": (j.get("title") or "").strip(),
            "company": j.get("company_name") or company,
            "location": (j.get("location") or {}).get("name", ""),
            "description": html_to_text(j.get("content")),
            "url": j.get("absolute_url", ""),
            "posted_at": _parse_any_date(j.get("first_published") or j.get("updated_at")),
            "deadline_at": _parse_any_date(j.get("application_deadline")),
            "source": "Virksomhedens rekrutteringssystem",
        })
    return jobs


def fetch_greenhouse(board_token: str, company: str) -> list[dict]:
    last_err = None
    for host in ("boards-api.greenhouse.io", "boards-api.eu.greenhouse.io"):
        try:
            resp = _get(f"https://{host}/v1/boards/{board_token}/jobs", params={"content": "true"})
            return parse_greenhouse_json(resp.json(), company)
        except requests.RequestException as err:  # prøv EU-serveren, hvis den amerikanske ikke kender boardet
            last_err = err
    raise last_err


# ---------- Lever (offentligt postings-API) ----------
def parse_lever_json(data: list, company: str) -> list[dict]:
    jobs = []
    for j in data:
        cats = j.get("categories") or {}
        jobs.append({
            "title": (j.get("text") or "").strip(),
            "company": company,
            "location": cats.get("location") or ", ".join(cats.get("allLocations") or []),
            "description": (j.get("descriptionPlain") or html_to_text(j.get("description")) or "").strip(),
            "url": j.get("hostedUrl", ""),
            "posted_at": _parse_any_date(j.get("createdAt")),
            "deadline_at": None,
            "source": "Virksomhedens rekrutteringssystem",
            "commitment": cats.get("commitment", ""),
        })
    return jobs


def fetch_lever(slug: str, company: str) -> list[dict]:
    last_err = None
    for host in ("api.lever.co", "api.eu.lever.co"):
        try:
            resp = _get(f"https://{host}/v0/postings/{slug}", params={"mode": "json"})
            return parse_lever_json(resp.json(), company)
        except requests.RequestException as err:
            last_err = err
    raise last_err


# ---------- SmartRecruiters (offentligt postings-API) ----------
def parse_smartrecruiters_json(data: dict, company: str) -> list[dict]:
    jobs = []
    for j in data.get("content", []):
        loc = j.get("location") or {}
        jobs.append({
            "title": (j.get("name") or "").strip(),
            "company": (j.get("company") or {}).get("name") or company,
            "location": loc.get("city") or ("Remote" if loc.get("remote") else ""),
            "description": "",
            "url": f"https://jobs.smartrecruiters.com/{(j.get('company') or {}).get('identifier', '')}/{j.get('id', '')}",
            "posted_at": _parse_any_date(j.get("releasedDate")),
            "deadline_at": None,
            "source": "Virksomhedens rekrutteringssystem",
        })
    return jobs


def fetch_smartrecruiters(company_id: str, company: str) -> list[dict]:
    resp = _get(f"https://api.smartrecruiters.com/v1/companies/{company_id}/postings", params={"limit": 100})
    return parse_smartrecruiters_json(resp.json(), company)


# ---------- Karrieresider med strukturerede data (schema.org JobPosting) ----------
def parse_jobposting_jsonld(page_html: str, page_url: str, company: str, source_label: str) -> list[dict]:
    soup = BeautifulSoup(page_html, "html.parser")
    found = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or tag.get_text() or "")
        except json.JSONDecodeError:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            node = stack.pop()
            if isinstance(node, list):
                stack.extend(node)
                continue
            if not isinstance(node, dict):
                continue
            if "@graph" in node:
                stack.extend(node["@graph"] if isinstance(node["@graph"], list) else [node["@graph"]])
            types = node.get("@type")
            types = types if isinstance(types, list) else [types]
            if "JobPosting" not in types:
                continue
            org = node.get("hiringOrganization") or {}
            locs = node.get("jobLocation") or []
            locs = locs if isinstance(locs, list) else [locs]
            cities = []
            for loc in locs:
                addr = (loc or {}).get("address") or {}
                if isinstance(addr, dict) and addr.get("addressLocality"):
                    cities.append(addr["addressLocality"])
            if not cities and node.get("jobLocationType") == "TELECOMMUTE":
                cities = ["Remote"]
            found.append({
                "title": html_to_text(node.get("title")),
                "company": (org.get("name") if isinstance(org, dict) else None) or company,
                "location": ", ".join(cities),
                "description": html_to_text(node.get("description")),
                "url": node.get("url") or page_url,
                "posted_at": _parse_any_date(node.get("datePosted")),
                "deadline_at": _parse_any_date(node.get("validThrough")),
                "source": source_label,
            })
    if not found:
        found = parse_jobposting_microdata(soup, page_url, company, source_label)
    return found


def parse_jobposting_microdata(soup, page_url: str, company: str, source_label: str) -> list[dict]:
    """Samme standard som JSON-LD, men skrevet som itemprop-attributter (fx SAP SuccessFactors-sider)."""
    if isinstance(soup, str):
        soup = BeautifulSoup(soup, "html.parser")
    found = []
    for scope in soup.find_all(attrs={"itemtype": re.compile(r"schema\.org/JobPosting", re.I)}):
        def prop(name, root=scope):
            el = root.find(attrs={"itemprop": name})
            if el is None:
                return ""
            return (el.get("content") or el.get("datetime") or el.get_text(" ")).strip()
        org = scope.find(attrs={"itemprop": "hiringOrganization"})
        loc = scope.find(attrs={"itemprop": "jobLocation"})
        found.append({
            "title": re.sub(r"\s+", " ", prop("title")),
            "company": (prop("name", org) if org else "") or company,
            "location": (prop("addressLocality", loc) if loc else "") or "",
            "description": re.sub(r"\s+", " ", prop("description")),
            "url": page_url,
            "posted_at": _parse_any_date(prop("datePosted")),
            "deadline_at": _parse_any_date(prop("validThrough")),
            "source": source_label,
        })
    return [j for j in found if j["title"]]


JOB_LINK_HINT = re.compile(r"job|stilling|vacanc|career|karriere|position|opslag|/ad/", re.I)
_robots: dict[str, urllib.robotparser.RobotFileParser] = {}


def allowed_by_robots(url: str) -> bool:
    host = "{0.scheme}://{0.netloc}".format(urlparse(url))
    if host not in _robots:
        rp = urllib.robotparser.RobotFileParser()
        try:
            resp = _session.get(host + "/robots.txt", timeout=TIMEOUT)
            rp.parse(resp.text.splitlines() if resp.ok else [])
        except requests.RequestException:
            rp.parse([])
        _robots[host] = rp
    return _robots[host].can_fetch(USER_AGENT, url)


def find_job_links(listing_html: str, listing_url: str, limit: int = 30) -> list[str]:
    soup = BeautifulSoup(listing_html, "html.parser")
    host = urlparse(listing_url).netloc
    links = []
    for a in soup.find_all("a", href=True):
        url = urljoin(listing_url, a["href"]).split("#")[0]
        if urlparse(url).netloc != host or url == listing_url or url in links:
            continue
        if JOB_LINK_HINT.search(urlparse(url).path):
            links.append(url)
        if len(links) >= limit:
            break
    return links


def fetch_careerpage(listing_url: str, company: str, source_label: str) -> list[dict]:
    """Læser en jobliste-side og de jobsider, den linker til. Respekterer robots.txt."""
    if not allowed_by_robots(listing_url):
        return []
    listing = _get(listing_url).text
    jobs = parse_jobposting_jsonld(listing, listing_url, company, source_label)
    for url in find_job_links(listing, listing_url):
        if not allowed_by_robots(url):
            continue
        try:
            jobs += parse_jobposting_jsonld(_get(url).text, url, company, source_label)
        except requests.RequestException:
            continue
    return jobs


# ---------- HR-Manager (offentlig jobliste: jobportal.svc/<kunde>/positionlist) ----------
HRM_NS = "{http://schemas.hr-manager.net/jobportal/1.0/}"


def _real_date(value: str | None) -> str | None:
    d = _parse_any_date(value)
    return d if d and not d.startswith("0001") else None


# Fælles jobportaler, hvor mange arbejdsgivere slår op (fx alle statslige institutioner).
# Her bruges afdelingens navn som arbejdsgiver i stedet for portalens navn.
HRM_SHARED = {"statensrekrutteringsloesning_tr", "statens_erekruttering"}


HRM_GENERIC = re.compile(r"rekruttering|^staten\b|^statens\b", re.I)


def hrm_institution(pos) -> str:
    """Øverste niveau i afdelingstræet er institutionen (fx 'Det Kgl. Bibliotek'); afdelingen er ofte bare 'Indkøb'."""
    names = []
    for tag in ("DepartmentTree", "Department"):
        el = pos.find(f"{HRM_NS}{tag}")
        if el is not None:
            name = el.find(f"{HRM_NS}Name")
            if name is not None and name.text and name.text.strip():
                names.append(name.text.strip())
    for n in names:
        if not HRM_GENERIC.search(n):
            return n
    return ""


def parse_hrmanager_xml(xml_text: str, company: str, shared: bool = False) -> list[dict]:
    """Bemærk: listen indeholder også kontaktpersoner. Dem læser vi bevidst ikke."""
    root = ET.fromstring(xml_text)
    jobs = []
    for pos in root.iter(f"{HRM_NS}JobPortalPosition"):
        def text(name, node=pos):
            el = node.find(f"{HRM_NS}{name}") if node is not None else None
            return (el.text or "").strip() if el is not None and el.text else ""
        loc = pos.find(f"{HRM_NS}PositionLocation")
        dept = pos.find(f"{HRM_NS}Department")
        location = text("Name", loc) or text("WorkPlace") or text("City", dept)
        ads = pos.find(f"{HRM_NS}Advertisements")
        ad_text = " ".join(html_to_text(el.text) for el in ads.iter() if el.text and el.text.strip()) if ads is not None else ""
        jobs.append({
            "title": text("Name"),
            "company": hrm_institution(pos) or company if shared else company,
            "location": location,
            "description": " ".join(x for x in (html_to_text(text("ShortDescription")), ad_text) if x),
            "url": text("AdvertisementUrlSecure") or text("AdvertisementUrl"),
            "posted_at": _real_date(text("Published") or text("Created")),
            "deadline_at": _real_date(text("ApplicationDue")),
            "source": "Virksomhedens rekrutteringssystem",
        })
    return [j for j in jobs if j["title"]]


def fetch_hrmanager(customer: str, company: str) -> list[dict]:
    last_err = None
    for host in ("https://recruiter-api.hr-manager.net", "http://api.hr-manager.net"):
        try:
            # Listen viser som standard kun 25 stillinger. Vi beder om flere; ukendte parametre ignoreres.
            resp = _get(f"{host}/jobportal.svc/{customer}/positionlist/",
                        params={"incads": 1, "pageSize": 500, "take": 500, "count": 500})
            return parse_hrmanager_xml(resp.text, company, shared=customer.lower() in HRM_SHARED)
        except (requests.RequestException, ET.ParseError) as err:
            last_err = err
    raise last_err


# ---------- Workday (det JSON-API, som virksomhedens egen karriereside bruger) ----------
WORKDAY_URL = re.compile(r"https?://([\w-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([\w-]+)")
WORKDAY_TERMS = ("student", "studentermedhjælper", "studiejob", "working student")


def parse_workday_job(data: dict, public_url: str, company: str) -> dict:
    info = data.get("jobPostingInfo") or {}
    country = (info.get("country") or {}).get("descriptor", "")
    location = ", ".join(x for x in (info.get("location") or "", country) if x)
    return {
        "title": (info.get("title") or "").strip(),
        "company": re.sub(r"^\d+\s+", "", (data.get("hiringOrganization") or {}).get("name") or "") or company,
        "location": location,
        "description": html_to_text(info.get("jobDescription")),
        "url": info.get("externalUrl") or public_url,
        "posted_at": _parse_any_date(info.get("startDate")),
        "deadline_at": _parse_any_date(info.get("endDate")),
        "source": "Virksomhedens rekrutteringssystem",
        "commitment": info.get("timeType") or "",
    }


def fetch_workday(career_url: str, company: str, max_jobs: int = 60) -> list[dict]:
    m = WORKDAY_URL.match(career_url.strip())
    if not m:
        raise ValueError("ikke en myworkdayjobs-adresse")
    tenant, shard, site = m.groups()
    base = f"https://{tenant}.{shard}.myworkdayjobs.com"
    api = f"{base}/wday/cxs/{tenant}/{site}"
    seen, jobs = set(), []
    for term in WORKDAY_TERMS:
        offset = 0
        while offset < 100 and len(seen) < max_jobs:
            data = _post(f"{api}/jobs", json={"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": term}).json()
            postings = data.get("jobPostings") or []
            for p in postings:
                path = p.get("externalPath")
                if not path or path in seen:
                    continue
                seen.add(path)
                if not in_denmark(p.get("locationsText", "")) and "location" not in (p.get("locationsText") or "").lower():
                    continue  # job i et andet land; "2 Locations" tjekkes på selve opslaget
                job = parse_workday_job(_get(f"{api}{path}").json(), f"{base}/{site}{path}", company)
                if in_denmark(job["location"]):
                    jobs.append(job)
            if len(postings) < 20:
                break
            offset += 20
    return jobs


# ---------- Karrieresider via sitemap (fx SAP SuccessFactors og mange egne løsninger) ----------
STUDENT_URL = re.compile(r"student|studie|studiejob|working-student|werkstudent", re.I)


def parse_sitemap(xml_text: str) -> tuple[list[str], list[str]]:
    """Returnerer (side-adresser, under-sitemaps)."""
    root = ET.fromstring(xml_text.encode() if isinstance(xml_text, str) else xml_text)
    pages, subs = [], []
    for el in root.iter():
        if el.tag.endswith("loc") and el.text:
            parent_is_index = root.tag.endswith("sitemapindex")
            (subs if parent_is_index else pages).append(el.text.strip())
    return pages, subs


def fetch_sitemap(site_url: str, company: str, source_label: str, limit: int = 40) -> list[dict]:
    parsed = urlparse(site_url if "://" in site_url else "https://" + site_url)
    host = f"{parsed.scheme}://{parsed.netloc}"
    maps = []
    try:
        robots = _session.get(host + "/robots.txt", timeout=TIMEOUT)
        if robots.ok:
            maps = [l.split(":", 1)[1].strip() for l in robots.text.splitlines() if l.lower().startswith("sitemap:")]
    except requests.RequestException:
        pass
    maps = maps or [host + "/sitemap.xml"]
    pages, checked = [], 0
    while maps and checked < 15:
        sm = maps.pop(0)
        checked += 1
        try:
            p, subs = parse_sitemap(_get(sm).text)
        except (requests.RequestException, ET.ParseError):
            continue
        pages += p
        maps += [s for s in subs if re.search(r"job|career|karriere|stilling", s, re.I)] or subs[:5]
    candidates = [u for u in dict.fromkeys(pages) if STUDENT_URL.search(urlparse(u).path)][:limit]
    jobs = []
    for url in candidates:
        if not allowed_by_robots(url):
            continue
        try:
            jobs += parse_jobposting_jsonld(_get(url).text, url, company, source_label)
        except requests.RequestException:
            continue
    return [j for j in jobs if in_denmark(j["location"])]


# ---------- Emply (karrieresider på <kunde>.career.emply.com eller eget domæne) ----------
EMPLY_LISTINGS = ("/da/ledige-stillinger", "/ledige-stillinger", "/da/hjem", "/en/vacancies", "/vacancies", "")
EMPLY_AD = re.compile(r"/ad/[^/?#]+/[^/?#]+")
EMPLY_EXPIRED = re.compile(r"ansøgningsfristen på det pågældende job kan være udløbet|linket kan være i stykker", re.I)


def emply_ad_links(listing_html: str, listing_url: str) -> list[str]:
    host = urlparse(listing_url).netloc
    links = []
    for a in BeautifulSoup(listing_html, "html.parser").find_all("a", href=True):
        url = urljoin(listing_url, a["href"]).split("#")[0]
        if urlparse(url).netloc == host and EMPLY_AD.search(urlparse(url).path) and url not in links:
            links.append(url)
    return links


def parse_emply_ad(page_html: str, url: str, company: str, source_label: str) -> list[dict]:
    """Strukturerede data hvis de findes, ellers sidens titel og tekst."""
    jobs = parse_jobposting_jsonld(page_html, url, company, source_label)
    if jobs:
        return jobs
    soup = BeautifulSoup(page_html, "html.parser")
    text = re.sub(r"\s+", " ", (soup.find("main") or soup.body or soup).get_text(" ")).strip()
    if EMPLY_EXPIRED.search(text):
        return []
    og = soup.find("meta", attrs={"property": "og:title"}) or soup.find("meta", attrs={"name": "og:title"})
    title = (og.get("content") if og else "") or (soup.h1.get_text(" ", strip=True) if soup.h1 else "")
    title = re.sub(r"\s*[|I]\s*Career Site\s*$", "", title).strip()
    if not title or title.lower() in ("career site", "ledige stillinger"):
        return []
    return [{"title": title, "company": company, "location": "", "description": text[:5000], "url": url,
             "posted_at": None, "deadline_at": None, "source": source_label}]


def fetch_emply(listing_url: str, company: str, source_label: str, limit: int = 40) -> list[dict]:
    """Finder /ad/-links på Emplys joblister og læser hvert opslag. Virker det ikke, prøves sitemap."""
    url = listing_url if "://" in listing_url else f"https://{listing_url}.career.emply.com"
    base = "{0.scheme}://{0.netloc}".format(urlparse(url))
    pages = [url] + [base + p for p in EMPLY_LISTINGS if base + p != url]
    links = []
    for page in pages:
        if not allowed_by_robots(page):
            continue
        try:
            links += [l for l in emply_ad_links(_get(page).text, page) if l not in links]
        except requests.RequestException:
            continue
        if len(links) >= limit:
            break
    jobs = []
    for link in links[:limit]:
        try:
            jobs += parse_emply_ad(_get(link).text, link, company, source_label)
        except requests.RequestException:
            continue
    return jobs or fetch_sitemap(url, company, source_label)


# ---------- Ashby (offentligt job board-API) ----------
ASHBY_URL = re.compile(r"jobs\.ashbyhq\.com/([\w.-]+)")


def parse_ashby_json(data: dict, company: str) -> list[dict]:
    jobs = []
    for j in data.get("jobs", []):
        if j.get("isListed") is False:
            continue
        addr = ((j.get("address") or {}).get("postalAddress") or {})
        location = ", ".join(x for x in (j.get("location") or addr.get("addressLocality"), addr.get("addressCountry")) if x)
        if not location and j.get("isRemote"):
            location = "Remote"
        jobs.append({
            "title": (j.get("title") or "").strip(),
            "company": company,
            "location": location,
            "description": (j.get("descriptionPlain") or html_to_text(j.get("descriptionHtml")) or "").strip(),
            "url": j.get("jobUrl") or j.get("applyUrl") or "",
            "posted_at": _parse_any_date(j.get("publishedAt")),
            "deadline_at": None,
            "source": "Virksomhedens rekrutteringssystem",
            "commitment": j.get("employmentType") or "",
        })
    return jobs


def fetch_ashby(ref: str, company: str) -> list[dict]:
    m = ASHBY_URL.search(ref)
    org = m.group(1) if m else ref.strip("/")
    resp = _get(f"https://api.ashbyhq.com/posting-api/job-board/{org}", params={"includeCompensation": "false"})
    return parse_ashby_json(resp.json(), company)


# ---------- SAP SuccessFactors-karrieresider (fx careers.novonordisk.com, jobs.dsv.com) ----------
RMK_TERMS = ("student", "studerende", "studentermedhjælper")


def parse_rmk_rss(xml_text: str, company: str, source_label: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    jobs = []
    for item in root.iter("item"):
        title = html_to_text(item.findtext("title") or "")
        m = re.search(r"\(([^()]*)\)\s*$", title)  # "Student Assistant (Bagsværd, DK, 2880)"
        location = m.group(1) if m else ""
        if m:
            title = title[:m.start()].strip()
        jobs.append({
            "title": title, "company": company, "location": location,
            "description": html_to_text(item.findtext("description")),
            "url": (item.findtext("link") or "").strip(),
            "posted_at": _parse_any_date(item.findtext("pubDate")),
            "deadline_at": None, "source": source_label,
        })
    return [j for j in jobs if j["title"]]


def fetch_rmk(site_url: str, company: str, source_label: str) -> list[dict]:
    """Søger i karrierestedets RSS-feed efter studiejob. Virker feedet ikke, læses sitemap."""
    base = "{0.scheme}://{0.netloc}".format(urlparse(site_url if "://" in site_url else "https://" + site_url))
    jobs, seen = [], set()
    for locale in ("da_DK", "en_US"):
        for term in RMK_TERMS:
            for kw in (f"({term})", term):
                try:
                    resp = _get(f"{base}/services/rss/job/", params={"locale": locale, "keywords": kw})
                    found = parse_rmk_rss(resp.text, company, source_label)
                except (requests.RequestException, ET.ParseError):
                    found = []
                for j in found:
                    if j["url"] not in seen and in_denmark(j["location"]):
                        seen.add(j["url"])
                        jobs.append(j)
    # Feedet viser ofte kun de nyeste opslag, så sitemap læses også
    for j in fetch_sitemap(base, company, source_label):
        if j["url"] not in seen:
            seen.add(j["url"])
            jobs.append(j)
    return jobs
