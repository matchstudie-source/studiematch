"""Åbner Emply-karrieresider i en rigtig browser og logger, hvilke adresser siden henter job fra.
Resultatet skrives til collector/probe/emply_requests.json, så læseren kan bygges efter det."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

SITES = [
    "https://job.ballerup.dk/ledige-jobs",
    "https://aalborg.career.emply.com/",
    "https://kp.career.emply.com/",
    "https://matas.career.emply.com/",
]
out = {}
with sync_playwright() as p:
    browser = p.chromium.launch()
    for url in SITES:
        page = browser.new_page()
        seen = []
        def on_response(resp, seen=seen):
            ct = resp.headers.get("content-type", "")
            if resp.request.resource_type in ("xhr", "fetch") or "json" in ct:
                body = ""
                try:
                    body = resp.text()[:1500]
                except Exception:
                    pass
                seen.append({"url": resp.url, "method": resp.request.method, "status": resp.status,
                             "type": ct, "post": (resp.request.post_data or "")[:500], "body": body})
        page.on("response", on_response)
        try:
            page.goto(url, wait_until="networkidle", timeout=45000)
            page.wait_for_timeout(3000)
            links = page.eval_on_selector_all("a[href]", "els => els.map(e => e.href)")
        except Exception as err:
            links = [f"fejl: {err}"]
        out[url] = {"requests": seen, "links": [l for l in links if "/ad/" in l or "apply" in l][:15]}
        page.close()
    browser.close()
Path(__file__).with_name("emply_requests.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps({u: [r["url"] for r in v["requests"]] for u, v in out.items()}, indent=1))
