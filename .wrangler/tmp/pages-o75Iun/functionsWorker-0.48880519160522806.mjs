var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../server/api.js
var FAMS = {
  supply: "Supply Chain",
  procurement: "Indk\xF8b",
  pmo: "Projektledelse / PMO",
  bizdev: "Forretningsudvikling",
  strategy: "Strategi og r\xE5dgivning",
  salesops: "Salgsoperationer",
  logistics: "Logistik",
  operations: "Drift og processer",
  bi: "BI og dataanalyse",
  finance: "\xD8konomi, regnskab og revision",
  marketing: "Marketing og kommunikation",
  product: "Produkt og UX",
  software: "Softwareudvikling",
  datasci: "Data science",
  hr: "HR og rekruttering",
  sustain: "B\xE6redygtighed og ESG",
  customer: "Kundesucces",
  legal: "Jura og compliance",
  research: "Forskning",
  engineering: "Ingeni\xF8rarbejde",
  health: "Sundhed og pleje",
  education: "P\xE6dagogik og undervisning",
  social: "Socialt arbejde",
  public: "Offentlig forvaltning"
};
var TRACK_TYPES = /* @__PURE__ */ new Set(["pageview", "onboarded", "apply_click", "save", "like", "dismiss", "cv_added", "program_changed"]);
var SESSION_DAYS = 30;
var COOKIE = "sm_session";
var json = /* @__PURE__ */ __name((data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } }), "json");
var err = /* @__PURE__ */ __name((msg, status = 400) => json({ error: msg }, status), "err");
var now = /* @__PURE__ */ __name(() => Date.now(), "now");
var day = /* @__PURE__ */ __name((t = now()) => new Date(t).toISOString().slice(0, 10), "day");
var enc = new TextEncoder();
var hex = /* @__PURE__ */ __name((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var b64 = /* @__PURE__ */ __name((buf) => btoa(String.fromCharCode(...new Uint8Array(buf))), "b64");
var randHex = /* @__PURE__ */ __name((n) => hex(crypto.getRandomValues(new Uint8Array(n))), "randHex");
var sha256 = /* @__PURE__ */ __name(async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s))), "sha256");
var cleanEmail = /* @__PURE__ */ __name((e) => String(e || "").trim().toLowerCase(), "cleanEmail");
var validEmail = /* @__PURE__ */ __name((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200, "validEmail");
var clip = /* @__PURE__ */ __name((s, n) => String(s ?? "").slice(0, n), "clip");
async function hashPassword(password, saltB64) {
  const salt2 = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt2, iterations: 1e5 }, key, 256);
  return { hash: b64(bits), salt: b64(salt2) };
}
__name(hashPassword, "hashPassword");
function safeEqual(a, b) {
  if (a.length !== b.length)
    return false;
  let d = 0;
  for (let i = 0; i < a.length; i++)
    d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
__name(safeEqual, "safeEqual");
function tempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => chars[b % chars.length]).join("");
}
__name(tempPassword, "tempPassword");
function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
__name(getCookie, "getCookie");
var sessionCookie = /* @__PURE__ */ __name((token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`, "sessionCookie");
var SCHEMA = [
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
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`
];
var ready = null;
function ensureSchema(db) {
  if (!ready)
    ready = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}
__name(ensureSchema, "ensureSchema");
async function salt(db) {
  const row = await db.prepare("SELECT v FROM kv WHERE k='salt'").first();
  if (row)
    return row.v;
  const v = randHex(16);
  await db.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('salt', ?)").bind(v).run();
  return (await db.prepare("SELECT v FROM kv WHERE k='salt'").first()).v;
}
__name(salt, "salt");
function adminEmails(env) {
  return new Set(String(env.ADMIN_EMAILS || "").split(",").map(cleanEmail).filter(Boolean));
}
__name(adminEmails, "adminEmails");
async function currentUser(ctx) {
  const token = getCookie(ctx.request, COOKIE);
  if (!token)
    return null;
  const db = ctx.env.DB;
  const row = await db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?"
  ).bind(await sha256(token), now()).first();
  if (!row)
    return null;
  if (adminEmails(ctx.env).has(row.email) && row.role !== "admin") {
    await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(row.id).run();
    row.role = "admin";
  }
  if (!row.last_seen || now() - row.last_seen > 10 * 60 * 1e3) {
    await db.prepare("UPDATE users SET last_seen=? WHERE id=?").bind(now(), row.id).run();
  }
  return row;
}
__name(currentUser, "currentUser");
async function startSession(db, userId) {
  const token = randHex(32);
  await db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), userId, now(), now() + SESSION_DAYS * 864e5).run();
  await db.prepare("UPDATE users SET last_login=?, last_seen=? WHERE id=?").bind(now(), now(), userId).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}
__name(startSession, "startSession");
function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name || "", role: u.role, mustChangePassword: !!u.must_change_pw, createdAt: u.created_at } : null;
}
__name(publicUser, "publicUser");
function parse(s, fallback = null) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
__name(parse, "parse");
async function aiAllowed(ctx) {
  if (!ctx.env.ANTHROPIC_API_KEY)
    return false;
  const limit = Number(ctx.env.AI_DAILY_LIMIT || 300);
  const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE day=? AND type='ai_call'").bind(day()).first();
  return (row?.n || 0) < limit;
}
__name(aiAllowed, "aiAllowed");
async function askAI(ctx, prompt, maxTokens = 900) {
  await ctx.env.DB.prepare("INSERT INTO events (ts, day, type) VALUES (?, ?, 'ai_call')").bind(now(), day()).run();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ctx.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ctx.env.AI_MODEL || "claude-haiku-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok)
    throw new Error(`AI ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m)
    throw new Error("AI svarede ikke med JSON");
  return JSON.parse(m[0]);
}
__name(askAI, "askAI");
var famList = /* @__PURE__ */ __name(() => Object.entries(FAMS).map(([k, v]) => `${k} = ${v}`).join("\n"), "famList");
function cleanWeights(w) {
  const out = {};
  for (const [k, v] of Object.entries(w || {})) {
    const n = Number(v);
    if (FAMS[k] && n >= 0.3)
      out[k] = Math.round(Math.min(1, n) * 100) / 100;
  }
  return out;
}
__name(cleanWeights, "cleanWeights");
async function programWeights(ctx, name, school) {
  const key = `${clip(name, 120).toLowerCase().trim()}|${clip(school, 60).toLowerCase().trim()}`;
  const db = ctx.env.DB;
  const hit = await db.prepare("SELECT weights FROM program_cache WHERE key=?").bind(key).first();
  if (hit)
    return parse(hit.weights);
  if (!await aiAllowed(ctx))
    return null;
  const out = await askAI(
    ctx,
    `Du hj\xE6lper en dansk side, der anbefaler studiejob ud fra uddannelse.
Uddannelse: "${clip(name, 120)}"${school ? ` p\xE5 ${clip(school, 60)}` : ""}.
Giv for hvert relevant jobfelt et tal fra 0 til 1 for, hvor godt en studerende p\xE5 uddannelsen passer til studiejob i feltet. 1 = kernefelt, 0.6 = god pasform, 0.4 = muligt. Udelad felter under 0.3. Brug kun disse n\xF8gler:
${famList()}
Svar kun med JSON: {"weights": {"n\xF8gle": tal}}`,
    400
  );
  const w = cleanWeights(out.weights);
  if (Object.keys(w).length)
    await db.prepare("INSERT OR REPLACE INTO program_cache (key, weights, ts) VALUES (?, ?, ?)").bind(key, JSON.stringify(w), now()).run();
  return Object.keys(w).length ? w : null;
}
__name(programWeights, "programWeights");
async function cvExtract(ctx, text, programName) {
  if (!await aiAllowed(ctx))
    return null;
  const out = await askAI(
    ctx,
    `L\xE6s dette CV fra en dansk studerende${programName ? ` (l\xE6ser ${clip(programName, 100)})` : ""}. Find det, der hj\xE6lper med at matche vedkommende med studiejob.
Jobfelter (brug kun disse n\xF8gler):
${famList()}

Svar kun med JSON:
{"skills": ["konkrete v\xE6rkt\xF8jer og metoder, fx Excel, SAP, Python, kundeservice"], "experience": [{"title": "stilling", "org": "arbejdsplads", "years": "fx 2023-2025", "fams": ["n\xF8gle"]}], "interests": ["n\xF8gle"], "summary": "\xE9n s\xE6tning p\xE5 dansk om profilen"}
H\xF8jst 12 skills og 8 erfaringer. Opfind intet.

CV:
${clip(text, 12e3)}`,
    1200
  );
  return {
    skills: (out.skills || []).map((s) => clip(s, 40)).filter(Boolean).slice(0, 12),
    experience: (out.experience || []).slice(0, 8).map((e) => ({
      title: clip(e.title, 80),
      org: clip(e.org, 80),
      years: clip(e.years, 30),
      fams: (e.fams || []).filter((f) => FAMS[f])
    })).filter((e) => e.title),
    interests: (out.interests || []).filter((f) => FAMS[f]).slice(0, 5),
    summary: clip(out.summary, 300),
    by: "ai"
  };
}
__name(cvExtract, "cvExtract");
async function readBody(req, max = 3e5) {
  const text = await req.text();
  if (text.length > max)
    throw Object.assign(new Error("For stor"), { status: 413 });
  return text ? JSON.parse(text) : {};
}
__name(readBody, "readBody");
async function route(ctx, path, method) {
  const { request: req, env } = ctx;
  const db = env.DB;
  if (path === "health")
    return json({ ok: true, ai: !!env.ANTHROPIC_API_KEY });
  if (path === "track" && method === "POST") {
    const ua = req.headers.get("User-Agent") || "";
    if (/bot|crawl|spider|preview|monitor/i.test(ua))
      return new Response(null, { status: 204 });
    const b = await readBody(req, 4e3);
    const type = String(b.type || "");
    if (!TRACK_TYPES.has(type))
      return err("Ukendt type");
    const ip = req.headers.get("CF-Connecting-IP") || "";
    const visitor = (await sha256(`${await salt(db)}|${day()}|${ip}|${ua}`)).slice(0, 16);
    let ref = "";
    try {
      const h = new URL(String(b.ref || "")).hostname;
      if (h && h !== new URL(req.url).hostname)
        ref = h;
    } catch {
    }
    const user2 = await currentUser(ctx);
    await db.prepare("INSERT INTO events (ts, day, type, path, ref, visitor, user_id, job_id, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(now(), day(), type, clip(b.path, 100), ref, visitor, user2?.id ?? null, clip(b.jobId, 40) || null, clip(b.label, 160) || null).run();
    return new Response(null, { status: 204 });
  }
  if (path === "waitlist" && method === "POST") {
    const b = await readBody(req, 2e3);
    const email = cleanEmail(b.email);
    if (!validEmail(email) || !String(b.company || "").trim())
      return err("Udfyld virksomhed og mail");
    await db.prepare("INSERT INTO companies (ts, company, email) VALUES (?, ?, ?)").bind(now(), clip(b.company, 120), email).run();
    return json({ ok: true });
  }
  if (path === "auth/signup" && method === "POST") {
    const b = await readBody(req, 3e5);
    const email = cleanEmail(b.email), password = String(b.password || "");
    if (!validEmail(email))
      return err("Skriv en gyldig mail");
    if (password.length < 8)
      return err("Adgangskoden skal v\xE6re mindst 8 tegn");
    if (!b.consent)
      return err("Du skal acceptere privatlivspolitikken");
    if (await db.prepare("SELECT id FROM users WHERE email=?").bind(email).first())
      return err("Der findes allerede en bruger med den mail. Log ind i stedet.", 409);
    const { hash, salt: s } = await hashPassword(password);
    const role = adminEmails(env).has(email) ? "admin" : "user";
    const p = b.profile || {};
    const r = await db.prepare(`INSERT INTO users (email, name, pw_hash, pw_salt, role, created_at, consent_at, program, school, profile, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      email,
      clip(b.name, 80),
      hash,
      s,
      role,
      now(),
      now(),
      clip(p.programName, 120) || null,
      clip(p.uni, 60) || null,
      b.profile ? JSON.stringify(b.profile) : null,
      b.state ? JSON.stringify(b.state) : null
    ).run();
    const id = r.meta.last_row_id;
    await db.prepare("INSERT INTO events (ts, day, type, user_id) VALUES (?, ?, 'signup', ?)").bind(now(), day(), id).run();
    const cookie = await startSession(db, id);
    return json({ user: publicUser({ id, email, name: b.name, role, created_at: now() }) }, 200, { "Set-Cookie": cookie });
  }
  if (path === "auth/login" && method === "POST") {
    const b = await readBody(req, 2e3);
    const email = cleanEmail(b.email);
    const fails = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='login_fail' AND label=? AND ts>?").bind(email, now() - 15 * 6e4).first();
    if ((fails?.n || 0) >= 10)
      return err("For mange fors\xF8g. Pr\xF8v igen om et kvarter.", 429);
    const u = await db.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    const ok = u && u.pw_hash && safeEqual((await hashPassword(String(b.password || ""), u.pw_salt)).hash, u.pw_hash);
    if (!ok) {
      await db.prepare("INSERT INTO events (ts, day, type, label) VALUES (?, ?, 'login_fail', ?)").bind(now(), day(), email).run();
      return err("Forkert mail eller adgangskode", 401);
    }
    if (adminEmails(env).has(email) && u.role !== "admin") {
      await db.prepare("UPDATE users SET role='admin' WHERE id=?").bind(u.id).run();
      u.role = "admin";
    }
    const cookie = await startSession(db, u.id);
    return json(
      { user: publicUser(u), profile: parse(u.profile), state: parse(u.state), cv: u.cv_name ? { name: u.cv_name, at: u.cv_at, extract: parse(u.cv_extract) } : null },
      200,
      { "Set-Cookie": cookie }
    );
  }
  if (path === "auth/logout" && method === "POST") {
    const token = getCookie(req, COOKIE);
    if (token)
      await db.prepare("DELETE FROM sessions WHERE token=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  const user = await currentUser(ctx);
  if (path === "me" && method === "GET") {
    if (!user)
      return json({ user: null, ai: !!env.ANTHROPIC_API_KEY });
    return json({
      user: publicUser(user),
      profile: parse(user.profile),
      state: parse(user.state),
      ai: !!env.ANTHROPIC_API_KEY,
      cv: user.cv_name ? { name: user.cv_name, at: user.cv_at, extract: parse(user.cv_extract) } : null
    });
  }
  if (path === "agent/program" && method === "POST") {
    const b = await readBody(req, 2e3);
    if (!String(b.name || "").trim())
      return err("Mangler uddannelse");
    try {
      return json({ weights: await programWeights(ctx, b.name, b.school) });
    } catch {
      return json({ weights: null });
    }
  }
  if (!user)
    return err("Du er ikke logget ind", 401);
  if (path === "me/state" && method === "PUT") {
    const b = await readBody(req, 3e5);
    const p = b.profile || {};
    await db.prepare("UPDATE users SET profile=?, state=?, program=?, school=?, name=COALESCE(NULLIF(?, ''), name) WHERE id=?").bind(JSON.stringify(b.profile || null), JSON.stringify(b.state || null), clip(p.programName, 120) || null, clip(p.uni, 60) || null, clip(b.name, 80), user.id).run();
    return json({ ok: true });
  }
  if (path === "me/password" && method === "POST") {
    const b = await readBody(req, 2e3);
    const okOld = user.must_change_pw || safeEqual((await hashPassword(String(b.current || ""), user.pw_salt)).hash, user.pw_hash);
    if (!okOld)
      return err("Den nuv\xE6rende adgangskode er forkert", 401);
    if (String(b.password || "").length < 8)
      return err("Adgangskoden skal v\xE6re mindst 8 tegn");
    const { hash, salt: s } = await hashPassword(String(b.password));
    await db.prepare("UPDATE users SET pw_hash=?, pw_salt=?, must_change_pw=0 WHERE id=?").bind(hash, s, user.id).run();
    return json({ ok: true });
  }
  if (path === "me/cv" && method === "POST") {
    const b = await readBody(req, 2e5);
    const text = clip(b.text, 6e4);
    if (text.trim().length < 40)
      return err("Vi kunne ikke l\xE6se tekst i CV'et");
    let extract = null;
    try {
      extract = await cvExtract(ctx, text, parse(user.profile)?.programName);
    } catch {
      extract = null;
    }
    await db.prepare("UPDATE users SET cv_name=?, cv_text=?, cv_at=?, cv_extract=? WHERE id=?").bind(clip(b.name, 120), text, now(), extract ? JSON.stringify(extract) : null, user.id).run();
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
      db.prepare("DELETE FROM users WHERE id=?").bind(user.id)
    ]);
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (path.startsWith("admin/")) {
    if (user.role !== "admin")
      return err("Kun for administratorer", 403);
    return admin(ctx, path.slice(6), method, user);
  }
  return err("Findes ikke", 404);
}
__name(route, "route");
async function admin(ctx, path, method, me) {
  const db = ctx.env.DB;
  const req = ctx.request;
  if (path === "stats" && method === "GET") {
    const since = day(now() - 29 * 864e5);
    const q = /* @__PURE__ */ __name((sql, ...a) => db.prepare(sql).bind(...a), "q");
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
      q(`SELECT ts, type, label, path FROM events WHERE type IN ('signup','apply_click','onboarded','cv_added') ORDER BY ts DESC LIMIT 25`)
    ]);
    return json({
      daily: daily.results,
      signups: signups.results,
      totals: totals.results[0],
      topJobs: topJobs.results,
      referrers: refs.results,
      paths: paths.results,
      programs: programs.results,
      funnel: funnel.results,
      companies: companies.results,
      recent: recent.results,
      ai: !!ctx.env.ANTHROPIC_API_KEY
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
    const b = await readBody(req, 2e3);
    const email = cleanEmail(b.email);
    if (!validEmail(email))
      return err("Skriv en gyldig mail");
    if (await db.prepare("SELECT id FROM users WHERE email=?").bind(email).first())
      return err("Brugeren findes allerede", 409);
    const password = tempPassword();
    const { hash, salt: s } = await hashPassword(password);
    const role = b.role === "admin" ? "admin" : "user";
    await db.prepare("INSERT INTO users (email, name, pw_hash, pw_salt, role, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)").bind(email, clip(b.name, 80), hash, s, role, now()).run();
    return json({ email, password });
  }
  const m = path.match(/^users\/(\d+)(?:\/(password|role))?$/);
  if (m) {
    const id = Number(m[1]);
    const u = await db.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    if (!u)
      return err("Findes ikke", 404);
    if (!m[2] && method === "GET") {
      const ev = await db.prepare("SELECT ts, type, label FROM events WHERE user_id=? ORDER BY ts DESC LIMIT 40").bind(id).all();
      return json({
        user: { ...publicUser(u), lastSeen: u.last_seen, lastLogin: u.last_login, program: u.program, school: u.school },
        profile: parse(u.profile),
        state: parse(u.state),
        cv: u.cv_name ? { name: u.cv_name, at: u.cv_at, text: u.cv_text, extract: parse(u.cv_extract) } : null,
        events: ev.results
      });
    }
    if (!m[2] && method === "DELETE") {
      if (id === me.id)
        return err("Du kan ikke slette dig selv her");
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id),
        db.prepare("UPDATE events SET user_id=NULL WHERE user_id=?").bind(id),
        db.prepare("DELETE FROM users WHERE id=?").bind(id)
      ]);
      return json({ ok: true });
    }
    if (m[2] === "password" && method === "POST") {
      const password = tempPassword();
      const { hash, salt: s } = await hashPassword(password);
      await db.batch([
        db.prepare("UPDATE users SET pw_hash=?, pw_salt=?, must_change_pw=1 WHERE id=?").bind(hash, s, id),
        db.prepare("DELETE FROM sessions WHERE user_id=?").bind(id)
      ]);
      return json({ email: u.email, password });
    }
    if (m[2] === "role" && method === "POST") {
      const b = await readBody(req, 500);
      if (id === me.id)
        return err("Du kan ikke \xE6ndre din egen rolle");
      await db.prepare("UPDATE users SET role=? WHERE id=?").bind(b.role === "admin" ? "admin" : "user", id).run();
      return json({ ok: true });
    }
  }
  return err("Findes ikke", 404);
}
__name(admin, "admin");
async function handle(ctx) {
  const { request: req, env } = ctx;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method.toUpperCase();
  if (!env.DB)
    return err("Databasen er ikke sat op endnu", 503);
  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host)
      return err("Forkert oprindelse", 403);
  }
  try {
    await ensureSchema(env.DB);
    return await route(ctx, path, method);
  } catch (e) {
    if (e instanceof SyntaxError)
      return err("Ugyldig foresp\xF8rgsel");
    if (e.status)
      return err(e.message, e.status);
    console.error(e);
    return err("Noget gik galt p\xE5 serveren", 500);
  }
}
__name(handle, "handle");

// api/[[path]].js
var onRequest = /* @__PURE__ */ __name((ctx) => handle(ctx), "onRequest");

// ../.wrangler/tmp/pages-o75Iun/functionsRoutes-0.353272622449017.mjs
var routes = [
  {
    routePath: "/api/:path*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../../../tmp/claude-0/-home-claude/ba30a219-e2b9-593b-8536-bf82dd940418/scratchpad/wr/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse2(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse2, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse2(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route2 = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route2 += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route2 += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route2 += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route2 += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route2 += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route2 += "".concat(delimiterRe, "?");
    route2 += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route2 += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route2 += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route2, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../tmp/claude-0/-home-claude/ba30a219-e2b9-593b-8536-bf82dd940418/scratchpad/wr/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route2 of [...routes].reverse()) {
    if (route2.method && route2.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route2.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route2.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route2.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route2 of routes) {
    if (route2.method && route2.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route2.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route2.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route2.modules.length) {
      for (const handler of route2.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: () => {
            isFailOpen = true;
          }
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../../../tmp/claude-0/-home-claude/ba30a219-e2b9-593b-8536-bf82dd940418/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../tmp/claude-0/-home-claude/ba30a219-e2b9-593b-8536-bf82dd940418/scratchpad/wr/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-uEA5jP/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../../../tmp/claude-0/-home-claude/ba30a219-e2b9-593b-8536-bf82dd940418/scratchpad/wr/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-uEA5jP/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.48880519160522806.mjs.map
