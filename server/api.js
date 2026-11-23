/* Studiematchs backend. Kører som Cloudflare Pages Functions med en D1-database (binding: DB).
 *
 * Miljøvariabler i Cloudflare (Settings → Variables and secrets):
 *   ADMIN_EMAILS       kommaseparerede mails, der automatisk bliver admin (fx matchstudie@gmail.com)
 *   ANTHROPIC_API_KEY  valgfri: slår AI-agenten til (CV-læsning og ukendte uddannelser)
 *   AI_MODEL           valgfri: modelnavn, standard claude-haiku-5-5
 *   AI_DAILY_LIMIT     valgfri: højst så mange AI-kald i døgnet, standard 300
 *   RESEND_API_KEY     valgfri: sender en mail til jer, når en virksomhed skriver sig op
 *   NOTIFY_EMAIL       hvem mailen går til, standard matchstudie@gmail.com
 *   NOTIFY_FROM        afsender, standard "Studiematch <onboarding@resend.dev>"
 *   CRON_SECRET        hemmelig kode, som GitHub bruger, når den sender jobalarmer (samme værdi i GitHub og Cloudflare)
 *   SITE_URL           sidens adresse i mails, standard https://studiematch.dk
 *   MAIL_FROM          afsender på mails til brugerne (nulstil adgangskode), fx "Studiematch <noreply@studiematch.dk>".
 *                      Kræver, at studiematch.dk er bekræftet hos Resend. Uden den kan Resend kun sende til jeres egen mail.
 */

const FAMS = {
  supply: "Supply Chain", procurement: "Indkøb", pmo: "Projektledelse / PMO", bizdev: "Forretningsudvikling",
  strategy: "Strategi og rådgivning", salesops: "Salgsoperationer", logistics: "Logistik", operations: "Drift og processer",
  bi: "BI og dataanalyse", finance: "Økonomi, regnskab og revision", marketing: "Marketing og kommunikation",
  product: "Produkt og UX", software: "Softwareudvikling", datasci: "Data science", hr: "HR og rekruttering",
  sustain: "Bæredygtighed og ESG", customer: "Kundesucces", legal: "Jura og compliance", research: "Forskning",
  engineering: "Ingeniørarbejde", health: "Sundhed og pleje", education: "Pædagogik og undervisning",
  social: "Socialt arbejde", public: "Offentlig forvaltning",
};
const TRACK_TYPES = new Set(["pageview", "onboarded", "apply_click", "save", "like", "dismiss", "cv_added", "program_changed", "match_good", "match_bad", "why", "auth_open", "filter", "postjob_open", "tab"]);
const AREAS = { kbh: "Storkøbenhavn", nsj: "Nordsjælland", sj: "Midt- og Vestsjælland", ssj: "Sydsjælland og Lolland-Falster", bh: "Bornholm",
  fyn: "Fyn", sjy: "Sønderjylland", svj: "Sydvestjylland", tre: "Trekantområdet", oj: "Østjylland", mvj: "Midt- og Vestjylland", nj: "Nordjylland", remote: "Remote" };
/* Ord i jobtitlen, der peger på et felt. Bruges som forslag, når en virksomhed slår et job op (og AI ikke er slået til). */
const FAM_WORDS = {
  supply: ["supply", "planning", "planlægning", "forsyning"], procurement: ["indkøb", "procurement", "purchasing", "sourcing"],
  pmo: ["projekt", "project", "pmo"], bizdev: ["forretningsudvikling", "business development"], strategy: ["strategi", "strategy", "konsulent", "consult"],
  salesops: ["salg", "sales"], logistics: ["logistik", "logistics", "lager", "transport"], operations: ["drift", "operations", "proces", "produktion"],
  bi: ["data", "analyse", "analyst", "bi "], finance: ["økonomi", "regnskab", "bogholder", "finance", "controller", "revision", "løn"],
  marketing: ["marketing", "kommunikation", "communication", "content", "some", "social media"], product: ["produkt", "product", "ux", "design"],
  software: ["udvikler", "developer", "software", "frontend", "backend", "it-"], datasci: ["data scien", "machine learning", "ai "],
  hr: ["hr", "rekrut", "recruit"], sustain: ["bæredygtig", "esg", "klima", "sustainab"], customer: ["kunde", "customer", "support", "service"],
  legal: ["jura", "juridisk", "legal", "compliance", "advokat"], research: ["forskning", "research", "laborat"], engineering: ["ingeniør", "engineer", "teknik", "konstruktion"],
  health: ["sygepleje", "pleje", "sundhed", "læge", "patient", "klinik"], education: ["pædagog", "lærer", "undervis", "børn", "lektie"],
  social: ["social", "bosted", "støtte"], public: ["kommune", "offentlig", "sagsbehandl", "forvaltning"],
};
function guessFams(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  return Object.entries(FAM_WORDS).map(([f, ws]) => [f, ws.filter((w) => t.includes(w)).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([f]) => f);
}
const SESSION_DAYS = 90;
const COOKIE = "sm_session";

/* ---------- små hjælpere ---------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);
const now = () => Date.now();
const day = (t = now()) => new Date(t).toISOString().slice(0, 10);
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
const clip = (s, n) => String(s ?? "").slice(0, n);

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return { hash: b64(bits), salt: b64(salt) };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function tempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => chars[b % chars.length]).join("");
}
function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
/* Cookien gælder både studiematch.dk og www.studiematch.dk, så man forbliver logget ind på begge */
const cookieDomain = (host) => /(^|\.)studiematch\.dk$/i.test(String(host || "").split(":")[0]) ? "; Domain=studiematch.dk" : "";
const sessionCookie = (token, maxAge, host) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}${cookieDomain(host)}`;
/* Ved log ud slettes både den nye og en evt. gammel cookie, der kun gjaldt én adresse */
function clearCookies(res, host) {
  res.headers.append("Set-Cookie", sessionCookie("", 0, host));
  res.headers.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return res;
}

/* ---------- database ---------- */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT,
     pw_hash TEXT, pw_salt TEXT, role TEXT DEFAULT 'user', must_change_pw INTEGER DEFAULT 0, created_at INTEGER,
     last_login INTEGER, last_seen INTEGER, consent_at INTEGER, program TEXT, school TEXT, profile TEXT, state TEXT,
     cv_name TEXT, cv_text TEXT, cv_at INTEGER, cv_extract TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER, expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, day TEXT, type TEXT, path TEXT,
     ref TEXT, visitor TEXT, user_id INTEGER, job_id TEXT, label TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_day ON events(day, type)`,
  `CREATE TABLE IF NOT EXISTS companies (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, company TEXT, email TEXT)`,
  `CREATE TABLE IF NOT EXISTS program_cache (key TEXT PRIMARY KEY, weights TEXT, ts INTEGER)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS hidden_jobs (job_id TEXT PRIMARY KEY, ts INTEGER, title TEXT, by_user INTEGER)`,
  `CREATE TABLE IF NOT EXISTS alert_sent (user_id INTEGER NOT NULL, job_id TEXT NOT NULL, ts INTEGER, PRIMARY KEY (user_id, job_id))`,
  `CREATE TABLE IF NOT EXISTS password_resets (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER, used INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS posted_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, status TEXT DEFAULT 'pending',
     company TEXT, contact TEXT, email TEXT, title TEXT, city TEXT, region TEXT, h_min INTEGER, h_max INTEGER, danish TEXT,
     url TEXT, deadline TEXT, description TEXT, fam TEXT, sec TEXT, studies TEXT, why TEXT, approved_at INTEGER)`,
];
/* Kolonner, der er kommet til senere. Fejler, hvis de allerede findes, og det er fint. */
const MIGRATIONS = ["ALTER TABLE users ADD COLUMN last_alert INTEGER", "ALTER TABLE companies ADD COLUMN message TEXT", "ALTER TABLE companies ADD COLUMN name TEXT", "ALTER TABLE events ADD COLUMN meta TEXT",
  // Kun brugere, der har bevist, at de ejer mailen, kan blive admin. Eksisterende admins er bekræftet.
  "ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0", "UPDATE users SET email_verified=1 WHERE role='admin'"];
let ready = null;
function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map((s) => db.prepare(s)))
    .then(async () => { for (const m of MIGRATIONS) { try { await db.prepare(m).run(); } catch {} } })
    .catch((e) => { ready = null; throw e; });
  return ready;
}

/* ---------- mails til jer ---------- */
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function notify(env, subject, rows, replyTo) {
  if (!env.RESEND_API_KEY) return;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1F2C33">
    <h2 style="margin:0 0 12px;color:#0B7D60">${escHtml(subject)}</h2>
    <table style="border-collapse:collapse">${rows.filter(([, v]) => v).map(([k, v]) =>
      `<tr><td style="padding:4px 14px 4px 0;color:#64737B;vertical-align:top">${escHtml(k)}</td><td style="padding:4px 0;white-space:pre-wrap">${escHtml(v)}</td></tr>`).join("")}</table>
    <p style="color:#64737B;font-size:13px;margin-top:18px">Svar direkte på denne mail for at skrive til dem. Alle henvendelser står også på studiematch.dk/admin.html under Virksomheder.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || "Studiematch <onboarding@resend.dev>",
      to: String(env.NOTIFY_EMAIL || "matchstudie@gmail.com").split(",").map((x) => x.trim()).filter(Boolean),
      subject, html, ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) console.error("Resend", res.status, await res.text());
}
/* Mail til en bruger (fx nulstil adgangskode). Returnerer true, hvis Resend tog imod den. */
async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || env.NOTIFY_FROM || "Studiematch <onboarding@resend.dev>", to: [to], subject, html }),
  });
  if (!res.ok) console.error("Resend", res.status, await res.text());
  return res.ok;
}
const RESET_MINUTES = 60;

/* ---------- jobalarmer ----------
 * GitHub regner matches ud efter hver jobindsamling (samme matchning som på siden) og beder serveren sende mails.
 * Serveren holder styr på, hvem der vil have mails, hvor tit, og hvilke job de allerede har fået. */
const ALERT_GAP = { daily: 20 * 3600e3, weekly: 6.5 * 864e5 };
const siteUrl = (env, req) => env.SITE_URL || new URL(req.url).origin;
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg))).slice(0, 32);
}
function cronOk(env, req) {
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  return !!env.CRON_SECRET && got.length > 0 && safeEqual(got, env.CRON_SECRET);
}
const FONT = "'Schibsted Grotesk','Segoe UI',Helvetica,Arial,sans-serif";
function initialsOf(co) {
  const w = String(co || "").replace(/\b(A\/S|ApS|I\/S|P\/S|Denmark|Danmark)\b/gi, "").trim().split(/\s+/).filter(Boolean);
  return ((w[0] || "?")[0] + (w[1] ? w[1][0] : (w[0] || "")[1] || "")).toUpperCase();
}
// Fælles ramme om alle mails: logo øverst, hvidt kort på lys grå baggrund, kort fod
function mailShell(base, inner, foot) {
  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#F4F5F3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F3"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};color:#1A1D1C">
<tr><td style="padding:0 4px 18px">
  <a href="${base}/" style="text-decoration:none;color:#1A1D1C"><img src="${base}/icon-512.png" width="32" height="32" alt="" style="vertical-align:middle;border:0;border-radius:7px"><span style="vertical-align:middle;font-size:19px;font-weight:800;letter-spacing:-0.5px;margin-left:9px">Studiematch</span></a>
</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid #DFE2E0;border-radius:10px;padding:28px 28px 22px">${inner}</td></tr>
<tr><td style="padding:16px 4px;font-size:12.5px;line-height:1.5;color:#5D6562">${foot || ""}</td></tr>
</table></td></tr></table></body></html>`;
}
function alertMail(base, u, jobs, offUrl, freq) {
  const p = parse(u.profile, {}) || {};
  const prog = p.programShort || p.programName || "din uddannelse";
  const n = jobs.length;
  const items = jobs.map((j) => `
    <tr><td style="padding:16px 0;border-top:1px solid #DFE2E0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td width="52" valign="top"><div style="width:40px;height:40px;line-height:40px;text-align:center;border:1px solid #DFE2E0;background:#F4F5F3;border-radius:6px;font-size:13px;font-weight:700;color:#5D6562">${escHtml(initialsOf(j.co))}</div></td>
        <td valign="top">
          <div style="font-size:13.5px;color:#5D6562"><b style="color:#1A1D1C;font-weight:600">${escHtml(j.co)}</b>${j.city ? "&nbsp;&nbsp;" + escHtml(j.city) : ""}</div>
          <div style="font-size:17px;font-weight:700;line-height:1.3;margin:2px 0 4px">${escHtml(j.title)}</div>
          ${j.why ? `<div style="font-size:14px;line-height:1.45;color:#3F4744">${escHtml(j.why)}</div>` : ""}
          <div style="font-size:13px;margin-top:6px">${j.kind === "praktik" ? '<span style="color:#075E48;font-weight:600">Praktik</span>&nbsp;&nbsp;' : ""}${j.level === "strong" ? '<span style="color:#0B7D60;font-weight:600">Stærkt match</span>' : '<span style="color:#2F5E9E;font-weight:600">Godt match</span>'}${j.deadline ? `<span style="color:#5D6562">&nbsp;&nbsp;Frist ${escHtml(j.deadline)}</span>` : ""}</div>
          <a href="${escHtml(j.url)}" style="display:inline-block;margin-top:10px;background:#FFFFFF;border:1px solid #C9CECB;border-radius:6px;padding:7px 14px;color:#1A1D1C;font-size:14px;font-weight:600;text-decoration:none">Se jobbet</a>
        </td></tr></table>
    </td></tr>`).join("");
  const inner = `
    <p style="font-size:15px;margin:0 0 6px;color:#5D6562">Hej${u.name ? " " + escHtml(u.name) : ""}</p>
    <h1 style="font-size:23px;line-height:1.2;letter-spacing:-0.4px;margin:0 0 6px;font-weight:800">${n === 1 ? "Et nyt studiejob" : `${n} nye studiejob`}, der passer til ${escHtml(prog)}</h1>
    <p style="font-size:15px;margin:0 0 14px;color:#5D6562">Fundet ud fra din uddannelse, dine timer og dine områder.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items}</table>
    <p style="margin:20px 0 0"><a href="${base}/" style="display:inline-block;background:#0B7D60;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:6px">Se alle dine match</a></p>`;
  const foot = `Du får denne mail ${freq === "weekly" ? "højst én gang om ugen" : "højst én gang om dagen"}, fordi du har slået jobmails til på Studiematch. Du kan ændre det under Profil eller <a href="${offUrl}" style="color:#5D6562">afmelde jobmails med ét klik</a>.`;
  return { subject: n === 1 ? `Nyt studiejob til dig: ${jobs[0].title}`.slice(0, 120) : `${n} nye studiejob til dig som ${prog}`.slice(0, 120), html: mailShell(base, inner, foot) };
}
async function salt(db) {
  const row = await db.prepare("SELECT v FROM kv WHERE k='salt'").first();
  if (row) return row.v;
  const v = randHex(16);
  await db.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('salt', ?)").bind(v).run();
  return (await db.prepare("SELECT v FROM kv WHERE k='salt'").first()).v;
}

/* ---------- brugere og sessioner ---------- */
function adminEmails(env) {
  return new Set(String(env.ADMIN_EMAILS || "").split(",").map(cleanEmail).filter(Boolean));
}
async function currentUser(ctx) {
  const token = getCookie(ctx.request, COOKIE);
  if (!token) return null;
  const db = ctx.env.DB;
  const row = await db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?"
  ).bind(await sha256(token), now()).first();
  if (!row) return null;
  if (adminEmails(ctx.env).has(row.email) && row.role !== "admin" && row.email_verified) {
    await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(row.id).run();
    row.role = "admin";
  }
  if (!row.last_seen || now() - row.last_seen > 10 * 60 * 1000) {
    await db.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(now(), row.id).run();
  }
  return row;
}
async function startSession(db, userId, host) {
  const token = randHex(32);
  await db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), now() + SESSION_DAYS * 864e5).run();
  await db.prepare("UPDATE users SET last_login=?, last_seen=? WHERE id=?").bind(now(), now(), userId).run();
  return sessionCookie(token, SESSION_DAYS * 86400, host);
}
function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name || "", role: u.role, mustChangePassword: !!u.must_change_pw, createdAt: u.created_at } : null;
}
function parse(s, fallback = null) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

/* ---------- AI-agenten ---------- */
async function aiAllowed(ctx) {
  if (!ctx.env.ANTHROPIC_API_KEY) return false;
  const limit = Number(ctx.env.AI_DAILY_LIMIT || 300);
  const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE day=? AND type='ai_call'").bind(day()).first();
  return (row?.n || 0) < limit;
}
async function askAI(ctx, prompt, maxTokens = 900) {
  await ctx.env.DB.prepare("INSERT INTO events (ts, day, type) VALUES (?, ?, 'ai_call')").bind(now(), day()).run();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ctx.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ctx.env.AI_MODEL || "claude-haiku-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`AI ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI svarede ikke med JSON");
  return JSON.parse(m[0]);
}
const famList = () => Object.entries(FAMS).map(([k, v]) => `${k} = ${v}`).join("\n");
function cleanWeights(w) {
  const out = {};
  for (const [k, v] of Object.entries(w || {})) {
    const n = Number(v);
    if (FAMS[k] && n >= 0.3) out[k] = Math.round(Math.min(1, n) * 100) / 100;
  }
  return out;
}
async function programWeights(ctx, name, school) {
  const key = `${clip(name, 120).toLowerCase().trim()}|${clip(school, 60).toLowerCase().trim()}`;
  const db = ctx.env.DB;
  const hit = await db.prepare("SELECT weights FROM program_cache WHERE key=?").bind(key).first();
  if (hit) return parse(hit.weights);
  if (!(await aiAllowed(ctx))) return null;
  const out = await askAI(ctx,
    `Du hjælper en dansk side, der anbefaler studiejob ud fra uddannelse.\n` +
    `Uddannelse: "${clip(name, 120)}"${school ? ` på ${clip(school, 60)}` : ""}.\n` +
    `Giv for hvert relevant jobfelt et tal fra 0 til 1 for, hvor godt en studerende på uddannelsen passer til studiejob i feltet. ` +
    `1 = kernefelt, 0.6 = god pasform, 0.4 = muligt. Udelad felter under 0.3. Brug kun disse nøgler:\n${famList()}\n` +
    `Svar kun med JSON: {"weights": {"nøgle": tal}}`, 400);
  const w = cleanWeights(out.weights);
  if (Object.keys(w).length) await db.prepare("INSERT OR REPLACE INTO program_cache (key, weights, ts) VALUES (?, ?, ?)").bind(key, JSON.stringify(w), now()).run();
  return Object.keys(w).length ? w : null;
}
async function cvExtract(ctx, text, programName) {
  if (!(await aiAllowed(ctx))) return null;
  const out = await askAI(ctx,
    `Læs dette CV fra en dansk studerende${programName ? ` (læser ${clip(programName, 100)})` : ""}. ` +
    `Find det, der hjælper med at matche vedkommende med studiejob.\n` +
    `Jobfelter (brug kun disse nøgler):\n${famList()}\n\n` +
    `Svar kun med JSON:\n{"skills": ["konkrete værktøjer og metoder, fx Excel, SAP, Python, kundeservice"],` +
    ` "experience": [{"title": "stilling", "org": "arbejdsplads", "years": "fx 2023-2025", "fams": ["nøgle"]}],` +
    ` "interests": ["nøgle"], "summary": "én sætning på dansk om profilen"}\n` +
    `Højst 12 skills og 8 erfaringer. Opfind intet.\n\nCV:\n${clip(text, 12000)}`, 1200);
  return {
    skills: (out.skills || []).map((s) => clip(s, 40)).filter(Boolean).slice(0, 12),
    experience: (out.experience || []).slice(0, 8).map((e) => ({
      title: clip(e.title, 80), org: clip(e.org, 80), years: clip(e.years, 30), fams: (e.fams || []).filter((f) => FAMS[f]),
    })).filter((e) => e.title),
    interests: (out.interests || []).filter((f) => FAMS[f]).slice(0, 5),
    summary: clip(out.summary, 300),
    by: "ai",
  };
}

/* ---------- ruter ---------- */
async function readBody(req, max = 300000) {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error("For stor"), { status: 413 });
  return text ? JSON.parse(text) : {};
}

async function route(ctx, path, method) {
  const { request: req, env } = ctx;
  const db = env.DB;

  if (path === "health") return json({ ok: true, ai: !!env.ANTHROPIC_API_KEY });

  /* ----- sporing (anonym: ingen cookies, besøgende tælles med en daglig hash) ----- */
  if (path === "track" && method === "POST") {
    const ua = req.headers.get("User-Agent") || "";
    if (/bot|crawl|spider|preview|monitor/i.test(ua)) return new Response(null, { status: 204 });
    const b = await readBody(req, 4000);
    const type = String(b.type || "");
    if (!TRACK_TYPES.has(type)) return err("Ukendt type");
    const ip = req.headers.get("CF-Connecting-IP") || "";
    const visitor = (await sha256(`${await salt(db)}|${day()}|${ip}|${ua}`)).slice(0, 16);
    let ref = "";
    try { const h = new URL(String(b.ref || "")).hostname; if (h && h !== new URL(req.url).hostname) ref = h; } catch {}
    const user = await currentUser(ctx);
    await db.prepare("INSERT INTO events (ts, day, type, path, ref, visitor, user_id, job_id, label, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now(), day(), type, clip(b.path, 100), ref, visitor, user?.id ?? null, clip(b.jobId, 40) || null, clip(b.label, 160) || null, clip(b.meta, 120) || null).run();
    return new Response(null, { status: 204 });
  }

  /* ----- virksomheders venteliste ----- */
  if (path === "waitlist" && method === "POST") {
    const b = await readBody(req, 6000);
    const email = cleanEmail(b.email);
    if (!validEmail(email) || !String(b.company || "").trim()) return err("Udfyld virksomhed og mail");
    const company = clip(b.company, 120).trim(), name = clip(b.name, 80).trim(), message = clip(b.message, 2000).trim();
    await db.prepare("INSERT INTO companies (ts, company, email, name, message) VALUES (?, ?, ?, ?, ?)").bind(now(), company, email, name || null, message || null).run();
    const send = notify(env, `Ny virksomhed: ${company}`, [["Virksomhed", company], ["Kontakt", name], ["Mail", email], ["Besked", message]], email).catch((e) => console.error(e));
    if (ctx.waitUntil) ctx.waitUntil(send); else await send;
    return json({ ok: true });
  }

  /* ----- virksomheder slår studiejob op (godkendes i admin) ----- */
  if (path === "jobs/submit" && method === "POST") {
    const b = await readBody(req, 12000);
    const email = cleanEmail(b.email);
    const need = { company: "virksomhed", title: "jobtitel", city: "by", description: "beskrivelse" };
    for (const [k, l] of Object.entries(need)) if (!String(b[k] || "").trim()) return err(`Udfyld ${l}`);
    if (!validEmail(email)) return err("Skriv en gyldig mail");
    if (!AREAS[b.region]) return err("Vælg en landsdel");
    let url = String(b.url || "").trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    if (url) { try { new URL(url); } catch { return err("Linket ser ikke rigtigt ud"); } }
    const hMin = Math.max(0, Math.min(40, parseInt(b.hMin) || 0)), hMax = Math.max(hMin, Math.min(40, parseInt(b.hMax) || hMin));
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline || "")) ? b.deadline : null;
    const danish = ["required", "plus", "no"].includes(b.danish) ? b.danish : "required";
    const title = clip(b.title, 140).trim(), description = clip(b.description, 4000).trim(), company = clip(b.company, 120).trim();
    let fams = guessFams(`${title} ${title} ${description}`), studies = null, why = null;
    try {
      if (await aiAllowed(ctx)) {
        const a = await askAI(ctx, `Et studiejob slået op på en dansk side for studerende.\nTitel: ${title}\nVirksomhed: ${company}\nTekst: ${description.slice(0, 3000)}\n\n` +
          `Felter (brug kun disse nøgler):\n${famList()}\n\nSvar kun med JSON: {"fam": "nøgle", "sec": ["op til 2 nøgler"], ` +
          `"studies": ["op til 8 uddannelser i små bogstaver, fx farmaci, ha, jura"], "why": "én sætning på dansk om hvem jobbet passer til"}`, 400);
        if (FAMS[a.fam]) fams = [a.fam, ...(a.sec || []).filter((f) => FAMS[f] && f !== a.fam)];
        studies = (a.studies || []).map((x) => clip(x, 50).toLowerCase()).slice(0, 8);
        why = clip(a.why, 200);
      }
    } catch {}
    const r = await db.prepare(`INSERT INTO posted_jobs (ts, status, company, contact, email, title, city, region, h_min, h_max, danish, url, deadline, description, fam, sec, studies, why)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(now(), company, clip(b.contact, 80).trim() || null, email, title, clip(b.city, 80).trim(),
      b.region, hMin, hMax, danish, url || null, deadline, description, fams[0] || "operations", JSON.stringify(fams.slice(1, 3)),
      studies ? JSON.stringify(studies) : null, why).run();
    const send = notify(env, `Nyt studiejob til godkendelse: ${title}`, [["Virksomhed", company], ["Job", title], ["Sted", `${clip(b.city, 80)} (${AREAS[b.region]})`],
      ["Timer", hMax ? `${hMin}-${hMax} t/uge` : ""], ["Kontakt", `${clip(b.contact, 80)} ${email}`], ["Beskrivelse", description.slice(0, 1200)],
      ["Godkend", "studiematch.dk/admin.html → fanen Job"]], email).catch((e) => console.error(e));
    if (ctx.waitUntil) ctx.waitUntil(send); else await send;
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (path === "jobs" && method === "GET") {
    const rows = await db.prepare(`SELECT * FROM posted_jobs WHERE status='approved' AND (deadline IS NULL OR deadline >= ?) ORDER BY approved_at DESC LIMIT 300`).bind(day()).all();
    const jobs = rows.results.map((j) => ({
      id: `p${j.id}`, title: j.title, co: j.company, city: j.city, region: j.region, hMin: j.h_min || 0, hMax: j.h_max || 0, danish: j.danish,
      fam: j.fam, sec: parse(j.sec, []), famConf: "title", skills: [], industry: "Andet", postedAt: new Date(j.approved_at || j.ts).toISOString(),
      deadlineAt: j.deadline ? `${j.deadline}T23:59:00+01:00` : null, src: "Studiematch, direkte fra virksomheden",
      blurb: clip(j.description.replace(/\s+/g, " "), 280), description: j.description,
      url: j.url || `mailto:${j.email}?subject=${encodeURIComponent("Ansøgning: " + j.title)}`, studies: parse(j.studies, undefined), why: j.why || undefined, direct: true,
    }));
    const hidden = (await db.prepare("SELECT job_id FROM hidden_jobs").all()).results.map((r) => r.job_id);
    return json({ jobs, hidden }, 200, { "Cache-Control": "public, max-age=60" });
  }

  /* ----- konto ----- */
  if (path === "auth/signup" && method === "POST") {
    const b = await readBody(req, 300000);
    const email = cleanEmail(b.email), password = String(b.password || "");
    if (!validEmail(email)) return err("Skriv en gyldig mail");
    if (password.length < 8) return err("Adgangskoden skal være mindst 8 tegn");
    if (!b.consent) return err("Du skal acceptere privatlivspolitikken");
    if (await db.prepare("SELECT id FROM users WHERE email=?").bind(email).first()) return err("Der findes allerede en bruger med den mail. Log ind i stedet.", 409);
    const { hash, salt: s } = await hashPassword(password);
    const role = "user"; // admin kræver bekræftet mail (via nulstil adgangskode), se currentUser
    const p = b.profile || {};
    const r = await db.prepare(`INSERT INTO users (email, name, pw_hash, pw_salt, role, created_at, consent_at, program, school, profile, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(email, clip(b.name, 80), hash, s, role, now(), now(),
      clip(p.programName, 120) || null, clip(p.uni, 60) || null, b.profile ? JSON.stringify(b.profile) : null, b.state ? JSON.stringify(b.state) : null).run();
    const id = r.meta.last_row_id;
    await db.prepare("INSERT INTO events (ts, day, type, user_id) VALUES (?, ?, 'signup', ?)").bind(now(), day(), id).run();
    const cookie = await startSession(db, id, new URL(req.url).host);
    return json({ user: publicUser({ id, email, name: b.name, role, created_at: now() }) }, 200, { "Set-Cookie": cookie });
  }
  if (path === "auth/login" && method === "POST") {
    const b = await readBody(req, 2000);
    const email = cleanEmail(b.email);
    const fails = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='login_fail' AND label=? AND ts>?").bind(email, now() - 15 * 60000).first();
    if ((fails?.n || 0) >= 10) return err("For mange forsøg. Prøv igen om et kvarter.", 429);
    const u = await db.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    const ok = u && u.pw_hash && safeEqual((await hashPassword(String(b.password || ""), u.pw_salt)).hash, u.pw_hash);
    if (!ok) {
      await db.prepare("INSERT INTO events (ts, day, type, label) VALUES (?, ?, 'login_fail', ?)").bind(now(), day(), email).run();
      return err("Forkert mail eller adgangskode", 401);
    }
    if (adminEmails(env).has(email) && u.role !== "admin" && u.email_verified) { await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(u.id).run(); u.role = "admin"; }
    const cookie = await startSession(db, u.id, new URL(req.url).host);
    return json({ user: publicUser(u), profile: parse(u.profile), state: parse(u.state), cv: u.cv_name ? { name: u.cv_name, at: u.cv_at, extract: parse(u.cv_extract) } : null },
      200, { "Set-Cookie": cookie });
  }
  /* ----- jobalarmer: kaldes af GitHub efter hver jobindsamling ----- */
  if (path === "cron/subscribers" && method === "GET") {
    if (!cronOk(env, req)) return err("Ingen adgang", 401);
    const rows = await db.prepare(`SELECT id, email, name, profile, state, last_alert FROM users
      WHERE json_extract(profile, '$.alerts') = 1 AND json_extract(profile, '$.programName') <> ''`).all();
    const due = rows.results.filter((u) => {
      const freq = (parse(u.profile, {}) || {}).alertFreq === "weekly" ? "weekly" : "daily";
      return !u.last_alert || now() - u.last_alert >= ALERT_GAP[freq];
    });
    const out = [];
    for (const u of due) {
      const sent = await db.prepare("SELECT job_id FROM alert_sent WHERE user_id=? AND ts>?").bind(u.id, now() - 120 * 864e5).all();
      out.push({ id: u.id, profile: parse(u.profile), state: parse(u.state), sent: sent.results.map((r) => r.job_id) });
    }
    return json({ users: out, mail: !!env.RESEND_API_KEY });
  }
  if (path === "cron/alerts" && method === "POST") {
    if (!cronOk(env, req)) return err("Ingen adgang", 401);
    const b = await readBody(req, 2_000_000);
    const base = siteUrl(env, req);
    let sent = 0, failed = 0;
    for (const a of (b.alerts || []).slice(0, Number(env.ALERT_MAX_PER_RUN || 90))) {
      const u = await db.prepare("SELECT * FROM users WHERE id=?").bind(Number(a.userId)).first();
      const jobs = (a.jobs || []).slice(0, 6).map((j) => ({ id: clip(j.id, 60), title: clip(j.title, 140), co: clip(j.co, 100), city: clip(j.city, 60),
        url: /^https?:\/\//.test(String(j.url || "")) ? clip(j.url, 400) : `${base}/`, why: clip(j.why, 200), deadline: clip(j.deadline, 30), level: j.level === "strong" ? "strong" : "good" }));
      if (!u || !jobs.length || (parse(u.profile, {}) || {}).alerts !== true) continue;
      const freq = (parse(u.profile, {}) || {}).alertFreq === "weekly" ? "weekly" : "daily";
      const offUrl = `${base}/api/alerts/off?u=${u.id}&t=${await hmac(env.CRON_SECRET, "off:" + u.id)}`;
      const mail = alertMail(base, u, jobs, offUrl, freq);
      const ok = b.dry ? true : await sendMail(env, u.email, mail.subject, mail.html);
      if (!ok) { failed++; continue; }
      sent++;
      await db.batch([
        db.prepare("UPDATE users SET last_alert=? WHERE id=?").bind(now(), u.id),
        ...jobs.map((j) => db.prepare("INSERT OR IGNORE INTO alert_sent (user_id, job_id, ts) VALUES (?, ?, ?)").bind(u.id, j.id, now())),
        db.prepare("INSERT INTO events (ts, day, type, user_id, label) VALUES (?, ?, 'alert_sent', ?, ?)").bind(now(), day(), u.id, `${jobs.length} job`),
      ]);
    }
    return json({ sent, failed });
  }
  if (path === "alerts/off" && method === "GET") {
    const url = new URL(req.url);
    const id = Number(url.searchParams.get("u"));
    const page = (msg) => new Response(`<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jobmails · Studiematch</title>
      <body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1F2C33;line-height:1.5"><h1 style="color:#0B7D60;font-size:24px">${msg}</h1>
      <p>Du kan altid slå jobmails til igen under Profil på <a href="/" style="color:#0B7D60">studiematch.dk</a>.</p></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (!env.CRON_SECRET || !id || !safeEqual(String(url.searchParams.get("t") || ""), await hmac(env.CRON_SECRET, "off:" + id))) return page("Linket virker ikke");
    const u = await db.prepare("SELECT profile FROM users WHERE id=?").bind(id).first();
    if (u) { const p = parse(u.profile, {}) || {}; p.alerts = false; await db.prepare("UPDATE users SET profile=? WHERE id=?").bind(JSON.stringify(p), id).run(); }
    return page("Du får ikke flere jobmails");
  }

  /* ----- glemt adgangskode: et link på mail, der virker i en time ----- */
  if (path === "auth/forgot" && method === "POST") {
    const b = await readBody(req, 2000);
    const email = cleanEmail(b.email);
    if (!validEmail(email)) return err("Skriv en gyldig mail");
    if (!env.RESEND_API_KEY) return err("Nulstilling på mail er ikke slået til endnu. Skriv til matchstudie@gmail.com.", 503);
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='reset_req' AND label=? AND ts>?").bind(email, now() - 3600e3).first();
    await db.prepare("INSERT INTO events (ts, day, type, label) VALUES (?, ?, 'reset_req', ?)").bind(now(), day(), email).run();
    const u = await db.prepare("SELECT id, name FROM users WHERE email=?").bind(email).first();
    /* Samme svar, uanset om brugeren findes, så ingen kan teste, hvilke mails der har en bruger */
    if (u && (recent?.n || 0) < 3) {
      const token = randHex(32);
      await db.prepare("INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), u.id, now() + RESET_MINUTES * 60e3).run();
      const link = `${env.SITE_URL || new URL(req.url).origin}/#nulstil=${token}`;
      const base = env.SITE_URL || new URL(req.url).origin;
      const html = mailShell(base, `
        <h1 style="font-size:23px;line-height:1.2;letter-spacing:-0.4px;margin:0 0 12px;font-weight:800">Vælg en ny adgangskode</h1>
        <p style="font-size:15px;line-height:1.5;margin:0 0 10px">Hej${u.name ? " " + escHtml(u.name) : ""}</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 18px">Nogen, forhåbentlig dig, har bedt om at nulstille adgangskoden til din bruger på Studiematch. Tryk på knappen for at vælge en ny. Linket virker i ${RESET_MINUTES} minutter.</p>
        <p style="margin:0 0 8px"><a href="${link}" style="display:inline-block;background:#0B7D60;color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:6px">Vælg ny adgangskode</a></p>`,
        "Har du ikke bedt om det, kan du bare ignorere mailen. Din adgangskode er ikke ændret.");
      const send = sendMail(env, email, "Nulstil din adgangskode til Studiematch", html).catch((e) => console.error(e));
      if (ctx.waitUntil) ctx.waitUntil(send); else await send;
    }
    return json({ ok: true });
  }
  if (path === "auth/reset" && method === "POST") {
    const b = await readBody(req, 2000);
    const password = String(b.password || "");
    if (password.length < 8) return err("Adgangskoden skal være mindst 8 tegn");
    const row = await db.prepare("SELECT * FROM password_resets WHERE token=?").bind(await sha256(String(b.token || ""))).first();
    if (!row || row.used || row.expires_at < now()) return err("Linket er udløbet eller allerede brugt. Bed om et nyt.", 400);
    const { hash, salt: s } = await hashPassword(password);
    await db.batch([
      db.prepare("UPDATE users SET pw_hash=?, pw_salt=?, must_change_pw=0, email_verified=1 WHERE id=?").bind(hash, s, row.user_id),
      db.prepare("UPDATE password_resets SET used=1 WHERE user_id=?").bind(row.user_id),
      db.prepare("DELETE FROM sessions WHERE user_id=?").bind(row.user_id),
    ]);
    const u = await db.prepare("SELECT * FROM users WHERE id=?").bind(row.user_id).first();
    const cookie = await startSession(db, u.id, new URL(req.url).host);
    return json({ user: publicUser(u), profile: parse(u.profile), state: parse(u.state) }, 200, { "Set-Cookie": cookie });
  }
  if (path === "auth/logout" && method === "POST") {
    const token = getCookie(req, COOKIE);
    if (token) await db.prepare("DELETE FROM sessions WHERE token=?").bind(await sha256(token)).run();
    return clearCookies(json({ ok: true }), new URL(req.url).host);
  }

  /* ----- det, der kræver login ----- */
  const user = await currentUser(ctx);
  if (path === "me" && method === "GET") {
    if (!user) return json({ user: null, ai: !!env.ANTHROPIC_API_KEY });
    return json({ user: publicUser(user), profile: parse(user.profile), state: parse(user.state), ai: !!env.ANTHROPIC_API_KEY,
      cv: user.cv_name ? { name: user.cv_name, at: user.cv_at, extract: parse(user.cv_extract) } : null });
  }
  if (path === "agent/program" && method === "POST") {
    const b = await readBody(req, 2000);
    if (!String(b.name || "").trim()) return err("Mangler uddannelse");
    try { return json({ weights: await programWeights(ctx, b.name, b.school) }); }
    catch { return json({ weights: null }); }
  }
  if (!user) return err("Du er ikke logget ind", 401);

  if (path === "me/state" && method === "PUT") {
    const b = await readBody(req, 300000);
    const p = b.profile || {};
    await db.prepare("UPDATE users SET profile=?, state=?, program=?, school=?, name=COALESCE(NULLIF(?, ''), name) WHERE id=?")
      .bind(JSON.stringify(b.profile || null), JSON.stringify(b.state || null), clip(p.programName, 120) || null, clip(p.uni, 60) || null, clip(b.name, 80), user.id).run();
    return json({ ok: true });
  }
  if (path === "me/password" && method === "POST") {
    const b = await readBody(req, 2000);
    const okOld = user.must_change_pw || safeEqual((await hashPassword(String(b.current || ""), user.pw_salt)).hash, user.pw_hash);
    if (!okOld) return err("Den nuværende adgangskode er forkert", 401);
    if (String(b.password || "").length < 8) return err("Adgangskoden skal være mindst 8 tegn");
    const { hash, salt: s } = await hashPassword(String(b.password));
    await db.prepare("UPDATE users SET pw_hash=?, pw_salt=?, must_change_pw=0 WHERE id=?").bind(hash, s, user.id).run();
    return json({ ok: true });
  }
  if (path === "me/cv" && method === "POST") {
    const b = await readBody(req, 200000);
    const text = clip(b.text, 60000);
    if (text.trim().length < 40) return err("Vi kunne ikke læse tekst i CV'et");
    let extract = null;
    try { extract = await cvExtract(ctx, text, parse(user.profile)?.programName); } catch { extract = null; }
    await db.prepare("UPDATE users SET cv_name=?, cv_text=?, cv_at=?, cv_extract=? WHERE id=?")
      .bind(clip(b.name, 120), text, now(), extract ? JSON.stringify(extract) : null, user.id).run();
    return json({ extract });
  }
  if (path === "me/cv" && method === "DELETE") {
    await db.prepare("UPDATE users SET cv_name=NULL, cv_text=NULL, cv_at=NULL, cv_extract=NULL WHERE id=?").bind(user.id).run();
    return json({ ok: true });
  }
  if (path === "me" && method === "DELETE") {
    await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      db.prepare("UPDATE events SET user_id=NULL WHERE user_id=?").bind(user.id),
      db.prepare("DELETE FROM users WHERE id=?").bind(user.id),
    ]);
    return clearCookies(json({ ok: true }), new URL(req.url).host);
  }

  /* ----- admin ----- */
  if (path.startsWith("admin/")) {
    if (user.role !== "admin") return err(adminEmails(env).has(user.email) ? "Bekræft først, at mailen er din: log ud, tryk Glemt adgangskode og vælg en ny via linket i mailen." : "Kun for administratorer", 403);
    return admin(ctx, path.slice(6), method, user);
  }
  return err("Findes ikke", 404);
}

async function admin(ctx, path, method, me) {
  const db = ctx.env.DB;
  const req = ctx.request;
  if (path === "stats" && method === "GET") {
    const since = day(now() - 29 * 864e5);
    const q = (sql, ...a) => db.prepare(sql).bind(...a);
    const [daily, signups, totals, topJobs, refs, paths, programs, funnel, companies, recent, quality, badList, reasons, pendingJobs, alertStats, todayV, hours, dows, actions, anonPrograms] = await db.batch([
      q(`SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS views FROM events WHERE type='pageview' AND day>=? GROUP BY day ORDER BY day`, since),
      q(`SELECT day, COUNT(*) AS n FROM events WHERE type='signup' AND day>=? GROUP BY day`, since),
      q(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM users WHERE cv_name IS NOT NULL) AS with_cv,
           (SELECT COUNT(*) FROM users WHERE last_seen > ?) AS active7`, now() - 7 * 864e5),
      q(`SELECT job_id, label, COUNT(*) AS n FROM events WHERE type='apply_click' AND day>=? GROUP BY job_id ORDER BY n DESC LIMIT 15`, since),
      q(`SELECT ref, COUNT(DISTINCT visitor) AS n FROM events WHERE type='pageview' AND ref<>'' AND day>=? GROUP BY ref ORDER BY n DESC LIMIT 10`, since),
      q(`SELECT path, COUNT(*) AS n FROM events WHERE type='pageview' AND day>=? GROUP BY path ORDER BY n DESC LIMIT 10`, since),
      q(`SELECT COALESCE(program,'(ikke valgt)') AS program, COALESCE(school,'') AS school, COUNT(*) AS n FROM users GROUP BY program, school ORDER BY n DESC LIMIT 15`),
      q(`SELECT type, COUNT(*) AS n, COUNT(DISTINCT visitor) AS people FROM events WHERE day>=? AND type IN ('pageview','onboarded','apply_click','save','like','dismiss','cv_added') GROUP BY type`, since),
      q(`SELECT ts, company, email, name, message FROM companies ORDER BY ts DESC LIMIT 100`),
      q(`SELECT ts, type, label, path FROM events WHERE type IN ('signup','apply_click','onboarded','cv_added') ORDER BY ts DESC LIMIT 25`),
      q(`SELECT type, COUNT(*) AS n FROM events WHERE type IN ('match_good','match_bad') AND day>=? GROUP BY type`, since),
      q(`SELECT ts, label, meta FROM events WHERE type='match_bad' ORDER BY ts DESC LIMIT 20`),
      q(`SELECT COALESCE(meta,'(ingen grund)') AS reason, COUNT(*) AS n FROM events WHERE type='dismiss' AND day>=? GROUP BY reason ORDER BY n DESC`, since),
      q(`SELECT COUNT(*) AS n FROM posted_jobs WHERE status='pending'`),
      q(`SELECT (SELECT COUNT(*) FROM users WHERE json_extract(profile,'$.alerts')=1) AS subs, (SELECT COUNT(*) FROM events WHERE type='alert_sent' AND day>=?) AS mails`, since),
      q(`SELECT COUNT(DISTINCT visitor) AS all_v, COUNT(DISTINCT CASE WHEN user_id IS NULL THEN visitor END) AS anon_v,
           COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN visitor END) AS user_v FROM events WHERE day=? AND visitor IS NOT NULL`, day()),
      q(`SELECT ((ts/3600000) + 1) % 24 AS hour, COUNT(DISTINCT visitor || day) AS n FROM events WHERE type='pageview' AND day>=? GROUP BY hour`, since),
      q(`SELECT ((ts/86400000) + 3) % 7 AS dow, COUNT(DISTINCT visitor || day) AS n FROM events WHERE type='pageview' AND day>=? GROUP BY dow`, since),
      q(`SELECT type, COUNT(*) AS n FROM events WHERE day>=? AND visitor IS NOT NULL AND type NOT IN ('pageview') GROUP BY type ORDER BY n DESC`, since),
      q(`SELECT label, COUNT(*) AS n FROM events WHERE type='onboarded' AND day>=? AND user_id IS NULL AND label IS NOT NULL GROUP BY label ORDER BY n DESC LIMIT 15`, since),
    ]);
    return json({
      daily: daily.results, signups: signups.results, totals: totals.results[0], topJobs: topJobs.results,
      referrers: refs.results, paths: paths.results, programs: programs.results, funnel: funnel.results,
      companies: companies.results, recent: recent.results, ai: !!ctx.env.ANTHROPIC_API_KEY, mail: !!ctx.env.RESEND_API_KEY,
      quality: Object.fromEntries(quality.results.map((r) => [r.type, r.n])), badMatches: badList.results, dismissReasons: reasons.results,
      pendingJobs: pendingJobs.results[0].n, alerts: alertStats.results[0], today: todayV.results[0],
      hours: hours.results, weekdays: dows.results, actions: actions.results, anonPrograms: anonPrograms.results,
    });
  }
  if (path === "hidden" && method === "GET") {
    return json({ hidden: (await db.prepare("SELECT job_id, ts, title FROM hidden_jobs ORDER BY ts DESC").all()).results });
  }
  if (path === "hidden" && method === "POST") {
    const b = await readBody(req, 4000);
    if (!b.jobId) return err("Mangler job");
    await db.prepare("INSERT OR REPLACE INTO hidden_jobs (job_id, ts, title, by_user) VALUES (?, ?, ?, ?)").bind(clip(b.jobId, 60), now(), clip(b.title, 200), me.id).run();
    return json({ ok: true });
  }
  const hm = path.match(/^hidden\/(.+)$/);
  if (hm && method === "DELETE") {
    await db.prepare("DELETE FROM hidden_jobs WHERE job_id=?").bind(decodeURIComponent(hm[1])).run();
    return json({ ok: true });
  }
  if (path === "activity" && method === "GET") {
    const url = new URL(req.url);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("day") || "") ? url.searchParams.get("day") : day();
    const rows = (await db.prepare(`SELECT e.ts, e.type, e.path, e.ref, e.visitor, e.user_id, e.job_id, e.label, e.meta, u.email
      FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.day=? AND e.visitor IS NOT NULL ORDER BY e.ts LIMIT 5000`).bind(d).all()).results;
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.visitor)) by.set(r.visitor, { visitor: r.visitor, first: r.ts, last: r.ts, email: null, ref: "", events: [] });
      const v = by.get(r.visitor);
      v.last = r.ts; if (r.email) v.email = r.email; if (r.ref && !v.ref) v.ref = r.ref;
      v.events.push({ ts: r.ts, type: r.type, path: r.path, label: r.label, meta: r.meta });
    }
    const visitors = [...by.values()].sort((a, b) => b.last - a.last).slice(0, 300);
    return json({ day: d, visitors });
  }
  if (path === "jobs" && method === "GET") {
    const rows = await db.prepare("SELECT * FROM posted_jobs ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, ts DESC LIMIT 300").all();
    return json({ jobs: rows.results.map((j) => ({ ...j, sec: parse(j.sec, []), studies: parse(j.studies, []) })), fams: FAMS, areas: AREAS });
  }
  const jm = path.match(/^jobs\/(\d+)$/);
  if (jm && method === "POST") {
    const b = await readBody(req, 12000);
    const id = Number(jm[1]);
    const j = await db.prepare("SELECT * FROM posted_jobs WHERE id=?").bind(id).first();
    if (!j) return err("Findes ikke", 404);
    const status = { approve: "approved", reject: "rejected", unpublish: "pending" }[b.action];
    if (!status) return err("Ukendt handling");
    const fam = FAMS[b.fam] ? b.fam : j.fam;
    const sec = Array.isArray(b.sec) ? b.sec.filter((f) => FAMS[f] && f !== fam).slice(0, 2) : parse(j.sec, []);
    const region = AREAS[b.region] ? b.region : j.region;
    const title = clip(b.title || j.title, 140), city = clip(b.city || j.city, 80);
    await db.prepare("UPDATE posted_jobs SET status=?, fam=?, sec=?, region=?, title=?, city=?, approved_at=? WHERE id=?")
      .bind(status, fam, JSON.stringify(sec), region, title, city, status === "approved" ? (j.approved_at || now()) : j.approved_at, id).run();
    return json({ ok: true });
  }
  if (jm && method === "DELETE") {
    await db.prepare("DELETE FROM posted_jobs WHERE id=?").bind(Number(jm[1])).run();
    return json({ ok: true });
  }
  if (path === "users" && method === "GET") {
    const url = new URL(req.url);
    const term = `%${(url.searchParams.get("q") || "").trim().toLowerCase()}%`;
    const rows = await db.prepare(`SELECT id, email, name, role, created_at, last_seen, program, school, cv_name IS NOT NULL AS has_cv,
      json_extract(profile,'$.heard') AS heard, json_extract(profile,'$.src') AS src
      FROM users WHERE lower(email) LIKE ? OR lower(COALESCE(name,'')) LIKE ? OR lower(COALESCE(program,'')) LIKE ?
      ORDER BY created_at DESC LIMIT 500`).bind(term, term, term).all();
    return json({ users: rows.results });
  }
  if (path === "users" && method === "POST") {
    const b = await readBody(req, 2000);
    const email = cleanEmail(b.email);
    if (!validEmail(email)) return err("Skriv en gyldig mail");
    if (await db.prepare("SELECT id FROM users WHERE email=?").bind(email).first()) return err("Brugeren findes allerede", 409);
    const password = tempPassword();
    const { hash, salt: s } = await hashPassword(password);
    const role = b.role === "admin" ? "admin" : "user";
    await db.prepare("INSERT INTO users (email, name, pw_hash, pw_salt, role, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .bind(email, clip(b.name, 80), hash, s, role, now()).run();
    return json({ email, password });
  }
  const m = path.match(/^users\/(\d+)(?:\/(password|role))?$/);
  if (m) {
    const id = Number(m[1]);
    const u = await db.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    if (!u) return err("Findes ikke", 404);
    if (!m[2] && method === "GET") {
      const ev = await db.prepare("SELECT ts, type, label FROM events WHERE user_id=? ORDER BY ts DESC LIMIT 40").bind(id).all();
      return json({ user: { ...publicUser(u), lastSeen: u.last_seen, lastLogin: u.last_login, program: u.program, school: u.school },
        profile: parse(u.profile), state: parse(u.state), cv: u.cv_name ? { name: u.cv_name, at: u.cv_at, text: u.cv_text, extract: parse(u.cv_extract) } : null,
        events: ev.results });
    }
    if (!m[2] && method === "DELETE") {
      if (id === me.id) return err("Du kan ikke slette dig selv her");
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
        db.prepare("UPDATE events SET user_id=NULL WHERE user_id=?").bind(id),
        db.prepare("DELETE FROM users WHERE id=?").bind(id),
      ]);
      return json({ ok: true });
    }
    if (m[2] === "password" && method === "POST") {
      const password = tempPassword();
      const { hash, salt: s } = await hashPassword(password);
      await db.batch([
        db.prepare("UPDATE users SET pw_hash=?, pw_salt=?, must_change_pw=1 WHERE id=?").bind(hash, s, id),
        db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
      ]);
      return json({ email: u.email, password });
    }
    if (m[2] === "role" && method === "POST") {
      const b = await readBody(req, 500);
      if (id === me.id) return err("Du kan ikke ændre din egen rolle");
      await db.prepare("UPDATE users SET role=? WHERE id=?").bind(b.role === "admin" ? "admin" : "user", id).run();
      return json({ ok: true });
    }
  }
  return err("Findes ikke", 404);
}

export async function handle(ctx) {
  const { request: req, env } = ctx;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method.toUpperCase();
  if (!env.DB) return err("Databasen er ikke sat op endnu", 503);
  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return err("Forkert oprindelse", 403);
  }
  try {
    await ensureSchema(env.DB);
    return await route(ctx, path, method);
  } catch (e) {
    if (e instanceof SyntaxError) return err("Ugyldig forespørgsel");
    if (e.status) return err(e.message, e.status);
    console.error(e);
    return err("Noget gik galt på serveren", 500);
  }
}
