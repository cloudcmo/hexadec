/* Hexadec — the game.
 *
 * The rules live in engine.js and are shared with the build tools, so nothing
 * in here decides a score on its own. This file is the hands: the tiles, the
 * taps, the animations, saving, and the end card.
 *
 * Two things worth knowing before changing anything:
 *
 * 1. Score is never accumulated. It is recomputed from the ordered list of
 *    words on the grid every time that list changes. That is what makes
 *    "take any word back at any time" safe — there is no way to bank points
 *    from a word and then remove it.
 * 2. Taking a word back closes the gap: the words below it move up a row, onto
 *    different premium squares, and everything rescores. That is honest rather
 *    than tidy, and it is visible, because the tiles physically move.
 */

import * as E from "./engine.js";
import { FOURS, THREES, TWOS } from "./words.js";
import { TILES, LAYOUTS, MAXES, PARS, dayIndex } from "./days.js";

const SITE_URL = "https://hexadec.carlosfandango.net";
/* The quiet five minutes, scored at a point per five seconds, so the clock
 * tops out at 60 against a grid score of 100 to 250.
 *
 * It was a point per second, and that was wrong: a fast finish paid up to 300,
 * which is more than the puzzle itself, and Hexadec would have quietly become a
 * race. Shortening the clock instead would have paid up to 180 and ALSO put a
 * hurry on a game that is meant to be unhurried. Scoring the same five minutes
 * more cheaply fixes the proportion and leaves the pace alone. */
const FULL_SECONDS = 300;
const BONUS_PER = 5;               // seconds per bonus point, so the clock tops out at 60
const LEAGUE_MAX = 360;            // grid (~300 ceiling) plus the clock (60)

/* I'M STUCK costs 20 points and can be used once. It used to be unlimited and
 * to forfeit the whole time bonus, which was both too generous and too harsh at
 * once: you could lean on it for every row, but doing so cost up to 60. A flat
 * 20, once, is a price you can decide to pay. The clock keeps running either
 * way. */
const STUCK_COST = 20;

const FOUR_SET = new Set(FOURS.split(" "));
const WORD_SET = new Set([...FOUR_SET, ...THREES.split(" "), ...TWOS.split(" ")]);
const isWord = (s) => WORD_SET.has(s);
const FOUR_LIST = FOURS.split(" ");

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/* ---------------------------------------------------------------------------
 * The day
 * ------------------------------------------------------------------------- */
const UK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
});
const ukDate = (d = new Date()) => UK.format(d);

const S = {
  date: ukDate(),
  idx: -1,
  tiles: [],        // {id, ch, val}
  order: [],        // tile ids, tray display order
  layout: null,
  max: 0,
  par: 0,
  staged: [],       // tile ids
  rows: [],         // {word, ids:[4]}
  ms: 0,            // milliseconds spent
  running: false,
  t0: 0,
  helped: false,
  ended: false,
  takebacks: 0,
  sent: false,
};

function loadDay() {
  const i = dayIndex(S.date);
  if (i < 0) return false;
  S.idx = i;
  S.layout = E.layoutFrom(LAYOUTS[i]);
  S.max = MAXES[i];
  S.par = PARS[i];
  S.tiles = TILES[i].split("").map((ch, k) => ({ id: k, ch, val: E.letterValue(ch) }));
  S.order = S.tiles.map((t) => t.id);
  return true;
}

/* ---------------------------------------------------------------------------
 * The tablecloth
 *
 * Pure CSS, no images: a stack of repeating gradients, with the pattern and
 * the palette stepping at different rates so the two rarely repeat together.
 * ------------------------------------------------------------------------- */
const CLOTH_COLOURS = [
  ["#e8dcc6", "#c8763a", "#8c4a2f"],   // terracotta
  ["#dfe6dc", "#4f7a5c", "#2f4c3a"],   // sage
  ["#e6e0ea", "#6b3f7a", "#472a52"],   // plum
  ["#e4e6ea", "#3f5f7a", "#26404f"],   // slate blue
  ["#eae3d2", "#a8832f", "#6d5317"],   // ochre
  ["#e9dede", "#a8462f", "#6d2a1c"],   // brick
  ["#dde5e6", "#2f7a78", "#1a4d4c"],   // teal
];

function dressCloth(index) {
  const [bg, ink, deep] = CLOTH_COLOURS[index % CLOTH_COLOURS.length];
  const pattern = E.CLOTHS[Math.floor(index / CLOTH_COLOURS.length) % E.CLOTHS.length];
  const a = (c, o) => c + Math.round(o * 255).toString(16).padStart(2, "0");
  const layers = {
    gingham: `repeating-linear-gradient(90deg,${a(ink, .3)} 0 22px,transparent 22px 44px),
              repeating-linear-gradient(0deg,${a(ink, .3)} 0 22px,transparent 22px 44px)`,
    tartan: `repeating-linear-gradient(90deg,${a(deep, .34)} 0 30px,transparent 30px 74px,${a(ink, .22)} 74px 82px,transparent 82px 120px),
             repeating-linear-gradient(0deg,${a(deep, .34)} 0 30px,transparent 30px 74px,${a(ink, .22)} 74px 82px,transparent 82px 120px)`,
    check: `repeating-linear-gradient(90deg,${a(ink, .22)} 0 34px,transparent 34px 68px),
            repeating-linear-gradient(0deg,${a(ink, .22)} 0 34px,transparent 34px 68px)`,
    stripe: `repeating-linear-gradient(45deg,${a(ink, .2)} 0 16px,transparent 16px 38px)`,
    polka: `radial-gradient(${a(ink, .32)} 5px,transparent 6px) 0 0/38px 38px,
            radial-gradient(${a(ink, .32)} 5px,transparent 6px) 19px 19px/38px 38px`,
    windowpane: `repeating-linear-gradient(90deg,${a(deep, .3)} 0 2px,transparent 2px 56px),
                 repeating-linear-gradient(0deg,${a(deep, .3)} 0 2px,transparent 2px 56px)`,
    houndstooth: `repeating-linear-gradient(135deg,${a(deep, .26)} 0 12px,transparent 12px 24px),
                  repeating-linear-gradient(45deg,${a(ink, .18)} 0 12px,transparent 12px 24px)`,
    ticking: `repeating-linear-gradient(90deg,${a(ink, .3)} 0 3px,transparent 3px 9px,${a(ink, .3)} 9px 12px,transparent 12px 46px)`,
    madras: `repeating-linear-gradient(90deg,${a(ink, .2)} 0 14px,transparent 14px 30px,${a(deep, .2)} 30px 36px,transparent 36px 62px),
             repeating-linear-gradient(0deg,${a(ink, .2)} 0 14px,transparent 14px 30px,${a(deep, .2)} 30px 36px,transparent 36px 62px)`,
    plaid: `repeating-linear-gradient(90deg,${a(ink, .26)} 0 40px,transparent 40px 60px),
            repeating-linear-gradient(0deg,${a(deep, .2)} 0 20px,transparent 20px 60px)`,
    dot: `radial-gradient(${a(deep, .26)} 3px,transparent 4px) 0 0/24px 24px`,
    weave: `repeating-linear-gradient(0deg,${a(ink, .16)} 0 4px,transparent 4px 8px),
            repeating-linear-gradient(90deg,${a(deep, .14)} 0 4px,transparent 4px 8px)`,
  };
  const cloth = $("cloth");
  cloth.style.backgroundColor = bg;
  cloth.style.backgroundImage = layers[pattern] || layers.gingham;
  document.querySelector('meta[name="theme-color"]').setAttribute("content", ink);
}

/* ---------------------------------------------------------------------------
 * Sizing
 *
 * The board, the staging row, the tray and the Place button all have to be on
 * screen together on a 375x600 phone, or the game asks the player to scroll at
 * the exact moment they are deciding something.
 * ------------------------------------------------------------------------- */
function fit() {
  const w = Math.min(document.documentElement.clientWidth, 520) - 24;
  const h = window.innerHeight;
  const byWidth = (w - 12 - 18) / 4;
  /* board + stage + tray + buttons + header + footer, as multiples of a cell */
  const chrome = 250;
  const byHeight = (h - chrome) / 6.1;
  const cell = Math.max(40, Math.min(78, Math.floor(Math.min(byWidth, byHeight))));
  document.documentElement.style.setProperty("--cell", cell + "px");
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */
const PREM = { d: ["dl", "2×L"], t: ["tl", "3×L"], D: ["dw", "2×W"], T: ["tw", "3×W"] };

function tileNode(t, cls) {
  const n = el("div", "tile" + (cls ? " " + cls : ""));
  n.appendChild(el("span", "ch", t.ch.toUpperCase()));
  n.appendChild(el("span", "val", String(t.val)));
  return n;
}
const tileById = (id) => S.tiles.find((t) => t.id === id);

function buildBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const code = S.layout[r][c];
      const p = PREM[code];
      const cell = el("div", "cell" + (p ? " " + p[0] : ""), p ? p[1] : "");
      cell.dataset.r = r; cell.dataset.c = c;
      cell.addEventListener("click", () => takeBack(r));
      board.appendChild(cell);
    }
  }
}

function paintBoard() {
  const cells = $("board").children;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const cell = cells[r * 4 + c];
      const old = cell.querySelector(".tile");
      if (old) old.remove();
      cell.classList.toggle("row-live", !S.ended && r === S.rows.length);
      const row = S.rows[r];
      if (row) cell.appendChild(tileNode(tileById(row.ids[c]), "placed"));
    }
  }
}

/* The tray does NOT close its gaps while you are choosing.
 *
 * It used to, and that made it treacherous: every tap reflowed the row, so the
 * letter you were about to press moved out from under your thumb and you picked
 * the wrong one. A tile you have staged now leaves a hole exactly where it was,
 * and the holes close only when the word is placed — at which point the tiles
 * are gone for good and closing up is what you want. */
function paintTray() {
  const tray = $("tray");
  tray.innerHTML = "";
  const placed = new Set(S.rows.flatMap((r) => r.ids));
  const staged = new Set(S.staged);
  for (const id of S.order) {
    if (placed.has(id)) continue;
    const t = tileById(id);
    const held = staged.has(id);
    const n = tileNode(t, held ? "ghost" : "");
    if (!held) n.addEventListener("click", () => stage(id));
    tray.appendChild(n);
  }
}

function paintSlots() {
  const slots = $("slots");
  slots.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const s = el("div", "slot");
    const id = S.staged[i];
    if (id != null) {
      s.appendChild(tileNode(tileById(id)));
      s.addEventListener("click", () => unstage(i));
    }
    slots.appendChild(s);
  }
}

function currentScore() {
  return E.scorePlacement(S.rows.map((r) => r.word), S.layout, isWord);
}

function paintScore() {
  $("score").textContent = currentScore().total.toLocaleString();
}

/* What would the staged word be worth, placed on the next free row? */
function preview() {
  const word = S.staged.map((id) => tileById(id).ch).join("");
  const vw = $("vword"), vn = $("vnote");
  vw.textContent = word.toUpperCase() || " ";
  $("btnPlay").disabled = true;

  if (S.staged.length < 4) {
    vn.className = "";
    vn.textContent = S.staged.length === 0
      ? "Tap four tiles."
      : `${4 - S.staged.length} more.`;
    return;
  }
  if (!FOUR_SET.has(word)) {
    vn.className = "bad";
    vn.textContent = "Not in the word list.";
    return;
  }
  const before = currentScore().total;
  const after = E.scorePlacement([...S.rows.map((r) => r.word), word], S.layout, isWord);
  const gain = after.total - before;
  const downs = after.rows[S.rows.length].downs;
  vn.className = "";
  vn.innerHTML = `<span class="pts">+${gain}</span>` +
    (downs.length ? ` · ${downs.length} column${downs.length > 1 ? "s" : ""} down` : "");
  $("btnPlay").disabled = false;
}

/* Offered from the moment the first tile is tapped, and gone once used or once
   the game is over. The 20 points are the regulator, not the timing. */
function paintExtras() {
  $("extraBtns").style.display =
    (!S.ended && !S.helped && (S.running || S.ms > 0)) ? "flex" : "none";
}

function repaint() {
  paintBoard(); paintTray(); paintSlots(); paintScore(); preview(); paintExtras();
}

/* ---------------------------------------------------------------------------
 * Playing
 * ------------------------------------------------------------------------- */
function startClock() {
  if (S.running || S.ended) return;
  S.running = true;
  S.t0 = Date.now();
}
function stopClock() {
  if (!S.running) return;
  S.ms += Date.now() - S.t0;
  S.running = false;
}
function elapsedMs() { return S.ms + (S.running ? Date.now() - S.t0 : 0); }
function timeBonus() {
  const left = Math.max(0, FULL_SECONDS - Math.floor(elapsedMs() / 1000));
  return Math.floor(left / BONUS_PER);
}
function penalty() { return S.helped ? STUCK_COST : 0; }
/* What goes on the end card, into the league and to /api/played. Floored at
   zero so a short game with a nudge can never read as a negative. */
function finalScore() {
  return Math.max(0, currentScore().total + timeBonus() - penalty());
}

function stage(id) {
  if (S.ended) return;
  startClock();
  if (S.staged.includes(id)) return;
  if (S.rows.some((r) => r.ids.includes(id))) return;
  if (S.staged.length >= 4) return;
  S.staged.push(id);
  paintTray(); paintSlots(); preview(); paintExtras();
}

function unstage(i) {
  if (S.ended) return;
  S.staged.splice(i, 1);
  paintTray(); paintSlots(); preview();
}

function clearStage() {
  S.staged = [];
  paintTray(); paintSlots(); preview();
}

function mix() {
  S.order = E.shuffled(S.order, Math.random);
  paintTray();
}

function placeWord() {
  if (S.staged.length !== 4 || S.ended) return;
  const word = S.staged.map((id) => tileById(id).ch).join("");
  if (!FOUR_SET.has(word)) { $("slots").classList.add("shake"); setTimeout(() => $("slots").classList.remove("shake"), 360); return; }
  const r = S.rows.length;
  S.rows.push({ word, ids: S.staged.slice() });
  S.staged = [];
  repaint();
  celebrate(r);
  save();
  if (S.rows.length === 4) setTimeout(finish, 1100);
}

function takeBack(r) {
  if (S.ended || !S.rows[r]) return;
  startClock();
  S.rows.splice(r, 1);
  S.takebacks++;
  S.staged = [];
  repaint();
  save();
}

/* ---------------------------------------------------------------------------
 * The noisy bit
 *
 * A row landing floats its own points, and every column that just became a
 * word lights up and floats its own. The column chips are staggered so three
 * at once read as three things rather than one blur.
 * ------------------------------------------------------------------------- */
function chipAt(cell, text, cls, delay) {
  const board = $("board");
  const cb = board.getBoundingClientRect();
  const rb = cell.getBoundingClientRect();
  const chip = el("div", "chip" + (cls ? " " + cls : ""), text);
  chip.style.left = (rb.left - cb.left + rb.width / 2) + "px";
  chip.style.top = (rb.top - cb.top - 4) + "px";
  chip.style.animationDelay = delay + "ms";
  board.appendChild(chip);
  setTimeout(() => chip.remove(), 1400 + delay);
}

function celebrate(r) {
  const cells = $("board").children;
  const detail = currentScore().rows[r];
  if (!detail) return;
  for (let c = 0; c < 4; c++) cells[r * 4 + c].querySelector(".tile")?.classList.add("drop");
  $("board").style.position = "relative";
  chipAt(cells[r * 4 + 3], `+${detail.across}`, "across", 120);

  detail.downs.forEach((d, k) => {
    const delay = 460 + k * 260;
    for (let i = 0; i <= r; i++) {
      const cell = cells[i * 4 + d.col];
      setTimeout(() => {
        cell.classList.add("downlit");
        setTimeout(() => cell.classList.remove("downlit"), 900);
      }, delay);
    }
    const label = d.word.length === 4 ? `↓ ${d.word.toUpperCase()} +${d.score} ×2` : `↓ +${d.score}`;
    chipAt(cells[r * 4 + d.col], label, "down", delay);
  });
}

/* ---------------------------------------------------------------------------
 * "Show me a word"
 *
 * Offered only once the five minutes are gone, or once the player has taken
 * four words back — the two shapes of being genuinely stuck. It never offers a
 * word that leads nowhere: the candidate must leave a remainder that can still
 * be finished. Using it forfeits the time bonus, which is the whole cost.
 * ------------------------------------------------------------------------- */
function remainingCounts() {
  const used = new Set(S.rows.flatMap((r) => r.ids));
  const left = S.tiles.filter((t) => !used.has(t.id)).map((t) => t.ch).join("");
  return { left, counts: E.countLetters(left) };
}

function fitsCount(w, c) {
  for (let i = 0; i < 4; i++) { const k = w.charCodeAt(i) - 97; if (c[k] <= 0) return false; c[k]--; }
  for (let i = 0; i < 4; i++) c[w.charCodeAt(i) - 97]++;
  return true;
}
function minus(c, w) { const o = c.slice(); for (const ch of w) o[ch.charCodeAt(0) - 97]--; return o; }
function completable(counts, list, depth) {
  if (depth === 0) { for (let i = 0; i < 26; i++) if (counts[i]) return false; return true; }
  for (const w of list) {
    if (!fitsCount(w, counts.slice())) continue;
    if (completable(minus(counts, w), list, depth - 1)) return true;
  }
  return false;
}

function useStuck() {
  /* The moment a player most needs this is the moment it is hardest to give:
     three words down and the last four tiles spelling nothing. There is no word
     to suggest for that row, and an earlier version simply said "nothing fits,
     take a word back" — which is both obvious and unhelpful, because it does
     not say WHICH. So it backs up for them, one row at a time, until there is a
     word that leaves a way home. Every shipped day is solvable from an empty
     grid, so this always terminates with a suggestion. */
  if (S.helped || S.ended) return;   // one to a customer
  let removed = 0;
  let pick = null;
  while (true) {
    const { left, counts } = remainingCounts();
    const list = E.makeableWords(left, FOUR_LIST);
    const need = 4 - S.rows.length;
    pick = list.find((w) => completable(minus(counts, w), list, need - 1));
    if (pick || !S.rows.length) break;
    S.rows.pop();
    S.takebacks++;
    removed++;
  }
  S.helped = true;
  S.staged = [];
  if (!pick) {   /* cannot happen with a generated day; say something true anyway */
    repaint();
    $("vnote").className = "bad";
    $("vnote").textContent = "Nothing fits these tiles.";
    return;
  }
  const used = new Set(S.rows.flatMap((r) => r.ids));
  for (const ch of pick) {
    const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
    if (t) S.staged.push(t.id);
  }
  repaint();
  $("vnote").className = "";
  $("vnote").innerHTML = removed
    ? `Took back ${removed} word${removed > 1 ? "s" : ""}. This one leaves a way home. −${STUCK_COST}.`
    : `This one leaves a way home. −${STUCK_COST} at the end.`;
  save();
}

/* ---------------------------------------------------------------------------
 * Saving
 * ------------------------------------------------------------------------- */
const KEY = () => "hexadec-" + S.date;
function save() {
  try {
    localStorage.setItem(KEY(), JSON.stringify({
      v: 1, rows: S.rows.map((r) => r.ids), ms: elapsedMs(),
      helped: S.helped, ended: S.ended, takebacks: S.takebacks, order: S.order,
    }));
  } catch (e) {}
}
function restore() {
  let raw = null;
  try { raw = localStorage.getItem(KEY()); } catch (e) {}
  if (!raw) return false;
  let d;
  try { d = JSON.parse(raw); } catch (e) { return false; }
  if (!d || d.v !== 1 || !Array.isArray(d.rows)) return false;
  const seen = new Set();
  for (const ids of d.rows) {
    if (!Array.isArray(ids) || ids.length !== 4) return false;
    for (const id of ids) {
      if (typeof id !== "number" || id < 0 || id > 15 || seen.has(id)) return false;
      seen.add(id);
    }
    const word = ids.map((i) => S.tiles[i].ch).join("");
    if (!FOUR_SET.has(word)) return false;
    S.rows.push({ word, ids });
  }
  if (Array.isArray(d.order) && d.order.length === 16) S.order = d.order;
  S.ms = typeof d.ms === "number" && d.ms >= 0 ? d.ms : 0;
  S.helped = !!d.helped;
  S.takebacks = d.takebacks | 0;
  S.ended = !!d.ended || S.rows.length === 4;
  return true;
}

/* ---------------------------------------------------------------------------
 * Finishing
 * ------------------------------------------------------------------------- */
function finish() {
  if (S.ended) { showCard(); return; }
  stopClock();
  S.ended = true;
  save();
  showCard();
  report();
}

function shareArt() {
  /* Where your points came from, without giving away a single letter:
     one square per tile, shaded by what that tile earned on its square, and
     marked when it was part of a column that went all the way down. */
  const detail = currentScore();
  const full = new Set();
  detail.rows.forEach((row, r) => row.downs.forEach((d) => {
    if (d.word.length === 4) for (let i = 0; i < 4; i++) full.add(i * 4 + d.col);
  }));
  const out = [];
  for (let r = 0; r < 4; r++) {
    let line = "";
    for (let c = 0; c < 4; c++) {
      if (full.has(r * 4 + c)) { line += "\u{1F7EA}"; continue; }
      const code = S.layout[r][c];
      const lm = code === "d" ? 2 : code === "t" ? 3 : 1;
      const v = E.letterValue(S.rows[r].word[c]) * lm;
      line += v >= 8 ? "\u{1F7E7}" : v >= 4 ? "\u{1F7E8}" : "⬜";
    }
    out.push(line);
  }
  return out.join("\n");
}

function shareText() {
  const d = new Date(S.date + "T12:00:00");
  const nice = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const words = currentScore().total;
  const bonus = timeBonus();
  const pct = Math.round(words / S.max * 100);
  const bits = [
    `Hexadec ${nice} · ${finalScore().toLocaleString()}`,
    `${words} on the grid${bonus ? ` + ${bonus} on the clock` : ""}${S.helped ? ` − ${STUCK_COST} for a nudge` : ""} · ${pct}% of the best possible`,
    "",
    shareArt(),
  ];
  bits.push(SITE_URL);
  return bits.join("\n");
}

async function doShare() {
  const text = shareText();
  try { if (navigator.share) { await navigator.share({ text }); return; } }
  catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(text); toast("Result copied."); }
  catch (e) { toast("Could not copy."); }
}

function toast(msg) {
  const t = el("div", "trimnote", msg);
  $("cardBody").appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function showCard() {
  const detail = currentScore();
  const words = detail.total;
  const bonus = timeBonus();
  const total = finalScore();
  const pct = Math.round(words / S.max * 100);
  const secs = Math.floor(elapsedMs() / 1000);
  const mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, "0");

  const downs = detail.rows.flatMap((r) => r.downs);
  const fulls = downs.filter((d) => d.word.length === 4);

  const rowLines = detail.rows.map((r, i) =>
    `<code>${r.word.toUpperCase()}</code> ${r.total}` +
    (r.downs.length ? ` <span class="muted">(${r.downs.map((d) => "↓" + d.word.toUpperCase() + " " + d.score).join(" ")})</span>` : "")
  ).join("<br>");

  const comment =
    pct >= 90 ? "Very nearly the best there was." :
    pct >= 78 ? "A strong line." :
    pct >= 65 ? "Better than a careful guess." :
    pct >= 50 ? "Solid, though more was in it." :
    "Plenty left in those tiles.";

  $("cardBody").innerHTML = `
    <h1>Hexadec</h1>
    <div class="muted">${new Date(S.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
    <div class="bigscore">${total.toLocaleString()}</div>
    <div class="breakdown">
      <b>${words}</b> on the grid${bonus ? ` + <b>${bonus}</b> for the time left` : ""}${S.helped ? ` − <b>${STUCK_COST}</b> for a nudge` : ""}
      <br>Finished in ${mm}:${ss}${S.takebacks ? ` · ${S.takebacks} take-back${S.takebacks > 1 ? "s" : ""}` : ""}
    </div>
    <div class="meter"><i style="width:${Math.min(100, pct)}%"></i></div>
    <div class="breakdown"><b>${pct}%</b> of the best possible ${S.max}.<br>${comment}</div>
    <div class="wordlist">${rowLines}</div>
    ${downs.length ? `<div class="muted" style="margin-top:6px">${downs.length} column word${downs.length > 1 ? "s" : ""}${fulls.length ? `, ${fulls.length} of them the full four` : ""}.</div>` : '<div class="muted" style="margin-top:6px">No columns came good. That is where the points hide.</div>'}
    <div class="row-btns" style="margin-top:14px">
      <button class="btn primary" id="btnShare">Share score</button>
      <button class="btn small" id="btnBest">Best line</button>
    </div>
    <div id="bestOut"></div>
    <div id="endBar"></div>
    <p class="trimnote" id="endHome"></p>
    <div class="sheet" style="margin-top:14px;box-shadow:none">
      <h2>One email a week</h2>
      <p class="muted">Friday mornings: the week's best from Hexadec and the rest of the Guff games. Never more.</p>
      <form id="subForm"><input type="email" id="subEmail" placeholder="you@example.com" required>
      <button class="btn primary" type="submit">Sign up</button></form>
      <div id="subMsg" class="muted"></div>
    </div>
    <div class="trimnote" id="nextIn"></div>
  `;
  $("overlay").classList.add("on");
  /* The one place the note is worth making is where people have just finished
     and are deciding whether this is a thing they do every morning. Same line
     as the rest of the family. */
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  $("endHome").innerHTML = ios
    ? "Add Hexadec to your home screen: share button → <b>Add to Home Screen</b>. It becomes an app. No shop, no fee, no fuss."
    : "Add Hexadec to your home screen: ⋮ menu → <b>Add to Home screen</b>. It becomes an app. No shop, no fee, no fuss.";
  $("btnShare").addEventListener("click", doShare);
  $("btnBest").addEventListener("click", revealBest);
  $("subForm").addEventListener("submit", subscribe);
  barToEnd();
  tickNext();
}

/* The best line is recomputed here rather than shipped in days.js, because a
   solution sitting in the page source is a solution somebody will read. It is
   an exhaustive search, so it runs once, on demand, after the game is over. */
function revealBest() {
  const out = $("bestOut");
  out.innerHTML = '<div class="trimnote">Working it out…</div>';
  setTimeout(() => {
    const rack = S.tiles.map((t) => t.ch).join("");
    const list = E.makeableWords(rack, FOUR_LIST);
    const { best, bestWords } = E.maximise(rack, list, S.layout, isWord);
    if (!bestWords) { out.innerHTML = ""; return; }
    const sc = E.scorePlacement(bestWords, S.layout, isWord);
    out.innerHTML = `<div class="wordlist" style="margin-top:10px">The best line was
      ${bestWords.map((w) => `<code>${w.toUpperCase()}</code>`).join(" ")} for <b>${best}</b>` +
      (sc.rows.some((r) => r.downs.length)
        ? ` <span class="muted">(${sc.rows.flatMap((r) => r.downs).map((d) => "↓" + d.word.toUpperCase()).join(" ")})</span>`
        : "") + `</div>`;
  }, 30);
}

function tickNext() {
  const n = $("nextIn");
  if (!n) return;
  const upd = () => {
    if (!document.body.contains(n)) return;
    const s = secondsToNextDay();
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    n.textContent = `Next sixteen in ${h}h ${String(m).padStart(2, "0")}m`;
    setTimeout(upd, 30000);
  };
  upd();
}

/* Seconds until the London date flips — not the device's midnight, which is
   the wrong moment everywhere except here. */
function secondsToNextDay() {
  const now = new Date();
  const today = ukDate(now);
  let lo = 1, hi = 172800;
  if (ukDate(new Date(+now + hi * 1000)) === today) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ukDate(new Date(+now + mid * 1000)) === today) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ---------------------------------------------------------------------------
 * The Guff furniture
 * ------------------------------------------------------------------------- */
function report() {
  if (S.sent) { paintBar(); return; }
  try {
    if (localStorage.getItem("hexadec-sent-" + S.date)) { S.sent = true; paintBar(); return; }
    localStorage.setItem("hexadec-sent-" + S.date, "1");
  } catch (e) {}
  S.sent = true;
  const words = currentScore().total;
  try {
    fetch("/api/played", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: S.date, complete: S.rows.length === 4 ? 1 : 0,
        score: finalScore(), words, seconds: Math.floor(elapsedMs() / 1000),
        pct: Math.round(words / S.max * 100), helped: S.helped ? 1 : 0,
      }),
    }).catch(() => {});
  } catch (e) {}
  paintBar();
}

function paintBar() {
  const slot = $("guffbar-slot");
  if (!slot) return;
  const words = currentScore().total;
  const total = finalScore();
  const pct = Math.round(words / S.max * 100);
  if (window.GuffBar && GuffBar.completedToday) {
    GuffBar.completedToday(slot, {
      score: Math.min(9999, total), max: LEAGUE_MAX,
      display: `${total.toLocaleString()} · ${pct}%`,
    });
  } else if (!window.GuffBar) {
    slot.innerHTML = '<div class="trimnote">(The Guff bar and daily league appear here on the live site.)</div>';
  }
}

/* The end card covers the page, and the page is where the bar lives. Move the
   node rather than rendering a second one: another completedToday would report
   the day twice. */
function barToEnd() {
  const slot = $("guffbar-slot"), host = $("endBar");
  if (slot && host && slot.parentNode !== host) host.appendChild(slot);
}
function barToPage() {
  const slot = $("guffbar-slot"), home = $("guffbar-home");
  if (slot && home && slot.parentNode !== home) home.appendChild(slot);
}

async function subscribe(ev) {
  ev.preventDefault();
  const email = $("subEmail").value.trim();
  const msg = $("subMsg");
  msg.textContent = "One moment…";
  try {
    const res = await fetch("/api/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    msg.textContent = res.ok && data.success ? "You're on the list." : (data.error || "That didn't work.");
    if (res.ok && data.success) $("subForm").reset();
  } catch (e) { msg.textContent = "That didn't work."; }
}

/* ---------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */
function homeScreenCard() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  $("cardBody").innerHTML = `
    <h1>On your phone</h1>
    <p style="font-size:14px;line-height:1.6">Hexadec runs from the home screen like an app, with no browser bars
    eating the board.</p>
    <p style="font-size:14px;line-height:1.6">${ios
      ? "In Safari, tap the share button at the bottom, then <b>Add to Home Screen</b>."
      : "In Chrome, tap the ⋮ menu, then <b>Add to Home screen</b> or <b>Install app</b>."}</p>
    <button class="btn primary" id="btnOk">Right you are</button>`;
  $("overlay").classList.add("on");
  $("btnOk").addEventListener("click", () => $("overlay").classList.remove("on"));
}

function boot() {
  if (!loadDay()) {
    document.getElementById("shell").innerHTML =
      '<div class="sheet"><h2>Nothing for today</h2><p>The puzzle table has run out. ' +
      'It needs regenerating with <code>npm run days</code>.</p></div>';
    return;
  }
  dressCloth(S.idx);
  fit();
  buildBoard();

  restore();
  $("dateline").textContent = new Date(S.date + "T12:00:00")
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  repaint();

  $("btnPlay").addEventListener("click", placeWord);
  $("btnClear").addEventListener("click", clearStage);
  $("btnMix").addEventListener("click", mix);
  $("btnStuck").addEventListener("click", useStuck);
  $("linkHome").addEventListener("click", (e) => { e.preventDefault(); homeScreenCard(); });
  $("btnClose").addEventListener("click", () => {
    $("overlay").classList.remove("on");
    if (S.ended) barToPage();
  });

  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", () => setTimeout(fit, 120));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopClock(); save(); }
  });
  /* A backstop for the button's visibility; every interaction paints it too. */
  setInterval(() => { if (!S.ended) paintExtras(); }, 2000);

  if (S.ended) { finish(); }
  else if (S.rows.length === 4) { finish(); }
}

/* Test and tooling hook, in the family style. */
window.__hx = {
  S, E, isWord, FOUR_LIST, currentScore, placeWord, stage, takeBack, useStuck,
  shareText, finish, timeBonus, penalty, finalScore, state: () => ({
    rows: S.rows.map((r) => r.word), score: currentScore().total,
    max: S.max, ended: S.ended, helped: S.helped, takebacks: S.takebacks,
  }),
};

boot();
