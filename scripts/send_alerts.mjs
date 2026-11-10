// Jobalarmer: kører i GitHub efter hver jobindsamling.
// Henter brugere med jobmails slået til, regner deres bedste nye matches ud med sidens egen matchning
// og beder serveren sende mails. Kræver CRON_SECRET (samme værdi i GitHub og Cloudflare).
//   CRON_SECRET=... SITE_URL=https://studiematch.dk node scripts/send_alerts.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = (process.env.SITE_URL || "https://studiematch.dk").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
const PER_MAIL = 5;
if (!SECRET) { console.log("Jobalarmer: CRON_SECRET mangler, springer over."); process.exit(0); }

const html = fs.readFileSync(path.join(here, "..", "site", "index.html"), "utf8");
const js = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const site = new Function(js + "\n;return {evaluate, freshProfile, FAM};")();

const api = async (p, body) => {
  const res = await fetch(`${SITE}/api/${p}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${SECRET}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
  return res.json();
};

const t = Date.now();
const toLive = (j) => ({ ...j, sec: (j.sec || []).filter((f) => site.FAM[f]), skills: j.skills || [], hMin: j.hMin || 0, hMax: j.hMax || 0,
  postedH: j.postedAt ? Math.max(0, Math.round((t - Date.parse(j.postedAt)) / 36e5)) : 999,
  deadline: j.rolling ? null : j.deadlineAt ? Math.ceil((Date.parse(j.deadlineAt) - t) / 864e5) : null, industry: j.industry || "Andet", live: true });
let jobs = JSON.parse(fs.readFileSync(path.join(here, "..", "site", "data", "jobs.json"), "utf8"));
try { const d = await (await fetch(`${SITE}/api/jobs`)).json(); const hidden = new Set(d.hidden || []); jobs = [...(d.jobs || []), ...jobs].filter((j) => !hidden.has(j.id)); } catch { /* direkte opslag og skjulte job er en bonus */ }
jobs = jobs.filter((j) => j && j.id && j.title && site.FAM[j.fam]).map(toLive).filter((j) => j.deadline == null || j.deadline >= 1);

const { users, mail } = await api("cron/subscribers");
if (!mail) console.log("Jobalarmer: RESEND_API_KEY mangler i Cloudflare, så mails kan ikke sendes.");
const alerts = [];
for (const u of users) {
  const profile = Object.assign(site.freshProfile(), u.profile || {});
  const state = u.state || {};
  const ctx = { profile, learned: state.learned || {}, disabled: state.disabled || [] };
  const fb = state.fb || {}, sent = new Set(u.sent || []);
  const best = jobs
    .filter((j) => !sent.has(j.id) && !(fb[j.id] && (fb[j.id].dismissed || fb[j.id].applied || fb[j.id].saved)))
    .map((j) => ({ j, ev: site.evaluate(j, ctx) }))
    .filter((x) => !x.ev.out && (x.ev.level === "strong" || x.ev.level === "good"))
    .sort((a, b) => b.ev.score - a.ev.score)
    .slice(0, PER_MAIL);
  if (!best.length) continue;
  alerts.push({ userId: u.id, jobs: best.map(({ j, ev }) => ({
    id: j.id, title: j.title, co: j.co, city: j.city, url: j.url, level: ev.level,
    why: ev.ai === true && j.why ? j.why : "",
    deadline: j.deadlineAt && !j.rolling ? new Date(j.deadlineAt).toLocaleDateString("da-DK", { day: "numeric", month: "long" }) : "",
  })) });
}
const res = alerts.length && mail ? await api("cron/alerts", { alerts, dry: process.env.ALERTS_DRY === "1" }) : { sent: 0, failed: 0 };
console.log(`Jobalarmer: ${users.length} brugere skulle have mail nu, ${alerts.length} havde nye matches, ${res.sent} mails sendt${res.failed ? `, ${res.failed} fejlede` : ""}.`);
