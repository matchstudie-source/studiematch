"""Studiematchs virksomhedsfinder.

Kør:  python collector/discover.py            (skriver kun collector/discovered.csv og en rapport)
      python collector/discover.py --merge    (tilføjer også nye kilder til collector/employers.csv)

Læser collector/companies.csv (navn, hjemmeside, by, region, branche), besøger hver hjemmeside,
finder karrieresiden og genkender jobsystemet ud fra koden på siden. Respekterer robots.txt.
"""
from __future__ import annotations

import csv
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import requests  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

import sources  # noqa: E402

COMPANIES = HERE / "companies.csv"
EMPLOYERS = HERE / "employers.csv"
DISCOVERED = HERE / "discovered.csv"
REPORT = HERE / "discover_report.md"

EMPLOYER_COLS = ["name", "source", "ref", "city", "region", "industry", "title", "fam", "sec", "danish", "hours", "blurb", "src_label"]
CAREER_WORDS = re.compile(r"karriere|career|job|ledige|stilling|arbejd(?:e|sp)?\s*(?:hos|for)|work[-\s]with[-\s]us|join[-\s]us|vacanc", re.I)
COMMON_PATHS = ("/karriere", "/job", "/jobs", "/career", "/careers", "/om-os/job", "/ledige-stillinger")

# (kildetype, regex, hvordan ref bygges ud fra match og siden)
SIGNATURES = [
    ("workday", re.compile(r"https?://[\w-]+\.wd\d+\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?[\w-]+"), lambda m, page: m.group(0)),
    ("greenhouse", re.compile(r"(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io/(?:embed/job_board(?:/js)?\?for=)?([\w-]+)"), lambda m, page: m.group(1)),
    ("lever", re.compile(r"jobs(?:\.eu)?\.lever\.co/([\w-]+)"), lambda m, page: m.group(1)),
    ("smartrecruiters", re.compile(r"(?:jobs|careers)\.smartrecruiters\.com/([\w-]+)"), lambda m, page: m.group(1)),
    ("hrmanager", re.compile(r"hr-manager\.net/[^\"'<>\s]*?customer=([\w-]+)", re.I), lambda m, page: m.group(1)),
    ("hrmanager", re.compile(r"hr-manager\.net/jobportal\.svc/([\w-]+)", re.I), lambda m, page: m.group(1)),
    ("emply", re.compile(r"https?://([\w-]+)\.career\.emply\.com"), lambda m, page: m.group(0)),
    ("teamtailor", re.compile(r"https?://[\w-]+\.teamtailor\.com"), lambda m, page: m.group(0)),
    ("workable", re.compile(r"apply\.workable\.com/([\w-]+)"), lambda m, page: m.group(1)),
    ("ashby", re.compile(r"jobs\.ashbyhq\.com/([\w.-]+)"), lambda m, page: m.group(1)),
]
CAREER_PAGE = re.compile(r"job|career|karriere|stilling|ledige|vacanc", re.I)
IGNORED_REFS = {"workable": {"api", "j"}, "greenhouse": {"embed", "js"}, "lever": {"v0"}, "smartrecruiters": {"widget", "static"}}


def page_base(url: str) -> str:
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"


def detect(html: str, page_url: str) -> list[tuple[str, str]]:
    """Find jobsystemer i en sides HTML. Returnerer [(kildetype, ref), ...]."""
    found = []
    for kind, rx, ref in SIGNATURES:
        for m in rx.finditer(html):
            r = ref(m, page_url).rstrip("/")
            if r.lower() in IGNORED_REFS.get(kind, ()):
                continue
            if kind == "workday" and r.rsplit("/", 1)[-1].lower() in ("wday", "cxs"):
                continue
            if kind == "teamtailor" and r.split("//")[1].split(".")[0] in ("app", "assets", "scripts", "cdn", "www"):
                continue
            found.append((kind, r))
    low = html.lower()
    # Teamtailor på eget domæne (fx career.firma.dk): siden selv er karrieresiden
    if (not any(k == "teamtailor" for k, _ in found) and ("teamtailor-cdn" in low or "teamtailor.com/assets" in low)
            and CAREER_PAGE.search(page_url)):
        found.append(("teamtailor", page_base(page_url)))
    # SAP SuccessFactors-karrieresider læses via sitemap
    if "rmkcdn.successfactors.com" in low or "successfactors.eu/career" in low or "successfactors.com/career" in low:
        found.append(("sitemap", page_base(page_url)))
    # Emply på eget domæne
    if not any(k == "emply" for k, _ in found) and ("emply.net" in low or "cdn.emply" in low):
        found.append(("emply", page_url))
    # Strukturerede jobdata direkte på siden
    if not found and '"jobposting"' in low.replace(" ", ""):
        found.append(("careerpage", page_url))
    return list(dict.fromkeys(found))


def career_links(html: str, base_url: str, limit: int = 4) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    links = []
    for a in soup.find_all("a", href=True):
        text = f"{a.get_text(' ', strip=True)} {a['href']}"
        if not CAREER_WORDS.search(text):
            continue
        url = urljoin(base_url, a["href"]).split("#")[0]
        if url.startswith("http") and url not in links:
            links.append(url)
        if len(links) >= limit:
            break
    return links


def fetch_html(url: str) -> tuple[str, str] | None:
    if not sources.allowed_by_robots(url):
        return None
    try:
        resp = sources._get(url)
    except requests.RequestException:
        return None
    if "html" not in resp.headers.get("Content-Type", "html"):
        return None
    return resp.text, resp.url


def discover_company(website: str) -> tuple[list[tuple[str, str]], str]:
    """Besøg forsiden og op til 4 karrieresider. Returnerer (fundne kilder, siden de blev fundet på)."""
    home_url = website if "://" in website else "https://" + website
    home = fetch_html(home_url)
    if not home:
        return [], "forsiden kunne ikke hentes"
    html, final = home
    found = detect(html, final)
    if found:
        return found, final
    tried = {final}
    for url in career_links(html, final) + [urljoin(page_base(final), p) for p in COMMON_PATHS]:
        if url in tried or len(tried) > 7:
            continue
        tried.add(url)
        page = fetch_html(url)
        if not page:
            continue
        found = detect(*page)
        if found:
            return found, page[1]
        # én ekstra hop: karrieresiden linker ofte videre til jobsystemet
        for sub in career_links(page[0], page[1], limit=2):
            if sub in tried:
                continue
            tried.add(sub)
            subpage = fetch_html(sub)
            if subpage and (found := detect(*subpage)):
                return found, subpage[1]
    return [], "intet jobsystem fundet"


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [{k: (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)
                if row.get("name") and not row["name"].startswith("#")]


def main(argv: list[str]) -> int:
    merge = "--merge" in argv
    companies = read_csv(COMPANIES)
    existing = read_csv(EMPLOYERS)
    known = {(e["source"], e["ref"].rstrip("/").lower()) for e in existing}
    known_names = {e["name"].lower() for e in existing}
    rows, report = [], []
    for c in companies:
        try:
            found, where = discover_company(c["website"])
        except Exception as err:  # én hjemmeside må ikke vælte kørslen
            found, where = [], f"fejl: {type(err).__name__}"
        if not found:
            report.append((c["name"], "", where))
            continue
        kind, ref = found[0]  # første fund er det mest specifikke
        status = "kendt" if (kind, ref.lower()) in known or c["name"].lower() in known_names else "ny"
        known.add((kind, ref.lower()))  # samme kilde må kun tilføjes én gang
        report.append((c["name"], f"{kind}: {ref}", status))
        rows.append({"name": c["name"], "source": kind, "ref": ref, "city": c.get("city", ""), "region": c.get("region", "") or "cph",
                     "industry": c.get("industry", ""), "src_label": "", "_status": status, "_found_on": where})

    with DISCOVERED.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=EMPLOYER_COLS + ["found_on"], extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({**r, "found_on": r["_found_on"]})

    added = 0
    if merge:
        new = [r for r in rows if r["_status"] == "ny"]
        if new:
            with EMPLOYERS.open("a", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=EMPLOYER_COLS, extrasaction="ignore")
                for r in new:
                    w.writerow({k: r.get(k, "") for k in EMPLOYER_COLS})
            added = len(new)

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    found_n = sum(1 for _, k, _ in report if k)
    lines = [f"# Virksomhedsfinder {stamp} UTC", "",
             f"{len(companies)} virksomheder tjekket. Jobsystem fundet hos {found_n}. Nye kilder tilføjet: {added}.", "",
             "| Virksomhed | Fundet | Status |", "| --- | --- | --- |"]
    lines += [f"| {n} | {k} | {s} |" for n, k, s in report]
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:3]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
