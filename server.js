import express from "express";
import pg from "pg";
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const DUNK_STYLES = [
  "Full submarine (all the way in)",
  "Polite half-dip",
  "Speedy in-and-out",
  "No dunk. Dry crunch only",
  "I dunk it in something weird",
];

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

app.get("/play", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "play.html"));
});

app.post("/api/signup", async (req, res) => {
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 254).toLowerCase();
  const funFact = clean(req.body.fun_fact, 1000);
  const dunkStyle = clean(req.body.dunk_style, 120);
  const hype = Math.min(11, Math.max(1, parseInt(req.body.hype, 10) || 11));

  if (!name || !funFact || !DUNK_STYLES.includes(dunkStyle) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect("/play?oops=1");
  }

  try {
    await pool.query(
      `INSERT INTO registrations (name, email, fun_fact, dunk_style, hype)
       VALUES ($1, $2, $3, $4, $5)`,
      [name, email, funFact, dunkStyle, hype]
    );
  } catch (err) {
    if (err.code === "23505") return res.redirect("/thanks?again=1");
    throw err;
  }
  res.redirect("/thanks");
});

app.get("/thanks", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "thanks.html"));
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

  const { rows } = await pool.query(
    "SELECT * FROM registrations ORDER BY created_at DESC"
  );

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
    .count { color: #7a5230; margin-bottom: 1.5rem; }
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
  <table>
    <tr><th>#</th><th>Name</th><th>Email</th><th>Something fun</th><th>Dunk style</th><th>Hype</th><th>When</th></tr>
    ${rows.map((r) => `<tr>
      <td>${r.id}</td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.email)}</td>
      <td class="fact">${esc(r.fun_fact)}</td>
      <td>${esc(r.dunk_style)}</td>
      <td class="hype">${r.hype}/11</td>
      <td>${new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16)}</td>
    </tr>`).join("")}
  </table>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`biscotti listening on ${PORT}`);
});
