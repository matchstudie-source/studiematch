// Fast test af matchningen med 12 uddannelser og et frosset sæt rigtige job.
// Kør:  node tests/match.test.mjs
// Fejler testen, er en ændring i matchningen eller jobsorteringen blevet dårligere.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "site", "index.html"), "utf8");
const js = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const site = new Function(js + "\n;return {PROGRAMS, evaluate, freshProfile, progById, FAM};")();

const jobs = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "match_jobs.json"), "utf8"))
  .map(j => ({ ...j, sec: j.sec || [], skills: j.skills || [], hMin: j.hMin || 0, hMax: j.hMax || 0, postedH: 48, deadline: null, live: true }));

function feedFor(programId) {
  const p = site.progById(programId);
  if (!p) throw new Error(`Ukendt uddannelse: ${programId}`);
  const profile = Object.assign(site.freshProfile(), {
    programId: p.id, programName: p.name, programShort: p.name, weights: { ...p.w },
    danish: "fluent", hoursMax: 20, regions: ["any"], skills: [], interests: [],
  });
  const ctx = { profile, learned: {}, disabled: [] };
  return jobs.map(job => ({ job, ev: site.evaluate(job, ctx) }))
    .filter(x => !x.ev.out && x.ev.level)
    .sort((a, b) => b.ev.score - a.ev.score)
    .map(x => ({ ...x, w: p.w }));
}

// Hvilke uddannelser må se job med et bestemt uddannelseskrav (uafhængigt af sidens egen regel)
const REQ_OK = { jura: /jura/i, sygepleje: /sygepleje/i, medicin: /medicin/i, farmaci: /farmaci/i, psykologi: /psykolog/i,
  paedagog: /pædagog/i, socialraadgiver: /socialrådgiv/i, tandpleje: /tandpleje|odontologi/i, audiologopaedi: /audiologopædi/i,
  arkitekt: /arkitekt/i, konstruktoer: /konstruktør|byggeri/i, ingenioer: /maskin|bygning|byggeri|elektro|kemi|ingeniør/i,
  maritim: /maskinmester|skibs|maritim/i, oekonomi: /økonomi|economics/i };
const GBE = ["supply", "procurement", "pmo", "operations", "logistics", "bizdev", "bi", "strategy", "salesops"];
const fails = [];
const check = (name, ok, detail) => { if (!ok) fails.push(`${name}: ${detail}`); };
const fitW = (x) => Math.max(x.w[x.job.fam] || 0, ...x.job.sec.map(f => (x.w[f] || 0) * 0.85));
const show = (list) => list.slice(0, 5).map(x => `${x.job.title.slice(0, 50)} [${x.job.fam}]`).join("; ");

const PROFILES = {
  "ku-bachelor-jura": "Jura (KU)",
  "ku-bachelor-farmaci": "Farmaci (KU)",
  "dtu-diplom-global-business-og-teknologi": "GBE (DTU)",
  "kp-prof-sygeplejerske": "Sygeplejerske (KP)",
  "kp-prof-pædagog": "Pædagog (KP)",
  "au-bachelor-medicin": "Medicin (AU)",
  "cbs-bachelor-ha-i-erhvervsøkonomi": "HA (CBS)",
  "itu-bachelor-bsc-in-software-development": "Software (ITU)",
  "ruc-fag-kommunikation": "Kommunikation (RUC)",
  "ku-bachelor-psykologi": "Psykologi (KU)",
  "ruc-fag-erhvervsøkonomi-ha": "Erhvervsøkonomi (RUC)",
  "dtu-diplom-maskinteknik": "Maskinteknik (DTU)",
};

for (const [id, label] of Object.entries(PROFILES)) {
  const feed = feedFor(id);
  // Fælles regler for alle uddannelser
  for (const x of feed.slice(0, 5)) {
    check(label, fitW(x) >= 0.5, `top-5 job uden faglig sammenhæng: "${x.job.title}" [${x.job.fam}]`);
  }
  for (const x of feed) {
    if (x.job.fam === "legal" && (x.w.legal || 0) < 0.5)
      check(label, x.ev.level !== "strong", `jurajob vist som stærkt match: "${x.job.title}"`);
    if (x.job.req) check(label, (REQ_OK[x.job.req] || /./).test(label), `job kræver anden uddannelse (${x.job.req}): "${x.job.title}"`);
  }
  // Særlige forventninger
  if (label.startsWith("Jura")) {
    check(label, feed.length >= 5, `for få job (${feed.length})`);
    check(label, feed.slice(0, 5).every(x => x.job.fam === "legal" || x.job.sec.includes("legal")), `top 5 er ikke juridiske: ${show(feed)}`);
  }
  if (label.startsWith("GBE")) {
    check(label, feed.slice(0, 3).some(x => ["procurement", "supply", "pmo", "operations"].includes(x.job.fam)), `ingen indkøb/supply/projekt i top 3: ${show(feed)}`);
    check(label, feed.slice(0, 5).every(x => GBE.includes(x.job.fam) || x.job.sec.some(f => GBE.includes(f))), `top 5 uden for GBE-felter: ${show(feed)}`);
  }
  if (label.startsWith("Farmaci")) check(label, !feed.some(x => x.job.fam === "legal"), `jurajob vist for Farmaci: ${show(feed)}`);
  if (label.startsWith("Kommunikation")) check(label, feed.slice(0, 3).every(x => x.job.fam === "marketing"), `top 3 er ikke kommunikation: ${show(feed)}`);
  if (label.startsWith("Pædagog")) check(label, feed.slice(0, 3).some(x => x.job.fam === "education"), `ingen pædagogjob i top 3: ${show(feed)}`);
  if (label.startsWith("Sygeplejerske")) check(label, feed.some(x => /sygepleje/i.test(x.job.title)), `ingen sygeplejejob: ${show(feed)}`);
  console.log(`${label.padEnd(24)} ${String(feed.length).padStart(3)} job | ${show(feed).slice(0, 150)}`);
}

// Uddannelseskravet skal stadig virke: et jurajob skal vises for Jura og skjules for Farmaci
const lawJob = jobs.find(j => j.req === "jura");
if (lawJob) {
  check("Uddannelseskrav", feedFor("ku-bachelor-jura").some(x => x.job.id === lawJob.id), "jurajob vises ikke for Jura");
}

// AI-agentens vurdering: et job, agenten siger passer til farmaci, skal løftes for Farmaci og ikke for Jura
{
  const base = { id: "ai1", title: "Studentermedhjælper til Regulatory Affairs", co: "Eksempel Pharma", city: "København", region: "kbh",
    fam: "legal", sec: ["research"], famConf: "title", danish: "required", hMin: 15, hMax: 15, skills: [], postedH: 48, deadline: null, live: true };
  const ev = (job, id) => { const p = site.progById(id);
    const profile = Object.assign(site.freshProfile(), { programId: p.id, programName: p.name, weights: { ...p.w }, danish: "fluent", hoursMax: 20, regions: ["any"] });
    return site.evaluate(job, { profile, learned: {}, disabled: [] }); };
  const withAI = { ...base, studies: ["farmaci", "kemi", "jura"], why: "Arbejdet kræver forståelse af lægemiddelregler." };
  const f0 = ev(base, "ku-bachelor-farmaci"), f1 = ev(withAI, "ku-bachelor-farmaci");
  check("AI-agent", f1.affinity > f0.affinity, `løftede ikke Farmaci (${f0.affinity} -> ${f1.affinity})`);
  check("AI-agent", f1.ai === true, "Farmaci blev ikke genkendt i agentens liste");
  const g = ev({ ...base, fam: "procurement", sec: [], studies: ["jura"] }, "dtu-diplom-global-business-og-teknologi");
  const g0 = ev({ ...base, fam: "procurement", sec: [] }, "dtu-diplom-global-business-og-teknologi");
  check("AI-agent", g.ai === false && g.affinity < g0.affinity, "dæmpede ikke et job, agenten ikke mente passede");
  const open = ev({ ...base, fam: "procurement", sec: [], studies: ["jura"], openToAll: true }, "dtu-diplom-global-business-og-teknologi");
  check("AI-agent", open.affinity === g0.affinity, "dæmpede et job, der er åbent for alle");
}

if (fails.length) {
  console.error(`\n${fails.length} fejl i matchningen:\n- ` + fails.join("\n- "));
  process.exit(1);
}
console.log("\nAlle matchtests bestået.");
