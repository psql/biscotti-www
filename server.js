import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "TanakiLingonberry";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS registrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    fun_fact TEXT NOT NULL,
    dunk_style TEXT NOT NULL,
    hype INTEGER NOT NULL DEFAULT 11,
    hobbies TEXT NOT NULL DEFAULT '',
    entertainment TEXT NOT NULL DEFAULT '',
    favorite_food TEXT NOT NULL DEFAULT '',
    environment TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await pool.query(`
  ALTER TABLE registrations
    ADD COLUMN IF NOT EXISTS hobbies TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS entertainment TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS favorite_food TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT ''
`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS page_views (
    id SERIAL PRIMARY KEY,
    path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await pool.query(`
  CREATE TABLE IF NOT EXISTS social_connections (
    id SERIAL PRIMARY KEY,
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    handle TEXT NOT NULL,
    connected_via TEXT NOT NULL DEFAULT 'manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (registration_id, provider)
  )
`);

const COOKIE_SECRET = process.env.COOKIE_SECRET || "biscotti-jar-secret";
const signId = (id) =>
  crypto.createHmac("sha256", COOKIE_SECRET).update(String(id)).digest("hex").slice(0, 32);
function setFriendCookie(res, id) {
  res.append(
    "Set-Cookie",
    `bfriend=${id}.${signId(id)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`
  );
}
function friendIdFrom(req) {
  const m = /(?:^|;\s*)bfriend=(\d+)\.([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m || signId(m[1]) !== m[2]) return null;
  return Number(m[1]);
}

const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}
async function friendCount() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM registrations");
  return rows[0].n;
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "/play")) {
    pool.query("INSERT INTO page_views (path) VALUES ($1)", [req.path])
      .then(() => broadcast("view", {}))
      .catch(() => {});
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/events", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  try {
    res.write(`event: count\ndata: ${JSON.stringify({ count: await friendCount() })}\n\n`);
  } catch {}
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(":ping\n\n"); } catch {}
  }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

const DUNK_STYLES = [
  "Full submarine (all the way in)",
  "Polite half-dip",
  "Speedy in-and-out",
  "No dunk. Dry crunch only",
  "I dunk it in something weird",
];

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

app.get("/play", (req, res) => {
  const qs = req.originalUrl.split("?")[1];
  res.redirect("/" + (qs ? "?" + qs : ""));
});

app.post("/api/signup", async (req, res) => {
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 254).toLowerCase();
  const funFact = clean(req.body.fun_fact, 1000);
  const dunkStyle = clean(req.body.dunk_style, 120);
  const hype = Math.min(11, Math.max(1, parseInt(req.body.hype, 10) || 11));
  const hobbies = clean(req.body.hobbies, 300);
  const entertainment = clean(req.body.entertainment, 300);
  const favoriteFood = clean(req.body.favorite_food, 300);
  const environment = clean(req.body.environment, 300);

  if (!name || !funFact || !hobbies || !entertainment || !favoriteFood ||
      !environment || !DUNK_STYLES.includes(dunkStyle) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if ((req.get("accept") || "").includes("application/json")) {
      return res.status(400).json({ ok: false });
    }
    return res.redirect("/?oops=1");
  }

  const wantsJson = (req.get("accept") || "").includes("application/json");
  try {
    const { rows: [reg] } = await pool.query(
      `INSERT INTO registrations
         (name, email, fun_fact, dunk_style, hype,
          hobbies, entertainment, favorite_food, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [name, email, funFact, dunkStyle, hype,
       hobbies, entertainment, favoriteFood, environment]
    );
    setFriendCookie(res, reg.id);
  } catch (err) {
    if (err.code === "23505") {
      const { rows: [existing] } = await pool.query(
        "SELECT id FROM registrations WHERE email = $1", [email]
      );
      if (existing) setFriendCookie(res, existing.id);
      if (wantsJson) return res.json({ ok: true, again: true });
      return res.redirect("/thanks?again=1");
    }
    throw err;
  }
  let count = null;
  try {
    count = await friendCount();
    broadcast("friend", { name, environment, count });
  } catch {}
  if (wantsJson) return res.json({ ok: true, count });
  res.redirect("/thanks");
});

app.get("/thanks", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "thanks.html"));
});

const PROVIDERS = ["instagram", "x", "tiktok"];

app.get("/api/me", async (req, res) => {
  const id = friendIdFrom(req);
  if (!id) return res.json({});
  const { rows: [me] } = await pool.query(
    "SELECT id, name FROM registrations WHERE id = $1", [id]
  );
  if (!me) return res.json({});
  const { rows: socials } = await pool.query(
    "SELECT provider, handle FROM social_connections WHERE registration_id = $1", [id]
  );
  res.json({ name: me.name, socials });
});

app.post("/api/socials", async (req, res) => {
  const id = friendIdFrom(req);
  if (!id) return res.status(401).json({ ok: false });
  const provider = String(req.body.provider || "");
  const handle = String(req.body.handle || "").trim().replace(/^@+/, "").slice(0, 64);
  if (!PROVIDERS.includes(provider) || !/^[\w.\-]{1,64}$/.test(handle)) {
    return res.status(400).json({ ok: false });
  }
  await pool.query(
    `INSERT INTO social_connections (registration_id, provider, handle, connected_via)
     VALUES ($1, $2, $3, 'manual')
     ON CONFLICT (registration_id, provider)
     DO UPDATE SET handle = EXCLUDED.handle, created_at = now()`,
    [id, provider, handle]
  );
  res.json({ ok: true });
});

// Placeholder for real OAuth: needs app credentials from Meta / X / TikTok
// developer portals (INSTAGRAM_CLIENT_ID etc.). Until configured, the chat
// collects handles via /api/socials instead.
app.get("/connect/:provider", (_req, res) => {
  res.status(501).send("OAuth isn't configured yet — tell BISCOTTI your @ in the terminal instead. ターミナルで教えてね。");
});

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

app.get("/admin", async (req, res) => {
  const auth = req.headers.authorization || "";
  const [scheme, encoded] = auth.split(" ");
  const password = scheme === "Basic" && encoded
    ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":")
    : null;

  if (password !== ADMIN_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="biscotti admin"');
    return res.status(401).send("Password required");
  }

  const { rows } = await pool.query(`
    SELECT r.*,
           COALESCE(json_agg(json_build_object('provider', s.provider, 'handle', s.handle))
                    FILTER (WHERE s.id IS NOT NULL), '[]') AS socials
    FROM registrations r
    LEFT JOIN social_connections s ON s.registration_id = r.id
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `);
  const { rows: [views] } = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
           count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week
    FROM page_views
  `);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BISCOTTI admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #fff7f0; padding: 2rem; }
    h1 { color: #ff7a00; margin-bottom: 0.25rem; }
    .count { color: #7a5230; margin-bottom: 1rem; }
    .stats { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .stat { background: #fff; border-radius: 12px; padding: 0.6rem 1.1rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .stat b { display: block; font-size: 1.4rem; color: #ff7a00; }
    .stat span { font-size: 0.8rem; color: #7a5230; }
    table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #ffe3c9; vertical-align: top; }
    th { background: #ff7a00; color: #fff; }
    tr:last-child td { border-bottom: none; }
    td.fact { max-width: 34rem; }
    .hype { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <h1>BISCOTTI waitlist</h1>
  <p class="count">${rows.length} registration${rows.length === 1 ? "" : "s"}</p>
  <div class="stats">
    <div class="stat"><b>${views.total}</b><span>page views (all time)</span></div>
    <div class="stat"><b>${views.today}</b><span>views today</span></div>
    <div class="stat"><b>${views.week}</b><span>views last 7 days</span></div>
    <div class="stat"><b>${views.total ? (rows.length / views.total * 100).toFixed(1) + "%" : "—"}</b><span>view → friend rate</span></div>
  </div>
  <table>
    <tr><th>#</th><th>Name</th><th>Email</th><th>Something fun</th><th>Hobbies</th><th>Entertainment</th><th>Fav food</th><th>Lives in</th><th>Dunk style</th><th>Hype</th><th>Socials</th><th>When</th></tr>
    ${rows.map((r) => `<tr>
      <td>${r.id}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.email)}</td>
      <td class="fact">${esc(r.fun_fact)}</td>
      <td>${esc(r.hobbies)}</td>
      <td>${esc(r.entertainment)}</td>
      <td>${esc(r.favorite_food)}</td>
      <td>${esc(r.environment)}</td>
      <td>${esc(r.dunk_style)}</td>
      <td class="hype">${r.hype}/11</td>
      <td>${r.socials.map((s) => `${esc(s.provider)}&nbsp;@${esc(s.handle)}`).join("<br>") || "—"}</td>
      <td>${new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16)}</td>
    </tr>`).join("")}
  </table>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`biscotti listening on ${PORT}`);
});
