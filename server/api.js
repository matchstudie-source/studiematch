/* Studiematchs backend. Kører som Cloudflare Pages Functions med en D1-database (binding: DB).
 *
 * Miljøvariabler i Cloudflare (Settings → Variables and secrets):
 *   ADMIN_EMAILS       kommaseparerede mails, der automatisk bliver admin (fx matchstudie@gmail.com)
 *   ANTHROPIC_API_KEY  valgfri: slår AI-agenten til (CV-læsning og ukendte uddannelser)
 *   AI_MODEL           valgfri: modelnavn, standard claude-haiku-5-5
 *   AI_DAILY_LIMIT     valgfri: højst så mange AI-kald i døgnet, standard 300
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
const TRACK_TYPES = new Set(["pageview", "onboarded", "apply_click", "save", "like", "dismiss", "cv_added", "program_changed"]);
const SESSION_DAYS = 30;
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
const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

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
];
let ready = null;
function ensureSchema(db) {
  if (!ready) ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
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
  if (adminEmails(ctx.env).has(row.email) && row.role !== "admin") {
    await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(row.id).run();
    row.role = "admin";
  }
  if (!row.last_seen || now() - row.last_seen > 10 * 60 * 1000) {
    await db.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(now(), row.id).run();
  }
  return row;
}
async function startSession(db, userId) {
  const token = randHex(32);
  await db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now(), now() + SESSION_DAYS * 864e5).run();
  await db.prepare("UPDATE users SET last_login=?, last_seen=? WHERE id=?").bind(now(), now(), userId).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
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
    await db.prepare("INSERT INTO events (ts, day, type, path, ref, visitor, user_id, job_id, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now(), day(), type, clip(b.path, 100), ref, visitor, user?.id ?? null, clip(b.jobId, 40) || null, clip(b.label, 160) || null).run();
    return new Response(null, { status: 204 });
  }

  /* ----- virksomheders venteliste ----- */
  if (path === "waitlist" && method === "POST") {
    const b = await readBody(req, 2000);
    const email = cleanEmail(b.email);
    if (!validEmail(email) || !String(b.company || "").trim()) return err("Udfyld virksomhed og mail");
    await db.prepare("INSERT INTO companies (ts, company, email) VALUES (?, ?, ?)").bind(now(), clip(b.company, 120), email).run();
    return json({ ok: true });
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
    const role = adminEmails(env).has(email) ? "admin" : "user";
    const p = b.profile || {};
    const r = await db.prepare(`INSERT INTO users (email, name, pw_hash, pw_salt, role, created_at, consent_at, program, school, profile, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(email, clip(b.name, 80), hash, s, role, now(), now(),
      clip(p.programName, 120) || null, clip(p.uni, 60) || null, b.profile ? JSON.stringify(b.profile) : null, b.state ? JSON.stringify(b.state) : null).run();
    const id = r.meta.last_row_id;
    await db.prepare("INSERT INTO events (ts, day, type, user_id) VALUES (?, ?, 'signup', ?)").bind(now(), day(), id).run();
    const cookie = await startSession(db, id);
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
    if (adminEmails(env).has(email) && u.role !== "admin") { await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(u.id).run(); u.role = "admin"; }
    const cookie = await startSession(db, u.id);
    return json({ user: publicUser(u), profile: parse(u.profile), state: parse(u.state), cv: u.cv_name ? { name: u.cv_name, at: u.cv_at, extract: parse(u.cv_extract) } : null },
      200, { "Set-Cookie": cookie });
  }
  if (path === "auth/logout" && method === "POST") {
    const token = getCookie(req, COOKIE);
    if (token) await db.prepare("DELETE FROM sessions WHERE token=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
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
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  /* ----- admin ----- */
  if (path.startsWith("admin/")) {
    if (user.role !== "admin") return err("Kun for administratorer", 403);
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
    const [daily, signups, totals, topJobs, refs, paths, programs, funnel, companies, recent] = await db.batch([
      q(`SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS views FROM events WHERE type='pageview' AND day>=? GROUP BY day ORDER BY day`, since),
      q(`SELECT day, COUNT(*) AS n FROM events WHERE type='signup' AND day>=? GROUP BY day`, since),
      q(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM users WHERE cv_name IS NOT NULL) AS with_cv,
           (SELECT COUNT(*) FROM users WHERE last_seen > ?) AS active7`, now() - 7 * 864e5),
      q(`SELECT job_id, label, COUNT(*) AS n FROM events WHERE type='apply_click' AND day>=? GROUP BY job_id ORDER BY n DESC LIMIT 15`, since),
      q(`SELECT ref, COUNT(DISTINCT visitor) AS n FROM events WHERE type='pageview' AND ref<>'' AND day>=? GROUP BY ref ORDER BY n DESC LIMIT 10`, since),
      q(`SELECT path, COUNT(*) AS n FROM events WHERE type='pageview' AND day>=? GROUP BY path ORDER BY n DESC LIMIT 10`, since),
      q(`SELECT COALESCE(program,'(ikke valgt)') AS program, COALESCE(school,'') AS school, COUNT(*) AS n FROM users GROUP BY program, school ORDER BY n DESC LIMIT 15`),
      q(`SELECT type, COUNT(*) AS n, COUNT(DISTINCT visitor) AS people FROM events WHERE day>=? AND type IN ('pageview','onboarded','apply_click','save','like','dismiss','cv_added') GROUP BY type`, since),
      q(`SELECT ts, company, email FROM companies ORDER BY ts DESC LIMIT 50`),
      q(`SELECT ts, type, label, path FROM events WHERE type IN ('signup','apply_click','onboarded','cv_added') ORDER BY ts DESC LIMIT 25`),
    ]);
    return json({
      daily: daily.results, signups: signups.results, totals: totals.results[0], topJobs: topJobs.results,
      referrers: refs.results, paths: paths.results, programs: programs.results, funnel: funnel.results,
      companies: companies.results, recent: recent.results, ai: !!ctx.env.ANTHROPIC_API_KEY,
    });
  }
  if (path === "users" && method === "GET") {
    const url = new URL(req.url);
    const term = `%${(url.searchParams.get("q") || "").trim().toLowerCase()}%`;
    const rows = await db.prepare(`SELECT id, email, name, role, created_at, last_seen, program, school, cv_name IS NOT NULL AS has_cv
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
