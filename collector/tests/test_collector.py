"""Test af jobindsamleren uden netværk. Kør: python -m unittest discover -s collector/tests -v"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import collect  # noqa: E402
import enrich  # noqa: E402
import sources  # noqa: E402

FIX = HERE / "fixtures"


def fixture(name):
    return (FIX / name).read_text(encoding="utf-8")


class ParseTests(unittest.TestCase):
    def test_teamtailor(self):
        jobs = sources.parse_teamtailor_rss(fixture("teamtailor.rss"), "Eksempel A/S")
        self.assertEqual(len(jobs), 2)
        self.assertEqual(jobs[0]["title"], "Studentermedhjælper til regnskab")
        self.assertEqual(jobs[0]["location"], "København")
        self.assertIn("bogføre bilag", jobs[0]["description"])
        self.assertTrue(jobs[0]["posted_at"].startswith("2026-10-14"))

    def test_greenhouse(self):
        jobs = sources.parse_greenhouse_json(json.loads(fixture("greenhouse.json")), "Eksempel")
        self.assertEqual(jobs[0]["company"], "Eksempel ApS")
        self.assertEqual(jobs[0]["deadline_at"][:10], "2026-11-30")
        self.assertIn("social media", jobs[0]["description"])

    def test_lever(self):
        jobs = sources.parse_lever_json(json.loads(fixture("lever.json")), "Eksempel")
        self.assertEqual(jobs[0]["commitment"], "Student Assistant")
        self.assertEqual(jobs[0]["location"], "Copenhagen")

    def test_jsonld(self):
        page = fixture("jobposting.html")
        jobs = sources.parse_jobposting_jsonld(page, "https://eksempel.dk/job/123", "Fallback", "Kommunens jobportal")
        self.assertEqual(jobs[0]["company"], "Børnehuset Eksempel")
        self.assertEqual(jobs[0]["location"], "Valby")
        self.assertEqual(sources.find_job_links(page, "https://eksempel.dk/ledige"), ["https://eksempel.dk/job/123-paedagogmedhjaelper"])


class EnrichTests(unittest.TestCase):
    def test_student_filter(self):
        self.assertTrue(enrich.is_student_job("Studentermedhjælper til regnskab", ""))
        self.assertTrue(enrich.is_student_job("Data Analyst", "", "Student Assistant"))
        self.assertFalse(enrich.is_student_job("Senior Controller", "We need a student mentor"))
        self.assertFalse(enrich.is_student_job("PhD fellowship in climate epidemiology", "studerende"))
        self.assertFalse(enrich.is_student_job("2 introduktionsstillinger i Intern Medicin", "studerende"))
        self.assertFalse(enrich.is_student_job("AV Tekniker", "Stillingen er på 37 timer om ugen. Studerende er velkomne."))
        self.assertFalse(enrich.is_student_job("Medarbejder til tværgående opgaver", "Vi samarbejder med mange studerende."))
        self.assertTrue(enrich.is_student_job("Medarbejder til kundeservice", "Et studiejob på 10-15 timer om ugen."))
        self.assertFalse(enrich.is_student_job("HR-studentmedarbetare, deltid", ""))
        self.assertTrue(enrich.is_student_job("Arkitektpraktikanter", "Praktik på fuld tid, 37 timer om ugen."))

    def test_danish(self):
        self.assertEqual(enrich.detect_danish("Du taler og skriver dansk flydende"), "required")
        self.assertEqual(enrich.detect_danish("Danish is a plus but not required"), "plus")
        self.assertEqual(enrich.detect_danish("English is our working language."), "no")

    def test_hours_region_family(self):
        self.assertEqual(enrich.detect_hours("Jobbet er 15-20 timer om ugen"), (15, 20))
        self.assertEqual(enrich.detect_hours("15 hours per week"), (15, 15))
        self.assertEqual(enrich.detect_region("Copenhagen, Denmark", "aar")[0], "cph")
        fam, _ = enrich.classify_families("Studentermedhjælper til regnskab", "bogføre bilag og månedsafslutning")
        self.assertEqual(fam, "finance")
        fam, _ = enrich.classify_families("Pædagogmedhjælper (studerende)", "faste vagter i vores børnehave")
        self.assertEqual(fam, "education")


class EndToEndTest(unittest.TestCase):
    def test_collect_writes_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            emp = tmp / "employers.csv"
            emp.write_text(
                "name,source,ref,city,region,industry,title,fam,sec,danish,hours,blurb,src_label\n"
                "Eksempel A/S,teamtailor,https://eksempel.teamtailor.com,,cph,Finans,,,,,,,\n"
                "Eksempel ApS,greenhouse,x,,cph,Tech,,,,,,,\n"
                "Eksempel Lever,lever,x,,cph,Tech,,,,,,,\n"
                "Børnehuset Eksempel,careerpage,x,,cph,Børn og unge,,,,,,,Kommunens jobportal\n"
                "Region Test,evergreen,https://eksempel.dk/vikar,,ode,Sundhed,Vikar for studerende,health,,required,,Tag vagter.,Regionens vikarordning\n"
                "Ødelagt kilde,teamtailor,https://oedelagt.teamtailor.com,,cph,Andet,,,,,,,\n",
                encoding="utf-8")
            originals = dict(collect.FETCHERS)

            def broken(_e):
                raise RuntimeError("nede")

            collect.FETCHERS.update({
                "teamtailor": lambda e: broken(e) if e["name"] == "Ødelagt kilde" else sources.parse_teamtailor_rss(fixture("teamtailor.rss"), e["name"]),
                "greenhouse": lambda e: sources.parse_greenhouse_json(json.loads(fixture("greenhouse.json")), e["name"]),
                "lever": lambda e: sources.parse_lever_json(json.loads(fixture("lever.json")), e["name"]),
                "careerpage": lambda e: sources.parse_jobposting_jsonld(fixture("jobposting.html"), "https://eksempel.dk/job/1", e["name"], e["src_label"]),
            })
            paths = {k: getattr(collect, k) for k in ("EMPLOYERS", "MANUAL", "CACHE", "REPORT", "OUT")}
            collect.EMPLOYERS, collect.MANUAL = emp, tmp / "none.csv"
            collect.CACHE, collect.REPORT, collect.OUT = tmp / "cache.json", tmp / "report.md", tmp / "jobs.json"
            try:
                collect.main()
            finally:
                collect.FETCHERS.clear()
                collect.FETCHERS.update(originals)
                for k, v in paths.items():
                    setattr(collect, k, v)
            jobs = json.loads((tmp / "jobs.json").read_text(encoding="utf-8"))
            titles = {j["title"]: j for j in jobs}
            self.assertEqual(set(titles), {"Studentermedhjælper til regnskab", "Marketing Student Assistant",
                                           "Data Analyst", "Pædagogmedhjælper (studerende)", "Vikar for studerende"})
            self.assertEqual(titles["Studentermedhjælper til regnskab"]["fam"], "finance")
            self.assertEqual(titles["Studentermedhjælper til regnskab"]["danish"], "required")
            self.assertEqual(titles["Marketing Student Assistant"]["danish"], "plus")
            self.assertEqual(titles["Data Analyst"]["danish"], "no")
            self.assertEqual(titles["Pædagogmedhjælper (studerende)"]["fam"], "education")
            self.assertTrue(titles["Vikar for studerende"]["rolling"])
            self.assertTrue(all(j["id"] and j["live"] for j in jobs))
            self.assertIn("fejl: RuntimeError", (tmp / "report.md").read_text(encoding="utf-8"))



class AiTest(unittest.TestCase):
    def test_ai_overrides_rules(self):
        class FakeResp:
            def raise_for_status(self):
                pass

            def json(self):
                return {"content": [{"type": "text", "text": '{"is_student_job": true, "fam": "finance", "sec": ["bi", "nope"], '
                                     '"danish": "plus", "h_min": 10, "h_max": 15, "skills": ["Excel"], "deadline": "2026-12-01", '
                                     '"blurb_da": "Du hjælper med regnskab."}'}]}

        original = enrich.requests.post
        enrich.requests.post = lambda *a, **k: FakeResp()
        try:
            raw = {"title": "Student", "description": "tekst", "location": "København"}
            base = enrich.enrich_rules(raw, {"name": "X", "region": "cph"})
            out = enrich.enrich_ai(raw, base, "test-key")
        finally:
            enrich.requests.post = original
        self.assertEqual((out["fam"], out["sec"], out["danish"], out["hMin"], out["hMax"]), ("finance", ["bi"], "plus", 10, 15))
        self.assertEqual(out["blurb"], "Du hjælper med regnskab.")
        self.assertEqual(out["enrichedBy"], "ai")


class FakeResp:
    def __init__(self, text="", data=None):
        self.text, self._data, self.ok = text, data, True

    def json(self):
        return self._data if self._data is not None else json.loads(self.text)


class NewSourceTests(unittest.TestCase):
    def test_hrmanager(self):
        jobs = sources.parse_hrmanager_xml(fixture("hrmanager.xml"), "Eksempel Region")
        self.assertEqual(len(jobs), 2)
        a, b = jobs
        self.assertEqual(a["title"], "Studentermedhjælper til økonomi")
        self.assertEqual(a["location"], "Vejle")
        self.assertIn("lønkørsel", a["description"])
        self.assertTrue(a["url"].startswith("https://"))
        self.assertTrue(a["deadline_at"].startswith("2026-12-01"))
        self.assertNotIn("kontakt@eksempel.dk", json.dumps(a))  # kontaktpersoner gemmes ikke
        self.assertIsNone(b["deadline_at"])
        self.assertEqual(b["location"], "Kolding")

    def test_workday(self):
        detail = json.loads(fixture("workday_job.json"))
        calls = []

        def fake_post(url, json=None):
            calls.append(url)
            data = __import__("json").loads(fixture("workday_list.json")) if json["searchText"] == "student" else {"jobPostings": []}
            return FakeResp(data=data)

        def fake_get(url, **kw):
            calls.append(url)
            d = __import__("json").loads(__import__("json").dumps(detail))
            if url.endswith("R3"):
                d["jobPostingInfo"]["location"], d["jobPostingInfo"]["country"] = "London", {"descriptor": "United Kingdom"}
            return FakeResp(data=d)

        orig = sources._post, sources._get
        sources._post, sources._get = fake_post, fake_get
        try:
            jobs = sources.fetch_workday("https://eksempel.wd3.myworkdayjobs.com/da-DK/Careers", "Eksempel")
        finally:
            sources._post, sources._get = orig
        self.assertEqual(calls[0], "https://eksempel.wd3.myworkdayjobs.com/wday/cxs/eksempel/Careers/jobs")
        self.assertEqual([j["title"] for j in jobs], ["Student Assistant, Finance"])  # München og London sorteres fra
        self.assertEqual(jobs[0]["company"], "Eksempel Pharma A/S")
        self.assertEqual(jobs[0]["location"], "Bagsværd, Denmark")
        self.assertFalse(any("Munich" in c for c in calls))  # ingen grund til at hente udenlandske opslag

    def test_microdata_and_sitemap(self):
        jobs = sources.parse_jobposting_jsonld(fixture("microdata.html"), "https://jobs.eksempel.com/job/1001", "X", "Karriereside")
        self.assertEqual(jobs[0]["title"], "Student Assistant to HR")
        self.assertEqual(jobs[0]["company"], "Eksempel A/S")
        self.assertEqual(jobs[0]["location"], "København")
        pages = {"https://jobs.eksempel.com/robots.txt": "Sitemap: https://jobs.eksempel.com/sitemap_index.xml",
                 "https://jobs.eksempel.com/sitemap_index.xml": fixture("sitemap_index.xml"),
                 "https://jobs.eksempel.com/sitemap_jobs.xml": fixture("sitemap_jobs.xml"),
                 "https://jobs.eksempel.com/sitemap_pages.xml": "<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'/>",
                 "https://jobs.eksempel.com/job/Kobenhavn-Student-Assistant-to-HR/1001/": fixture("microdata.html")}
        fetched = []

        def fake_get(url, **kw):
            fetched.append(url)
            return FakeResp(text=pages[url])

        orig = sources._get, sources._session.get, dict(sources._robots)
        sources._get = fake_get
        sources._session.get = lambda url, **kw: FakeResp(text=pages.get(url, ""))
        try:
            jobs = sources.fetch_sitemap("https://jobs.eksempel.com/", "Eksempel", "Karriereside")
        finally:
            sources._get, sources._session.get = orig[0], orig[1]
            sources._robots.clear(); sources._robots.update(orig[2])
        self.assertEqual(len(jobs), 1)
        self.assertNotIn("https://jobs.eksempel.com/job/Kobenhavn-Senior-Engineer/1002/", fetched)

    def test_in_denmark(self):
        self.assertTrue(sources.in_denmark("Kongens Lyngby, Denmark"))
        self.assertTrue(sources.in_denmark(""))
        self.assertFalse(sources.in_denmark("Munich, Germany"))


class DiscoverTests(unittest.TestCase):
    def test_detect_systems(self):
        import discover
        cases = {
            '<a href="https://eksempel.wd3.myworkdayjobs.com/da-DK/Careers/job/x">Job</a>': ("workday", "https://eksempel.wd3.myworkdayjobs.com/da-DK/Careers"),
            '<script src="https://boards.greenhouse.io/embed/job_board/js?for=eksempelaps"></script>': ("greenhouse", "eksempelaps"),
            '<a href="https://jobs.eu.lever.co/eksempel">Se job</a>': ("lever", "eksempel"),
            '<iframe src="https://candidate.hr-manager.net/Vacancies/List.aspx?customer=eksempelregion"></iframe>': ("hrmanager", "eksempelregion"),
            '<a href="https://eksempelkommune.career.emply.com/ledige-stillinger">Ledige</a>': ("emply", "https://eksempelkommune.career.emply.com"),
            '<a href="https://eksempel.teamtailor.com/jobs">Job</a>': ("teamtailor", "https://eksempel.teamtailor.com"),
            '<link href="https://rmkcdn.successfactors.com/abc/style.css">': ("sitemap", "https://jobs.eksempel.com"),
            '<script type="application/ld+json">{"@type": "JobPosting"}</script>': ("careerpage", "https://jobs.eksempel.com/ledige"),
        }
        for html, expected in cases.items():
            self.assertEqual(discover.detect(html, "https://jobs.eksempel.com/ledige")[0], expected, html)
        self.assertEqual(discover.detect('<script src="https://scripts.teamtailor-cdn.com/x.js"></script>', "https://career.eksempel.dk/jobs")[0],
                         ("teamtailor", "https://career.eksempel.dk"))
        self.assertEqual(discover.detect("<p>Ingen job her</p>", "https://eksempel.dk"), [])

    def test_discover_and_merge(self):
        import discover
        pages = {
            "https://www.eksempel.dk": '<a href="/om-os">Om os</a><a href="/karriere">Karriere</a>',
            "https://www.eksempel.dk/karriere": '<a href="https://jobs.lever.co/eksempel">Se ledige stillinger</a>',
            "https://www.ingenting.dk": "<p>Velkommen</p>",
        }
        orig = discover.fetch_html
        discover.fetch_html = lambda url: (pages[url], url) if url in pages else None
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "companies.csv").write_text("name,website,city,region,industry\nEksempel,https://www.eksempel.dk,København,cph,Tech\n"
                                               "Ingenting,https://www.ingenting.dk,Aarhus,aar,Andet\n", encoding="utf-8")
            (tmp / "employers.csv").write_text(",".join(discover.EMPLOYER_COLS) + "\n", encoding="utf-8")
            paths = {k: getattr(discover, k) for k in ("COMPANIES", "EMPLOYERS", "DISCOVERED", "REPORT")}
            discover.COMPANIES, discover.EMPLOYERS = tmp / "companies.csv", tmp / "employers.csv"
            discover.DISCOVERED, discover.REPORT = tmp / "discovered.csv", tmp / "report.md"
            try:
                discover.main(["--merge"])
                discover.main(["--merge"])  # anden kørsel må ikke give dubletter
            finally:
                discover.fetch_html = orig
                for k, v in paths.items():
                    setattr(discover, k, v)
            rows = collect.read_csv(tmp / "employers.csv")
            self.assertEqual([(r["name"], r["source"], r["ref"]) for r in rows], [("Eksempel", "lever", "eksempel")])
            self.assertIn("intet jobsystem fundet", (tmp / "report.md").read_text(encoding="utf-8"))


class FixTests(unittest.TestCase):
    def test_ashby(self):
        data = {"jobs": [
            {"title": "Finance Student Assistant", "location": "Copenhagen", "isListed": True, "employmentType": "PartTime",
             "descriptionPlain": "Help our finance team 15 hours a week.", "jobUrl": "https://jobs.ashbyhq.com/eksempel/1",
             "publishedAt": "2026-10-20T08:00:00.000+00:00"},
            {"title": "Hidden", "isListed": False}]}
        jobs = sources.parse_ashby_json(data, "Eksempel")
        self.assertEqual([j["title"] for j in jobs], ["Finance Student Assistant"])
        self.assertEqual(jobs[0]["commitment"], "PartTime")
        self.assertTrue(jobs[0]["posted_at"].startswith("2026-10-20"))

    def test_shared_hrmanager_uses_department(self):
        xml = fixture("hrmanager.xml")
        self.assertEqual(sources.parse_hrmanager_xml(xml, "Portal", shared=True)[0]["company"], "Økonomi")
        self.assertEqual(sources.parse_hrmanager_xml(xml, "Portal")[0]["company"], "Portal")

    def test_normalize_sources(self):
        rows = [
            {"name": "Skatteforvaltningen", "source": "hrmanager", "ref": "statensrekrutteringsloesning_tr"},
            {"name": "Finansministeriet", "source": "hrmanager", "ref": "statensrekrutteringsloesning_tr"},
            {"name": "Pleo", "source": "careerpage", "ref": "https://jobs.ashbyhq.com/pleo/abc"},
            {"name": "Telenor", "source": "teamtailor", "ref": "https://www.telenor.dk"},
            {"name": "ALK", "source": "teamtailor", "ref": "https://careers.alk.net"},
        ]
        out = collect.normalize_sources(rows)
        self.assertEqual([(r["name"], r["source"]) for r in out],
                         [("Statslige arbejdsgivere", "hrmanager"), ("Pleo", "ashby"), ("ALK", "teamtailor")])


class EmplyTests(unittest.TestCase):
    def test_links_and_ad(self):
        listing = ('<a href="/ad/studentermedhjaelper-til-kommunikation/wwi4fe/da">Job</a>'
                   '<a href="/da/jobagent">Jobagent</a><a href="https://andet.dk/ad/x/y">Ude</a>')
        self.assertEqual(sources.emply_ad_links(listing, "https://fh.career.emply.com/da/ledige-stillinger"),
                         ["https://fh.career.emply.com/ad/studentermedhjaelper-til-kommunikation/wwi4fe/da"])
        ad = ('<html><head><meta property="og:title" content="Studentermedhjælper til kommunikation I Career Site"></head>'
              '<body><main><h1>Studentermedhjælper til kommunikation</h1><p>10-15 timer om ugen ved siden af dit studie.</p></main></body></html>')
        jobs = sources.parse_emply_ad(ad, "https://fh.career.emply.com/ad/x/y/da", "Forsyning Helsingør", "Karriereside")
        self.assertEqual(jobs[0]["title"], "Studentermedhjælper til kommunikation")
        self.assertIn("10-15 timer", jobs[0]["description"])
        expired = '<html><body><main>Ansøgningsfristen på det pågældende job kan være udløbet eller linket kan være i stykker..</main></body></html>'
        self.assertEqual(sources.parse_emply_ad(expired, "u", "c", "l"), [])


if __name__ == "__main__":
    unittest.main()
