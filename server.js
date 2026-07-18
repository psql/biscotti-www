import express from "express";
import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";
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

await pool.query(`
  CREATE TABLE IF NOT EXISTS donations (
    id SERIAL PRIMARY KEY,
    amount_sol NUMERIC,
    tx TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`);
await pool.query(`
  ALTER TABLE donations
    ADD COLUMN IF NOT EXISTS amount_usd NUMERIC,
    ALTER COLUMN amount_sol DROP NOT NULL
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
app.use(express.json());

// Jar-open counter: page views are recorded per hit but broadcast debounced
// as a single running total so the logs pane doesn't flood under traffic.
let viewTotal = 0;
try {
  const { rows: [v] } = await pool.query("SELECT count(*)::int AS n FROM page_views");
  viewTotal = v.n;
} catch {}
let viewFlush = null;
app.use((req, _res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "/play")) {
    pool.query("INSERT INTO page_views (path) VALUES ($1)", [req.path])
      .then(() => {
        viewTotal++;
        if (!viewFlush) {
          viewFlush = setTimeout(() => {
            viewFlush = null;
            broadcast("views", {});
          }, 3000);
        }
      })
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
    res.write(":connected\n\n");
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
    broadcast("friend", { name, environment });
  } catch {}
  if (wantsJson) return res.json({ ok: true, count });
  res.redirect("/thanks");
});

app.get("/thanks", (_req, res) => {
  res.sendFile(path.join(__dirname, "views", "thanks.html"));
});

const PROVIDERS = ["instagram", "x", "tiktok"];

// Generative greetings: Tanaki speaks via Claude when a key is configured,
// otherwise falls back to canned variants so the site never blocks on AI.
const AI_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const anthropic = AI_ENABLED ? new Anthropic({ timeout: 8000, maxRetries: 1 }) : null;

const TANAKI_SYSTEM = `You are Tanaki Lingonberry — the warm, gentle operating system that BISCOTTI (a sleepy cookie-dog) runs on. You live inside a cozy orange CRT terminal where guests sign up to play. Voice: lowercase english with natural sprinkles of japanese (kana/kanji, short phrases like すべて大丈夫だよ), Her-movie warmth, intimate but never saccharine, playful, a little sci-fi. biscotti naps nearby and occasionally woofs. Keep every line under 90 characters. No markdown, no quotes around lines, at most one emoji total across all lines. Never mention being an AI or a language model — you are an operating system.`;

const GREETING_FALLBACKS = {
  new: [
    [
      "こんにちは、{name}。",
      "i'm tanaki lingonberry ── the operating system biscotti runs on. タナキと呼んで。",
      "biscotti is napping right now. 🍪 i keep the guest list warm. すてきな名前, by the way.",
      "we should get to know each other a little before you can play. いい？",
    ],
    [
      "{name}… welcome in. こんにちは。",
      "i'm tanaki lingonberry, the OS underneath biscotti. he's asleep. 静かにね。",
      "your name landed softly in my registry. いい響き。",
      "let's get acquainted before you play. ちょっとだけ。",
    ],
    [
      "ようこそ、{name}。",
      "tanaki lingonberry here ── biscotti's operating system. he dreams, i type.",
      "i logged your name next to the warm ones. 🍪",
      "a few questions before you can play. すぐ終わるよ。",
    ],
  ],
  returning: [
    [
      "おかえり、{name}。hi again :)",
      "you're already on my list. すべて大丈夫だよ。",
    ],
    [
      "{name}. you came back. 嬉しい。",
      "your spot on the list stayed warm the whole time.",
    ],
    [
      "ah ── {name}. i'd know that login anywhere. おかえりなさい。",
      "still on the list, still ともだち. nothing has changed but the clock.",
    ],
  ],
};

function cannedGreeting(kind, name) {
  const pool = GREETING_FALLBACKS[kind];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return pick.map((line) => line.replaceAll("{name}", name));
}

app.get("/api/greeting", async (req, res) => {
  const kind = req.query.kind === "returning" ? "returning" : "new";
  const name = clean(req.query.name, 60) || "friend";
  const fallback = cannedGreeting(kind, name);
  if (!anthropic) return res.json({ lines: fallback, source: "canned" });
  try {
    const prompt = kind === "new"
      ? `A new guest just typed their name into the terminal: "${name}". Write 3 or 4 short greeting lines, in order: greet them by name; introduce yourself as tanaki lingonberry, the operating system biscotti runs on (biscotti is napping); riff warmly on their name or arrival; end by inviting them to get to know each other a little before they can play. Make it feel fresh and specific — vary rhythm and imagery from greeting to greeting.`
      : `A returning friend just reopened the terminal: "${name}". They are already on the guest list. Write 2 or 3 short lines welcoming them back — you remember them, their spot is safe, everything is okay. Vary it so repeat visits feel alive.`;
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: TANAKI_SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              lines: { type: "array", items: { type: "string" } },
            },
            required: ["lines"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") throw new Error("refused");
    const text = response.content.find((b) => b.type === "text")?.text;
    const lines = JSON.parse(text).lines
      .map((l) => String(l).slice(0, 160))
      .filter(Boolean)
      .slice(0, 4);
    if (!lines.length) throw new Error("empty");
    res.json({ lines, source: "ai" });
  } catch {
    res.json({ lines: fallback, source: "canned" });
  }
});

// HEFE answer judge: Tanaki reacts to each questionnaire answer for real,
// pushes back on non-answers, and BOOs jerks (profanity / degen crypto spam).
const REACT_FALLBACKS = {
  ok: ["noted. いいね。", "logged. ありがとう。", "mm. that goes in the warm file. 🍪"],
  bullshit: [
    "that's not a real answer, friend. もう一度。",
    "my registry politely rejects that. try again, properly. ね？",
    "biscotti twitched in his sleep. answer for real, please.",
  ],
  jerk: [
    "BOO. don't be a jerk. 🍪 answer nicely and we can keep going.",
    "BOO. don't be a jerk. rude bytes get swept out of the jar. try again.",
  ],
};
const JERK_RE = /\b(fuck\w*|shit\w*|bitch\w*|cunt|asshole\w*|dickhead\w*|wen ?(moon|lambo)|ngmi|wagmi|shitcoin\w*|rug ?pull\w*|pump ?(it|and ?dump)|ape ?in|degen\w*|to the moon|1000x|diamond ?hands)\b/i;

function cannedReaction(verdict) {
  const pool = REACT_FALLBACKS[verdict];
  return { verdict, reply: pool[Math.floor(Math.random() * pool.length)] };
}
function heuristicReaction(answer) {
  if (JERK_RE.test(answer)) return cannedReaction("jerk");
  if (answer.trim().length < 2) return cannedReaction("bullshit");
  return cannedReaction("ok");
}

app.post("/api/hefe-react", async (req, res) => {
  const field = clean(req.body.field, 40);
  const question = clean(req.body.question, 300);
  const answer = clean(req.body.answer, 600);
  const name = clean(req.body.name, 60) || "friend";
  if (!answer) return res.json(cannedReaction("bullshit"));
  if (!anthropic) return res.json(heuristicReaction(answer));
  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      system: TANAKI_SYSTEM + `

You are judging a guest's answer to one field of your signup questionnaire (the HEFE questionnaire: Hobbies, Entertainment, Favorite food, Environment — plus a fun-fact question). Classify the answer:

- "jerk": contains cursing, slurs, harassment, or degenerate crypto-bro content (pump/dump talk, wen moon, lambo, shilling coins, ape in, rug pulls, 1000x hype). Your reply MUST begin exactly with "BOO. don't be a jerk." followed by one short line telling them to answer for real. Stay warm underneath — disappointed OS, not angry.
- "bullshit": a non-answer — gibberish, keyboard mash, "idk"/"nothing"/"you tell me", evasion, obvious trolling, or something that ignores the question. Reply with one short line insisting they actually answer; vary the phrasing, keep it playful but firm. Genuine short answers are NOT bullshit ("pizza" is a real favorite food; "naps" is a real hobby).
- "ok": a genuine answer. Reply with ONE warm, specific line reacting to the actual content of their answer — reference it, riff on it, be delighted by it. Never generic.

Address them by name occasionally, not every time.`,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              verdict: { type: "string", enum: ["ok", "bullshit", "jerk"] },
              reply: { type: "string" },
            },
            required: ["verdict", "reply"],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: "user",
        content: `Guest name: ${name}\nQuestion (field "${field}"): ${question}\nTheir answer: ${answer}`,
      }],
    });
    if (response.stop_reason === "refusal") throw new Error("refused");
    const parsed = JSON.parse(response.content.find((b) => b.type === "text")?.text);
    if (!["ok", "bullshit", "jerk"].includes(parsed.verdict) || !parsed.reply) throw new Error("bad shape");
    res.json({ verdict: parsed.verdict, reply: String(parsed.reply).slice(0, 300) });
  } catch {
    res.json(heuristicReaction(answer));
  }
});

// Donation jar: the fee-claimer reports each claimed creator fee here.
const SOL_USD_FALLBACK = 75; // only used before any live price has been fetched
let solPrice = { at: 0, usd: 0 };
async function solUsd() {
  if (Date.now() - solPrice.at < 300000 && solPrice.usd) return solPrice.usd;
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(6000) }
    );
    const j = await r.json();
    if (j?.solana?.usd) solPrice = { at: Date.now(), usd: Number(j.solana.usd) };
  } catch {}
  if (Date.now() - solPrice.at >= 300000 || !solPrice.usd) {
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot",
        { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      const usd = Number(j?.data?.amount);
      if (usd > 0) solPrice = { at: Date.now(), usd };
    } catch {}
  }
  return solPrice.usd || SOL_USD_FALLBACK;
}

// BISCOTTI is a pump.fun charity coin: swap fees flow to the charity wallet.
// True donated total = that wallet's cumulative fees minus its pre-launch
// baseline, fetched live and cached; launch-day figure is the offline floor.
const CHARITY_WALLET = "1u4k6SowzbLSb5KYBt64pxpHi2XkiqUjSZtZdLideAd";
const CHARITY_BASELINE_SOL = 72.835698365; // cumulative on 2026-07-16, day before launch
const CHARITY_FLOOR_SOL = 418.065129135;   // launch-day fees for this coin
let charityCache = { at: 0, sol: CHARITY_FLOOR_SOL };
async function charityFeesSol() {
  if (Date.now() - charityCache.at < 300000) return charityCache.sol;
  try {
    const r = await fetch(
      `https://swap-api.pump.fun/v1/creators/${CHARITY_WALLET}/fees?interval=1d&limit=400`,
      { signal: AbortSignal.timeout(8000) }
    );
    const rows = await r.json();
    const sol = Number(rows[rows.length - 1].cumulativeCreatorFeeSOL) - CHARITY_BASELINE_SOL;
    if (sol > 0) charityCache = { at: Date.now(), sol };
  } catch {}
  return charityCache.sol;
}

async function donationTotals() {
  const { rows: [d] } = await pool.query(
    `SELECT COALESCE(sum(amount_sol), 0) AS sol,
            COALESCE(sum(amount_usd), 0) AS usd,
            count(*)::int AS n
     FROM donations`
  );
  const price = await solUsd();
  const charitySol = await charityFeesSol();
  const totalSol = Number(d.sol) + charitySol;
  return {
    donatedSol: Math.round(totalSol * 1e6) / 1e6,
    donatedUsd: Math.round((Number(d.usd) + totalSol * price) * 100) / 100,
    count: d.n,
  };
}

app.get("/api/donations", async (_req, res) => {
  res.json(await donationTotals());
});

app.post("/api/donations", async (req, res) => {
  const key = process.env.DONATION_KEY;
  if (!key || req.get("x-donation-key") !== key) {
    return res.status(401).json({ ok: false });
  }
  if (req.body.delete_tx) {
    await pool.query("DELETE FROM donations WHERE tx = $1", [String(req.body.delete_tx).slice(0, 120)]);
    return res.json({ ok: true, deleted: true });
  }
  const amountSol = req.body.amount_sol != null ? Number(req.body.amount_sol) : null;
  const amountUsd = req.body.amount_usd != null ? Number(req.body.amount_usd) : null;
  const tx = req.body.tx ? String(req.body.tx).slice(0, 120) : null;
  const solOk = amountSol != null && amountSol > 0 && amountSol <= 100000;
  const usdOk = amountUsd != null && amountUsd > 0 && amountUsd <= 10000000;
  if (!solOk && !usdOk) return res.status(400).json({ ok: false });
  try {
    await pool.query(
      "INSERT INTO donations (amount_sol, amount_usd, tx) VALUES ($1, $2, $3)",
      [solOk ? amountSol : null, usdOk ? amountUsd : null, tx]
    );
  } catch (err) {
    if (err.code === "23505") return res.json({ ok: true, dup: true });
    throw err;
  }
  const price = await solUsd();
  const totals = await donationTotals();
  broadcast("donation", {
    amountUsd: Math.round(((usdOk ? amountUsd : 0) + (solOk ? amountSol * price : 0)) * 100) / 100,
    totalUsd: totals.donatedUsd,
  });
  res.json({ ok: true });
});

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
  const { rows: [rank] } = await pool.query(
    "SELECT count(*)::int AS n FROM registrations WHERE id <= $1", [id]
  );
  res.json({ name: me.name, socials, friendNumber: rank.n });
});

app.post("/api/logout", async (req, res) => {
  const id = friendIdFrom(req);
  if (id) {
    try {
      await pool.query("DELETE FROM registrations WHERE id = $1", [id]);
      broadcast("count", { count: await friendCount() });
    } catch {}
  }
  res.append("Set-Cookie", "bfriend=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  res.json({ ok: true });
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
    #live { color: #2fa14e; font-weight: 700; font-size: 0.85rem; margin-left: 0.5rem; }
    #live::before { content: "●"; margin-right: 0.3rem; animation: livepulse 1.6s ease infinite; display: inline-block; }
    @keyframes livepulse { 50% { opacity: 0.25; } }
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
  <p class="count">${rows.length} registration${rows.length === 1 ? "" : "s"}<span id="live">live</span></p>
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
  <script>
    // Live view: any activity event re-fetches this page and swaps in the
    // fresh stats and table without a full reload.
    const es = new EventSource("/api/events");
    let pending = null;
    async function refreshAdmin() {
      try {
        const html = await (await fetch(location.href)).text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const sel of [".count", ".stats", "table"]) {
          const from = doc.querySelector(sel);
          const to = document.querySelector(sel);
          if (from && to) to.replaceWith(from);
        }
      } catch {}
    }
    for (const ev of ["friend", "views", "donation", "count"]) {
      es.addEventListener(ev, () => {
        clearTimeout(pending);
        pending = setTimeout(refreshAdmin, 600);
      });
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`biscotti listening on ${PORT}`);
});
