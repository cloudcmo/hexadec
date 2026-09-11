/* Hexadec worker — static assets, newsletter signup, and play stats.
 *
 * There is no generation here and no API key: the day is a lookup in
 * public/days.js, built offline by tools/build-days.mjs. Nothing on this
 * Worker costs money per request, and nothing can silently run dry except the
 * day table itself — which is why /api/health reports how far ahead it goes,
 * and the cron shouts if that gets short.
 *
 * ⚠️ Learned across this family the hard way: an alarm wired to the depth of
 * the tank tells you nothing about whether the tap is running. Here the tank
 * IS the whole system, so depth is the right thing to watch — but it drains at
 * exactly one day per day and only a human with a laptop can refill it, so the
 * warning has to arrive with weeks in hand, not days.
 */

const LAUNCH = "2026-09-11";
const LOW_WATER_DAYS = 45;     // shout when the table has less than six weeks left
const MAX_SCORE = 9999;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/subscribe") return await handleSubscribe(request, env);
      if (path === "/api/played") return await servePlayed(request, env);
      if (path === "/api/stats") return await serveStats(url, env, request);
      if (path === "/api/day") return await serveDay(url, env);
      if (path === "/api/health") return await serveHealth(env);
      if (path === "/robots.txt") return serveRobots();
    } catch (err) {
      console.error(`${path} failed:`, err);
      return json({ error: "Internal error" }, 500);
    }
    return env.ASSETS.fetch(request);
  },

  /* Daily. The only thing that can go wrong with Hexadec is running out of
     days, and that is a slow, visible, entirely preventable failure — as long
     as somebody is told in time. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkRunway(env));
  },
};

/* ---------- how many days are left in the table ---------- */
/* days.js is a published asset, so the Worker can read its own front end
   rather than keeping a second copy of the truth. */
async function runway(env) {
  try {
    const res = await env.ASSETS.fetch(new Request("https://hexadec.invalid/days.js"));
    if (!res.ok) return null;
    const text = await res.text();
    const from = text.match(/export const DAYS_FROM = "(\d{4}-\d{2}-\d{2})"/);
    const count = text.match(/export const MAXES = \[([^\]]*)\]/);
    if (!from || !count) return null;
    const n = count[1].split(",").length;
    const start = Date.parse(from[1] + "T12:00:00Z");
    const lastDay = new Date(start + (n - 1) * 86400000).toISOString().slice(0, 10);
    const today = todayISO();
    const left = Math.round((Date.parse(lastDay + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86400000);
    return { from: from[1], days: n, through: lastDay, left };
  } catch (e) {
    console.error("runway check failed:", e);
    return null;
  }
}

async function checkRunway(env) {
  const r = await runway(env);
  if (!r) { console.error("Could not read days.js to check the runway"); return; }
  if (r.left > LOW_WATER_DAYS) return;
  console.error(`Hexadec day table runs out in ${r.left} days (through ${r.through})`);
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Hexadec <hello@pubquizdaily.com>",
      to: [env.ALERT_EMAIL],
      subject: `Hexadec runs out of puzzles in ${r.left} days`,
      text: `The Hexadec day table ends on ${r.through}, which is ${r.left} days away.

Refill it from the Mac:

    cd ~/code/Hexa
    npm run days 400 ${r.through}
    npx wrangler deploy
    git add -A && git commit -m "Another 400 days" && git push

It takes about five minutes to generate. Nothing else needs doing.`,
    }),
  }).catch((e) => console.error("runway alert send failed:", e));
}

async function serveHealth(env) {
  const r = await runway(env);
  return json({ ok: true, today: todayISO(), db: !!env.DB, table: r });
}

/* ---------- play recording (aggregate only, no accounts) ---------- */
async function servePlayed(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.DB) return json({ ok: true, recorded: false });
  let body = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const today = todayISO();
  const date = typeof body.date === "string" ? body.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Bad date" }, 400);
  if (date > today || date < LAUNCH) return json({ error: "Bad date" }, 400);

  const complete = body.complete ? 1 : 0;
  const score = clamp(body.score, 0, MAX_SCORE);
  const words = clamp(body.words, 0, MAX_SCORE);
  const seconds = clamp(body.seconds, 0, 86400);
  const pct = clamp(body.pct, 0, 100);
  const helped = body.helped ? 1 : 0;

  await env.DB.prepare(
    `INSERT INTO plays (date, total, completions, score_sum, words_sum, seconds_sum, pct_sum, helped)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       total = total + 1,
       completions = completions + excluded.completions,
       score_sum = score_sum + excluded.score_sum,
       words_sum = words_sum + excluded.words_sum,
       seconds_sum = seconds_sum + excluded.seconds_sum,
       pct_sum = pct_sum + excluded.pct_sum,
       helped = helped + excluded.helped`
  ).bind(date, complete, score, words, seconds, pct, helped).run();
  return json({ ok: true, recorded: true });
}

async function serveStats(url, env, request) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "Unauthorized" }, 401);
  if (!env.DB) return json({ error: "No database bound" }, 503);
  const date = url.searchParams.get("date") || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Bad date" }, 400);
  const day = await env.DB.prepare(
    "SELECT total, completions, score_sum, words_sum, seconds_sum, pct_sum, helped FROM plays WHERE date = ?"
  ).bind(date).first();
  const all = await env.DB.prepare(
    "SELECT COALESCE(SUM(total),0) AS players, COUNT(*) AS days FROM plays"
  ).first();
  const players = day?.total || 0;
  const avg = (k) => (players ? Math.round((day[k] || 0) / players) : null);
  return json({
    date, players,
    completions: day?.completions || 0,
    completionRate: players ? Math.round((day?.completions || 0) / players * 100) : null,
    avgScore: avg("score_sum"),
    avgWords: avg("words_sum"),
    avgSeconds: avg("seconds_sum"),
    avgPctOfBest: avg("pct_sum"),
    nudged: day?.helped || 0,
    allTime: { players: all?.players || 0, days: all?.days || 0 },
  });
}

/* ---------- the day's shape, for the end card (public, aggregates only) ---------- */
async function serveDay(url, env) {
  const date = url.searchParams.get("date") || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > todayISO() || date < LAUNCH)
    return json({ error: "Bad date" }, 400);
  if (!env.DB) return json({ players: 0 });
  const row = await env.DB.prepare(
    "SELECT total, completions, score_sum, pct_sum FROM plays WHERE date = ?"
  ).bind(date).first();
  const players = row?.total || 0;
  return new Response(JSON.stringify({
    date, players,
    avgScore: players ? Math.round(row.score_sum / players) : null,
    avgPctOfBest: players ? Math.round(row.pct_sum / players) : null,
    completionRate: players ? Math.round((row.completions / players) * 100) : null,
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } });
}

/* ---------- newsletter (same Resend flow as the other Guff games) ---------- */
const SEND_WELCOME = true;

async function handleSubscribe(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.RESEND_API_KEY || !env.RESEND_SEGMENT_ID) {
    console.error("Missing RESEND_API_KEY or RESEND_SEGMENT_ID");
    return json({ error: "Server configuration error" }, 500);
  }
  let email;
  try { email = (await request.json()).email; } catch { return json({ error: "Invalid request" }, 400); }
  if (typeof email !== "string" || !email.includes("@")) return json({ error: "Invalid email address" }, 400);
  const cleanEmail = email.toLowerCase().trim();
  const auth = { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" };
  try {
    const createRes = await fetch("https://api.resend.com/contacts", {
      method: "POST", headers: auth,
      body: JSON.stringify({ email: cleanEmail, unsubscribed: false }),
    });
    const createData = await createRes.json().catch(() => ({}));
    const alreadyExists = createRes.status === 409 ||
      (createData && typeof createData.message === "string" && /already/i.test(createData.message));
    if (!createRes.ok && !alreadyExists) {
      console.error("Resend contact error:", createData);
      return json({ error: "Could not subscribe" }, 400);
    }
    const segRes = await fetch(
      `https://api.resend.com/contacts/${encodeURIComponent(cleanEmail)}/segments/${env.RESEND_SEGMENT_ID}`,
      { method: "POST", headers: auth }
    );
    if (!segRes.ok) console.error("Add-to-segment failed:", await segRes.text());
    if (SEND_WELCOME && createRes.ok && !alreadyExists) {
      await sendWelcome(env.RESEND_API_KEY, cleanEmail).catch(
        (err) => console.error("Welcome email failed (subscription still succeeded):", err)
      );
    }
    return json({ success: true });
  } catch (err) {
    console.error("Subscribe error:", err);
    return json({ error: "Server error" }, 500);
  }
}

async function sendWelcome(apiKey, email) {
  const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="background:#e8dcc6;font-family:Georgia,serif;margin:0;padding:40px 24px;color:#2b2118;">
  <div style="max-width:520px;margin:0 auto;background:#fbf5e9;border:3px solid #c8763a;border-radius:10px;padding:28px 24px;">
    <div style="text-align:center;border-bottom:1px solid #e4d6bc;padding-bottom:16px;margin-bottom:22px;">
      <div style="font-size:26px;letter-spacing:.22em;color:#2b2118;font-weight:bold;">HEXADEC</div>
      <div style="font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#c8763a;margin-top:8px;font-weight:bold;">Sixteen tiles, four words</div>
    </div>
    <p style="font-size:14px;line-height:1.7;margin:0 0 14px;color:#4a4034;">
      You're on the list. Every Friday we send one free games email &mdash; the week's
      best from Hexadec, Guffinoes, the pub quiz, Whenly, What Word, Groupie, Twentee
      and Spellbound. One email a week, never more.
    </p>
    <p style="font-size:14px;line-height:1.7;margin:0 0 22px;color:#4a4034;">
      Can't wait until Friday? Today's sixteen are already on the table.
    </p>
    <div style="text-align:center;">
      <a href="https://hexadec.carlosfandango.net/"
         style="display:inline-block;background:#c8763a;border:1px solid #a85e28;color:#fff8ef;text-decoration:none;font-size:12px;letter-spacing:.14em;text-transform:uppercase;padding:13px 26px;font-weight:bold;border-radius:6px;">
        Play today's sixteen &rarr;
      </a>
    </div>
    <div style="margin-top:26px;border-top:1px solid #e4d6bc;padding-top:12px;font-size:11px;color:#8a7d63;text-align:center;letter-spacing:.06em;">
      HEXADEC &middot; sixteen tiles &middot; four words &middot; one grid
    </div>
  </div>
</body></html>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Hexadec <hello@pubquizdaily.com>",
      to: [email],
      subject: "You're in — sixteen fresh tiles every morning",
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend welcome send failed: ${await res.text()}`);
}

/* ---------- utils ---------- */
function clamp(v, lo, hi) {
  const n = parseInt(v ?? 0, 10) || 0;
  return Math.min(Math.max(n, lo), hi);
}
function serveRobots() {
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\n`, {
    headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=86400" },
  });
}
function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
