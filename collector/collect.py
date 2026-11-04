"""Studiematchs jobindsamler.

Kør:  python collector/collect.py
Læser collector/employers.csv og collector/manual_jobs.csv, henter job fra hver kilde,
beriger dem (regler + evt. AI), fjerner dubletter og udløbne job og skriver site/data/jobs.json.
En kort rapport skrives til collector/report.md.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

import enrich  # noqa: E402
import sources  # noqa: E402

EMPLOYERS = HERE / "employers.csv"
MANUAL = HERE / "manual_jobs.csv"
CACHE = HERE / "cache.json"
REPORT = HERE / "report.md"
REJECTED = HERE / "rejected.md"
OUT = ROOT / "site" / "data" / "jobs.json"

FETCHERS = {
    "teamtailor": lambda e: sources.fetch_teamtailor(e["ref"], e["name"]),
    "greenhouse": lambda e: sources.fetch_greenhouse(e["ref"], e["name"]),
    "lever": lambda e: sources.fetch_lever(e["ref"], e["name"]),
    "smartrecruiters": lambda e: sources.fetch_smartrecruiters(e["ref"], e["name"]),
    "careerpage": lambda e: sources.fetch_careerpage(e["ref"], e["name"], e.get("src_label") or "Virksomhedens karriereside"),
    "hrmanager": lambda e: sources.fetch_hrmanager(e["ref"], e["name"]),
    "workday": lambda e: sources.fetch_workday(e["ref"], e["name"]),
    "emply": lambda e: sources.fetch_emply(e["ref"], e["name"], e.get("src_label") or "Virksomhedens karriereside"),
    "sitemap": lambda e: sources.fetch_sitemap(e["ref"], e["name"], e.get("src_label") or "Virksomhedens karriereside"),
    "ashby": lambda e: sources.fetch_ashby(e["ref"], e["name"]),
    "workable": lambda e: sources.fetch_workable(e["ref"], e["name"]),
    "studerendeonline": lambda e: sources.fetch_studerendeonline(e["ref"], e["name"]),
    "rmk": lambda e: sources.fetch_rmk(e["ref"], e["name"], e.get("src_label") or "Virksomhedens karriereside"),
}
CAREER_HOST = re.compile(r"^https?://(careers?|jobs?|applyforjob)\.", re.I)


def normalize_sources(employers: list[dict]) -> list[dict]:
    """Retter kendte fejl fra virksomhedsfinderen og fjerner kilder, der står flere gange."""
    seen, out = set(), []
    for e in employers:
        e = dict(e)
        src, ref = e.get("source", "").lower(), e.get("ref", "")
        if src == "sitemap" and CAREER_HOST.match(ref):
            e["source"], src = "rmk", "rmk"  # karrieresider på eget underdomæne har typisk RSS-søgning
        if src == "careerpage" and "jobs.ashbyhq.com" in ref:
            e["source"], src = "ashby", "ashby"
        if src == "hrmanager" and ref.lower() in sources.HRM_SHARED:
            e["name"] = "Statslige arbejdsgivere"  # jobbene får den rigtige institution som navn
            e["industry"] = e.get("industry") or "Offentlig"
        if src == "teamtailor" and not re.search(r"teamtailor|career|job|karriere", ref, re.I):
            continue  # fundet på forsiden i stedet for jobsiden (fx www.telenor.dk)
        key = (src, ref.rstrip("/").lower())
        if src != "evergreen" and key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def now() -> datetime:
    return datetime.now(timezone.utc)


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9æøå]+", " ", (s or "").lower()).strip()


def job_id(job: dict) -> str:
    key = job.get("url") or f"{job['co']}|{job['title']}|{job.get('city', '')}"
    return "x" + hashlib.sha1(key.encode()).hexdigest()[:12]


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [{k: (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)
                if row.get("name") and not row["name"].startswith("#")]


def evergreen_job(e: dict) -> dict:
    """Løbende optag, fx regionernes vikarkorps: ingen frist, altid synlig."""
    hours = [int(x) for x in re.findall(r"\d+", e.get("hours", ""))] or [0, 0]
    return {
        "title": e["title"], "co": e["name"], "city": e.get("city", ""), "region": enrich.employer_area(e),
        "hMin": hours[0], "hMax": hours[-1], "danish": e.get("danish") or "required",
        "fam": e.get("fam") or "health", "sec": [s for s in e.get("sec", "").split("|") if s],
        "skills": [], "industry": e.get("industry") or "Andet",
        "postedAt": None, "deadlineAt": None, "rolling": True,
        "src": e.get("src_label") or "Løbende optag", "blurb": e.get("blurb", ""), "url": e["ref"],
        "enrichedBy": "manuelt",
    }


def manual_job(m: dict) -> dict:
    return {
        "title": m["title"], "co": m["name"], "city": m.get("city", ""), "region": enrich.employer_area(m),
        "hMin": int(m.get("h_min") or 0), "hMax": int(m.get("h_max") or 0), "danish": m.get("danish") or "required",
        "fam": m.get("fam") or "operations", "sec": [s for s in m.get("sec", "").split("|") if s],
        "skills": [s for s in m.get("skills", "").split("|") if s], "industry": m.get("industry") or "Andet",
        "postedAt": m.get("posted_at") or now().isoformat(), "deadlineAt": m.get("deadline") or None,
        "src": "Direkte opslag", "blurb": m.get("blurb", ""), "url": m.get("url", ""), "enrichedBy": "manuelt",
    }


def is_expired(job: dict) -> bool:
    d = job.get("deadlineAt")
    if not d:
        return False
    try:
        return datetime.fromisoformat(d.replace("Z", "+00:00")) < now()
    except ValueError:
        return False


def main() -> int:
    employers = normalize_sources(read_csv(EMPLOYERS))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    jobs, report_rows, ai_calls, rejected, pending = [], [], 0, [], []
    max_ai_calls = int(os.environ.get("STUDIEMATCH_MAX_AI_CALLS", "200"))  # loft pr. kørsel, så regningen ikke løber løbsk

    for e in employers:
        src = e.get("source", "").lower()
        if src == "evergreen":
            jobs.append(evergreen_job(e))
            report_rows.append((e["name"], src, 1, 1, ""))
            continue
        fetch = FETCHERS.get(src)
        if not fetch:
            report_rows.append((e["name"], src, 0, 0, "ukendt kildetype"))
            continue
        try:
            raw_jobs = fetch(e)
        except Exception as err:  # én kilde må ikke vælte hele kørslen
            report_rows.append((e["name"], src, 0, 0, f"fejl: {type(err).__name__}"))
            continue
        kept = 0
        for raw in raw_jobs:
            if sources.clearly_abroad(raw.get("location", "")):
                rejected.append((e["name"], raw.get("title", ""), "udlandet: " + raw.get("location", "")))
                continue  # internationale virksomheder har også job i andre lande
            base = enrich.enrich_rules(raw, e)
            if base is None:
                rejected.append((e["name"], raw.get("title", ""), "ikke et studiejob"))
                continue
            key = hashlib.sha1(f"{raw.get('url')}|{raw['title']}|{len(raw.get('description', ''))}".encode()).hexdigest()
            if key in cache:
                job = {**base, **cache[key]}
            elif api_key and len(pending) < max_ai_calls:
                job = base
                pending.append((len(jobs), key, raw, base))  # læses af AI'en bagefter, mange ad gangen
            else:
                job = base
            if job.get("skip"):
                continue
            jobs.append(job)
            kept += 1
        report_rows.append((e["name"], src, len(raw_jobs), kept, sources.LAST_NOTE.get(e["ref"], "")))

    # AI-laget: læs nye opslag parallelt, så kørslen ikke løber tør for tid
    if pending:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=int(os.environ.get("STUDIEMATCH_AI_WORKERS", "8"))) as pool:
            results = list(pool.map(lambda p: enrich.enrich_ai(p[2], p[3], api_key), pending))
        for (idx, key, _raw, _base), job in zip(pending, results):
            jobs[idx] = job
            if job.get("enrichedBy") == "ai" or job.get("skip"):
                cache[key] = {k: job[k] for k in ("fam", "sec", "danish", "hMin", "hMax", "skills", "blurb", "deadlineAt", "enrichedBy", "skip", "studies", "why", "openToAll") if k in job}
        ai_calls = len(pending)
        jobs = [j for j in jobs if not j.get("skip")]

    for m in read_csv(MANUAL):
        jobs.append(manual_job(m))

    # dubletter og udløbne job
    seen, final = set(), []
    for j in jobs:
        key = (norm(j["co"]), norm(j["title"]), norm(j.get("city", "")))
        if key in seen or is_expired(j):
            continue
        seen.add(key)
        if j["co"] in ("Statslige arbejdsgivere",) or re.fullmatch(r"[A-ZÆØÅ][\w ,&-]{0,30}", j["co"] or "") and \
                re.search(r"&| og |Stabe|Studieservice|Digitalisering|Udførelse|Planlægning|Ligebehandling", j["co"] or ""):
            m = re.match(r"^(.{4,50}?) (?:søger|leder efter)\b", j["title"])
            if m:
                j["co"] = m.group(1).strip()
        j["id"] = job_id(j)
        j["live"] = True
        final.append(j)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=1), encoding="utf-8")
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")

    lines = [f"# Jobindsamling {now().strftime('%Y-%m-%d %H:%M')} UTC", "",
             f"{len(final)} studiejob gemt. AI-kald i denne kørsel: {ai_calls}." + (f" AI-fejl: {enrich.AI_ERROR}" if enrich.AI_ERROR else ""), "",
             "| Arbejdsgiver | Kilde | Job i alt | Studiejob | Bemærkning |", "| --- | --- | --- | --- | --- |"]
    lines += [f"| {n} | {s} | {a} | {k} | {note} |" for n, s, a, k, note in report_rows]
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    rej = ["# Job sorteret fra i seneste kørsel", "", "Bruges til at tjekke, om filteret er for strengt.", "",
           "| Arbejdsgiver | Titel | Årsag |", "| --- | --- | --- |"]
    rej += [f"| {n} | {t.replace('|', '/')} | {r} |" for n, t, r in rejected
            if re.search(r"student|studie|praktik|intern", t, re.I)]  # kun dem, der ligner studiejob
    try:
        REJECTED.write_text("\n".join(rej) + "\n", encoding="utf-8")
    except OSError:
        pass
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
