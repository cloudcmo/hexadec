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
 * 2. The grid is four fixed rows, any of which may be empty (10 Oct 2026). Tiles
 *    you tap go straight onto the target row, pencilled in, and Place inks
 *    them. The target is the highest empty row unless you tap another. Taking a
 *    word back leaves a gap; nothing else moves. Columns read from the top, so a
 *    column only scores once every row above it is filled. That makes a FINISHED
 *    grid score exactly what it always did, so days.js, the maximums and par
 *    were untouched by the change. Before this, words were an ordered list,
 *    always landed on the next row down, and a take-back shunted the rows below
 *    up onto different premium squares.
 * 3. The sixteenth tile does not end the game (16 Oct 2026). Once the grid is
 *    full the words can be dragged up and down to try other orders, since the
 *    same four words on different rows catch different premium squares and
 *    make different columns. Finish ends it. The day's maximum was always the
 *    best of every solution in every row order, so nothing about the maximums
 *    or par changed; this just lets the player go looking for it.
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

/* How many days of results to keep. Six months is plenty for a streak and a
   personal best, and small enough that localStorage never notices. */
const HISTORY_DAYS = 180;

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

/* Someone who has asked their machine for less movement gets the result of a
   shuffle without the performance of one. Checked live, not once at boot, so a
   change of setting takes effect without a reload. */
const CALM = window.matchMedia("(prefers-reduced-motion: reduce)");

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
  staged: [],       // tile ids pencilled into the target row, left to right
  rows: [null, null, null, null],   // per board row: {word, ids:[4]} or null
  target: 0,        // the row tapped tiles go to; null once the grid is full
  ms: 0,            // milliseconds spent
  running: false,
  t0: 0,
  helped: false,
  ended: false,
  takebacks: 0,
  sent: false,
  watch: null,      // the initials being watched, in watch mode (6 Oct 2026)
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
 * The board, the verdict line, the tray and the Place button all have to be on
 * screen together on a 375x600 phone, or the game asks the player to scroll at
 * the exact moment they are deciding something. The board got the room the
 * staging slots used to take (10 Oct 2026).
 * ------------------------------------------------------------------------- */
function fit() {
  const w = Math.min(document.documentElement.clientWidth, 520) - 24;
  const h = window.innerHeight;
  const byWidth = (w - 12 - 18) / 4;
  /* board + tray + buttons as multiples of a cell; header, footer, verdict line */
  const chrome = 272;
  const byHeight = (h - chrome) / 5.2;
  const cell = Math.max(40, Math.min(78, Math.floor(Math.min(byWidth, byHeight))));
  document.documentElement.style.setProperty("--cell", cell + "px");
}

/* ---------------------------------------------------------------------------
 * Rendering
 * ------------------------------------------------------------------------- */
const PREM = { d: ["dl", "2×L"], t: ["tl", "3×L"], D: ["dw", "2×W"], T: ["tw", "3×W"] };

/* A tray tile is a button, because pressing it is the whole game and a div with
   a click handler cannot be reached from a keyboard or announced by a screen
   reader. Tiles on the board stay plain, because there the CELL is the
   control. */
function tileNode(t, cls, tag) {
  const n = el(tag || "div", "tile" + (cls ? " " + cls : ""));
  if (tag === "button") {
    n.type = "button";
    n.setAttribute("aria-label", `${t.ch.toUpperCase()}, ${t.val} point${t.val === 1 ? "" : "s"}`);
  }
  n.dataset.id = t.id;          // so a shuffle can find where this tile was
  n.appendChild(el("span", "ch", t.ch.toUpperCase()));
  n.appendChild(el("span", "val", String(t.val)));
  return n;
}
const tileById = (id) => S.tiles.find((t) => t.id === id);

/* The four rows are fixed seats now, so "how many words" and "which tiles are
   down" are questions about the filled ones. */
const filledRows = () => S.rows.filter(Boolean);
const filledCount = () => filledRows().length;
const placedIds = () => new Set(filledRows().flatMap((r) => r.ids));
const firstEmpty = () => { const i = S.rows.findIndex((r) => !r); return i < 0 ? null : i; };
function emptyRows() { S.rows = [null, null, null, null]; }

function buildBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const code = S.layout[r][c];
      const p = PREM[code];
      const cell = el("div", "cell" + (p ? " " + p[0] : ""), p ? p[1] : "");
      cell.dataset.r = r; cell.dataset.c = c;
      cell.addEventListener("click", () => onCell(r, c));
      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCell(r, c); }
      });
      board.appendChild(cell);
    }
  }
}

/* One tap on the board means one of three things, by what is under it:
   a word (take it back), the row you are spelling into (give that letter
   back), or any other empty row (aim there; pencilled letters come too). */
function onCell(r, c) {
  if (S.ended) return;
  if (S.rows[r]) { takeBack(r); return; }
  if (r !== S.target) { setTarget(r); return; }
  if (c < S.staged.length) unstage(c);
}

function setTarget(r) {
  if (S.ended || r == null || S.rows[r] || r === S.target) return;
  S.target = r;
  paintBoard(); preview();
  const cells = $("board").children;
  if (!CALM.matches) for (let c = 0; c < 4; c++) {
    const n = cells[r * 4 + c];
    n.classList.remove("aim"); void n.offsetWidth; n.classList.add("aim");
  }
}

/* What is under the tile, as a small code in its corner. Once a letter covers
   a triple the square is invisible, so this is how a grid gets read. */
function pip(t, code) {
  if (PREM[code]) {
    t.appendChild(el("span",
      "prem " + (code === "d" || code === "t" ? "p-letter" : "p-word"),
      PREM[code][1]));
  }
  return t;
}

function paintBoard() {
  const cells = $("board").children;
  for (let r = 0; r < 4; r++) {
    const live = !S.ended && r === S.target;
    for (let c = 0; c < 4; c++) {
      const cell = cells[r * 4 + c];
      const old = cell.querySelector(".tile");
      if (old) old.remove();
      cell.classList.toggle("row-live", live);
      cell.classList.toggle("row-open", !S.ended && !live && !S.rows[r]);
      const row = S.rows[r];
      const code = S.layout[r][c];
      const sq = PREM[code] ? `, ${PREM[code][1]} square` : "";
      if (row) {
        cell.appendChild(pip(tileNode(tileById(row.ids[c]), "placed"), code));
        cell.setAttribute("role", "button");
        cell.setAttribute("tabindex", S.ended ? "-1" : "0");
        cell.setAttribute("aria-label",
          `Row ${r + 1}: ${row.word.toUpperCase()}${sq}. Take it back.`);
      } else if (live && S.staged[c] != null) {
        const t = tileById(S.staged[c]);
        cell.appendChild(pip(tileNode(t, "pencil"), code));
        cell.setAttribute("role", "button");
        cell.setAttribute("tabindex", "0");
        cell.setAttribute("aria-label", `Row ${r + 1}, letter ${c + 1}: ${t.ch.toUpperCase()}${sq}. Put it back.`);
      } else if (S.ended) {
        cell.removeAttribute("role");
        cell.removeAttribute("tabindex");
        cell.setAttribute("aria-label", `Row ${r + 1}, square ${c + 1}${sq}, empty`);
      } else {
        /* One stop per empty row is plenty for a keyboard. */
        cell.setAttribute("role", "button");
        cell.setAttribute("tabindex", c === 0 && !live ? "0" : "-1");
        cell.setAttribute("aria-label", live
          ? `Row ${r + 1}, square ${c + 1}${sq}, empty. Your next word goes here.`
          : `Row ${r + 1}, empty${sq}. Put your next word here.`);
      }
    }
  }
}

/* The tray does NOT close its gaps while you are choosing.
 *
 * It used to, and that made it treacherous: every tap reflowed the row, so the
 * letter you were about to press moved out from under your thumb and you picked
 * the wrong one. A tile you have pencilled in leaves a hole exactly where it
 * was, and the holes close only when the word is placed — at which point the
 * tiles are gone for good and closing up is what you want. */
function paintTray() {
  const tray = $("tray");
  tray.innerHTML = "";
  const placed = placedIds();
  const staged = new Set(S.staged);
  for (const id of S.order) {
    if (placed.has(id)) continue;
    const t = tileById(id);
    const held = staged.has(id);
    const n = tileNode(t, held ? "ghost" : "", "button");
    if (held) { n.disabled = true; n.setAttribute("aria-hidden", "true"); }
    if (drag && drag.live && drag.id === id) { n.classList.add("hole"); drag.node = n; }
    else n.addEventListener("click", () => stage(id));
    tray.appendChild(n);
  }
}

/* Score is a pure function of the grid. The unbroken run of rows from the top
   scores exactly as it always has, columns and all. A word sitting below a gap
   scores its own row only: a column reads from the top, so it has nothing to
   read until the rows above it are filled. A full grid is therefore scored
   identically to before rows could be left empty. */
function scoreRows(rows) {
  let k = 0;
  while (k < 4 && rows[k]) k++;
  const top = E.scorePlacement(rows.slice(0, k).map((r) => r.word), S.layout, isWord);
  const out = [null, null, null, null];
  top.rows.forEach((d, i) => { out[i] = d; });
  let total = top.total;
  for (let r = k + 1; r < 4; r++) {
    if (!rows[r]) continue;
    const across = E.scorePlacement([rows[r].word], [S.layout[r]], isWord).total;
    out[r] = { word: rows[r].word, across, downs: [], total: across };
    total += across;
  }
  return { total, rows: out };
}
function currentScore() { return scoreRows(S.rows); }

function paintScore() {
  $("score").textContent = currentScore().total.toLocaleString();
}

/* What would the pencilled word be worth, inked into the target row? */
function preview() {
  const word = S.staged.map((id) => tileById(id).ch).join("");
  const vn = $("vnote");
  $("btnPlay").disabled = true;
  if (S.ended) { vn.className = ""; vn.textContent = " "; return; }
  if (inArrange()) {
    vn.className = "";
    vn.textContent = "All sixteen down. Drag a word up or down to try another order, then Finish.";
    return;
  }

  if (S.staged.length < 4) {
    vn.className = "";
    vn.textContent = S.staged.length === 0
      ? (filledCount() === 0 ? "Tap four tiles. Tap a row to aim elsewhere." : "Tap four tiles.")
      : `${4 - S.staged.length} more.`;
    return;
  }
  if (!FOUR_SET.has(word)) {
    vn.className = "bad";
    vn.textContent = `${word.toUpperCase()} is not in the word list.`;
    return;
  }
  const r = S.target;
  const before = currentScore();
  const rows = S.rows.slice();
  rows[r] = { word, ids: S.staged.slice() };
  const after = scoreRows(rows);
  const gain = after.total - before.total;
  /* Every column that comes good, including ones below this row that were
     waiting on it to fill a gap. */
  let downs = 0;
  for (let i = r; i < 4; i++) {
    const was = new Set(((before.rows[i] || {}).downs || []).map((d) => d.col));
    for (const d of ((after.rows[i] || {}).downs || [])) if (!was.has(d.col)) downs++;
  }
  vn.className = "";
  vn.innerHTML = `${word.toUpperCase()} <span class="pts">+${gain}</span>` +
    (downs ? ` · ${downs} column${downs > 1 ? "s" : ""} down` : "");
  $("btnPlay").disabled = false;
}

/* Offered from the moment the first tile is tapped, and gone once used or once
   the game is over. The 20 points are the regulator, not the timing. */
function paintExtras() {
  $("extraBtns").style.display =
    (!S.ended && !inArrange() && (!S.helped || stuckLeaving) && (S.running || S.ms > 0)) ? "flex" : "none";
  /* Once the sixteen are down the play controls make no sense, and the end
     card can be closed. The page must still have a way back to the score. */
  const arr = inArrange();
  $("verdict").style.display = S.ended ? "none" : "";
  /* During GuffBot's turn the tray shows his hand, until it is empty. */
  $("tray").style.display = ((S.ended && !show) || arr || (show && filledCount() === 4)) ? "none" : "";
  $("playBtns").style.display = (S.ended || arr) ? "none" : "";
  $("arrangeBtns").style.display = arr ? "flex" : "none";
  $("doneBtns").style.display = S.ended ? "flex" : "none";
  $("board").classList.toggle("arrange", arr);
}
/* GuffBot lives on the I'm stuck button. When it is pressed he shrugs, and the
   button waits for the shrug to finish before it goes. Not saved: it is a moment,
   not state. */
let stuckLeaving = false;
function stuckShrug() {
  const b = $("btnStuck");
  stuckLeaving = true;
  b.classList.add("shrug");
  setTimeout(() => { stuckLeaving = false; b.classList.remove("shrug"); paintExtras(); }, 650);
}

function repaint() {
  paintBoard(); paintTray(); paintScore(); preview(); paintExtras();
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

/* A tapped tile goes straight onto the board, pencilled into the target row. */
function stage(id) {
  if (S.ended || S.target == null) return;
  startClock();
  if (S.staged.includes(id)) return;
  if (placedIds().has(id)) return;
  if (S.staged.length >= 4) return;
  S.staged.push(id);
  paintTray(); paintBoard(); preview(); paintExtras();
  if (!CALM.matches) {
    const t = $("board").children[S.target * 4 + S.staged.length - 1].querySelector(".tile");
    if (t) t.classList.add("pop");
  }
}

function unstage(i) {
  if (S.ended) return;
  S.staged.splice(i, 1);
  paintTray(); paintBoard(); preview();
}

function clearStage() {
  S.staged = [];
  paintTray(); paintBoard(); preview();
}

/* Shuffling the tray, with a bit of theatre.
 *
 * A shuffle that just repaints is correct and unreadable: sixteen letters swap
 * places at once and you have to re-scan the whole row to find out what
 * happened. So every tile is animated from where it was to where it lands — a
 * FLIP: measure first, repaint, then play the difference backwards — lifted and
 * tilted on the way, and staggered left to right so the eye follows a wave
 * rather than a jump cut. You can see that nothing was taken away, which is the
 * thing a shuffle most needs to say.
 *
 * Every fifth press the tiles take the long way round with a full tumble and
 * the button's arrows go twice round. It changes nothing whatsoever. That is
 * the point of it. */
let mixes = 0;

function mix() {
  if (S.ended || drag) return;
  const tray = $("tray");
  const before = new Map();
  for (const n of tray.children) before.set(n.dataset.id, n.getBoundingClientRect());

  S.order = E.shuffled(S.order, Math.random);
  paintTray();
  save();

  const showy = (++mixes % 5 === 0);
  const btn = $("btnMix");
  btn.classList.remove("spin", "spin-big");
  void btn.offsetWidth;                       // restart the animation, don't queue it
  btn.classList.add(showy ? "spin-big" : "spin");

  if (CALM.matches) return;

  [...tray.children].forEach((n, i) => {
    const from = before.get(n.dataset.id);
    if (!from) return;
    const to = n.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (!dx && !dy) return;
    const turn = showy ? 360 : (dx > 0 ? -15 : 15);
    n.animate([
      { transform: `translate(${dx}px, ${dy}px) rotate(0deg) scale(1)` },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 11}px) rotate(${turn * 0.55}deg) scale(1.12)`,
        offset: 0.55 },
      { transform: "translate(0, 0) rotate(0deg) scale(1)" },
    ], {
      duration: showy ? 620 : 430,
      delay: i * 22,
      easing: "cubic-bezier(.24,1.2,.36,1)",
      fill: "backwards",
    });
  });
}

/* ---------------------------------------------------------------------------
 * Rearranging the tray by hand (28 Sept 2026)
 *
 * Press a tile and drag it: it lifts off the tray, the seat it left shows as an
 * empty hollow, and the others hop aside to make room as you go. Let go and it
 * drops into the hollow with a little squash. A press that does not travel
 * DRAG_START pixels is still a tap and stages the tile exactly as before, so
 * the old way of playing is untouched.
 *
 * Deliberate choices:
 * - A tile only changes seat when the lifted tile's centre is well inside
 *   another tile (SEAT_INSET off every edge). Near a boundary nothing happens,
 *   so the row does not flicker back and forth under a wobbling thumb.
 * - On a phone the tile rides above the thumb (LIFT tile-heights), because a
 *   tile under your thumb is a tile you cannot see. Seat-finding follows the
 *   tile, not the finger, so where it looks like it will land is where it lands.
 * - Rearranging starts the clock, the same as the first tap. Otherwise the rack
 *   could be sorted into four words before the five minutes began.
 * - While a drag is live the tiles are moved, never rebuilt, and the pointer is
 *   captured by the tray itself: iOS stops delivering moves once the element
 *   under the finger leaves the page.
 * ------------------------------------------------------------------------- */
const DRAG_START = 7;      // px of travel before a press is a drag, not a tap
const SEAT_INSET = 0.2;    // share of a tile's width/height that does nothing
const LIFT = 0.8;          // tile-heights above a touching finger
let drag = null;
let swallowClickUntil = 0;

const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} };

function onTrayDown(e) {
  if (S.ended || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
  const n = e.target.closest && e.target.closest("#tray .tile");
  if (!n || n.disabled || n.classList.contains("ghost")) return;
  drag = {
    id: +n.dataset.id, node: n, pid: e.pointerId, touch: e.pointerType !== "mouse",
    x0: e.clientX, y0: e.clientY, lastX: e.clientX, tilt: 0,
    live: false, moved: false, settling: false,
  };
}

function onTrayMove(e) {
  if (!drag || e.pointerId !== drag.pid || drag.settling) return;
  if (!drag.live) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_START) return;
    liftTile();
  }
  e.preventDefault();
  steerFloat(e.clientX, e.clientY);
  findSeat();
}

function onTrayUp(e) {
  if (!drag || e.pointerId !== drag.pid || drag.settling) return;
  if (!drag.live) { drag = null; return; }       // a tap: the click stages it
  swallowClickUntil = performance.now() + 400;
  dropTile();
}

function liftTile() {
  const tray = $("tray");
  const n = drag.node;
  const r = n.getBoundingClientRect();
  drag.live = true;
  drag.w = r.width; drag.h = r.height;
  drag.offX = drag.x0 - r.left;
  drag.offY = drag.y0 - r.top + (drag.touch ? r.height * LIFT : 0);
  try { tray.setPointerCapture(drag.pid); } catch (err) {}
  startClock();

  const f = tileNode(tileById(drag.id), "floating");
  f.setAttribute("aria-hidden", "true");
  f.style.width = r.width + "px";
  f.style.height = r.height + "px";
  f.style.left = r.left + "px";
  f.style.top = r.top + "px";
  document.body.appendChild(f);
  drag.float = f;
  n.classList.add("hole");
  tray.classList.add("sorting");
  buzz(8);
  if (!CALM.matches) {
    /* Rise off the tray rather than teleport above the thumb. */
    f.classList.add("lifting");
    setTimeout(() => f.classList.remove("lifting"), 140);
  }
  requestAnimationFrame(() => f.classList.add("up"));
}

function steerFloat(x, y) {
  const f = drag.float;
  f.style.left = (x - drag.offX) + "px";
  f.style.top = (y - drag.offY) + "px";
  /* Leans into the direction of travel and straightens up when you pause. */
  const v = x - drag.lastX;
  drag.lastX = x;
  drag.tilt = Math.max(-14, Math.min(14, drag.tilt * 0.6 + v * 0.9));
  f.style.setProperty("--tilt", drag.tilt.toFixed(1) + "deg");
  clearTimeout(drag.still);
  drag.still = setTimeout(() => { if (drag && drag.float === f) { drag.tilt = 0; f.style.setProperty("--tilt", "0deg"); } }, 90);
}

/* Layout positions (offsetLeft/Top), not on-screen rects, so a neighbour that
   is still mid-hop cannot be mistaken for the seat it is leaving. */
function findSeat() {
  const tray = $("tray");
  const cx = parseFloat(drag.float.style.left) + drag.w / 2;
  const cy = parseFloat(drag.float.style.top) + drag.h / 2;
  const tr = tray.getBoundingClientRect();
  const ox = tr.left + tray.clientLeft, oy = tr.top + tray.clientTop;
  for (const n of tray.children) {
    if (n === drag.node) continue;
    const L = ox + n.offsetLeft, T = oy + n.offsetTop, W = n.offsetWidth, H = n.offsetHeight;
    const ix = W * SEAT_INSET, iy = H * SEAT_INSET;
    if (cx > L + ix && cx < L + W - ix && cy > T + iy && cy < T + H - iy) {
      reseat(+n.dataset.id);
      return;
    }
  }
}

function reseat(targetId) {
  const tray = $("tray");
  const before = new Map();
  for (const n of tray.children) before.set(n.dataset.id, n.getBoundingClientRect());
  for (const n of tray.children) for (const a of n.getAnimations()) a.cancel();

  const from = S.order.indexOf(drag.id), to = S.order.indexOf(targetId);
  S.order.splice(from, 1);
  S.order.splice(to, 0, drag.id);
  arrangeTray();
  drag.moved = true;
  buzz(4);
  if (CALM.matches) return;

  for (const n of tray.children) {
    if (n === drag.node) continue;
    const a = before.get(n.dataset.id);
    const b = n.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) continue;
    n.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: `translate(${dx * 0.4}px, ${dy * 0.4 - 5}px)`, offset: 0.5 },
      { transform: "translate(0, 0)" },
    ], { duration: 200, easing: "cubic-bezier(.25,1.15,.4,1)" });
  }
}

/* Put the existing tray nodes into S.order without rebuilding any of them. */
function arrangeTray() {
  const tray = $("tray");
  const byId = new Map([...tray.children].map((n) => [+n.dataset.id, n]));
  for (const id of S.order) {
    const n = byId.get(id);
    if (n) tray.appendChild(n);
  }
}

function dropTile() {
  const d = drag;
  d.settling = true;
  clearTimeout(d.still);
  try { $("tray").releasePointerCapture(d.pid); } catch (e) {}
  const f = d.float;
  const done = () => {
    f.remove();
    $("tray").classList.remove("sorting");
    drag = null;
    if (!d.node.isConnected) paintTray();
    else {
      d.node.classList.remove("hole");
      if (!CALM.matches) {
        d.node.classList.add("settle");
        setTimeout(() => d.node.classList.remove("settle"), 320);
      }
    }
    if (d.moved) save();
  };
  if (CALM.matches) { done(); return; }
  const to = d.node.getBoundingClientRect();
  f.classList.remove("up", "lifting");
  f.classList.add("landing");
  f.style.setProperty("--tilt", "0deg");
  f.style.left = to.left + "px";
  f.style.top = to.top + "px";
  setTimeout(done, 170);
}

function placeWord() {
  if (S.staged.length !== 4 || S.ended || S.target == null) return;
  const word = S.staged.map((id) => tileById(id).ch).join("");
  const r = S.target;
  if (!FOUR_SET.has(word)) {
    const cells = $("board").children;
    for (let c = 0; c < 4; c++) {
      const n = cells[r * 4 + c];
      n.classList.add("shake"); setTimeout(() => n.classList.remove("shake"), 360);
    }
    return;
  }
  const before = currentScore();
  S.rows[r] = { word, ids: S.staged.slice() };
  S.staged = [];
  S.target = firstEmpty();
  repaint();
  celebrate(r, before);
  save();
  if (filledCount() === 4) setTimeout(enterArrange, 1100);
}

/* ---------------------------------------------------------------------------
 * The full grid: slide the words into a better order (16 Oct 2026)
 *
 * With all sixteen down the play controls go and Finish takes their place. Any
 * word can be dragged up or down; the others shuffle out of its way. The score
 * pill follows every move, because score is a pure function of the grid, and
 * columns that read as words light up where they stand. A tap on a word still
 * takes it back, exactly as before.
 * ------------------------------------------------------------------------- */
const inArrange = () => !S.ended && !S.watch && filledCount() === 4;

function enterArrange() {
  if (!inArrange()) return;
  S.target = null;
  S.staged = [];
  repaint();
  litColumns();
}

/* Light the columns that read as words, top to bottom, where they stand. */
function litColumns() {
  const cells = $("board").children;
  for (let i = 0; i < 16; i++) cells[i].classList.remove("colword");
  if (filledCount() !== 4) return;
  const sc = currentScore();
  for (let r = 0; r < 4; r++) for (const d of ((sc.rows[r] || {}).downs || [])) {
    if (d.word.length !== 4) continue;
    for (let i = 0; i <= r; i++) cells[i * 4 + d.col].classList.add("colword");
  }
}

function moveRow(from, to) {
  if (!inArrange() || from === to || from < 0 || to < 0 || from > 3 || to > 3) return;
  const before = currentScore();
  const rows = S.rows.slice();
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  S.rows = rows;
  repaint();
  litColumns();
  const after = currentScore();
  const gain = after.total - before.total;
  const vn = $("vnote");
  vn.className = "";
  vn.innerHTML = gain === 0 ? `${after.total.toLocaleString()} points. Same as before.`
    : `${after.total.toLocaleString()} points <span class="${gain > 0 ? "pts" : "neg"}">${gain > 0 ? "+" : ""}${gain}</span>`;
  save();
}

let rowDrag = null;
function onBoardDown(e) {
  if (!inArrange() || e.button > 0) return;
  const cell = e.target.closest(".cell");
  if (!cell) return;
  const r = +cell.dataset.r;
  if (!S.rows[r]) return;
  const cells = $("board").children;
  const rowH = cells[4].getBoundingClientRect().top - cells[0].getBoundingClientRect().top;
  rowDrag = { start: r, at: r, y: e.clientY, rowH, moved: false, id: e.pointerId };
  try { $("board").setPointerCapture(e.pointerId); } catch (x) {}
}
function onBoardMove(e) {
  if (!rowDrag || e.pointerId !== rowDrag.id) return;
  const dy = e.clientY - rowDrag.y;
  if (!rowDrag.moved && Math.abs(dy) < 8) return;
  rowDrag.moved = true;
  e.preventDefault();
  const want = Math.max(0, Math.min(3, rowDrag.start + Math.round(dy / rowDrag.rowH)));
  if (want !== rowDrag.at) { moveRow(rowDrag.at, want); rowDrag.at = want; }
  const off = dy - (rowDrag.at - rowDrag.start) * rowDrag.rowH;
  const cells = $("board").children;
  for (let i = 0; i < 16; i++) {
    const t = cells[i].querySelector(".tile");
    if (!t) continue;
    const mine = Math.floor(i / 4) === rowDrag.at;
    t.classList.toggle("lift", mine);
    t.style.transform = mine ? `translateY(${off}px) scale(1.04)` : "";
  }
}
function onBoardUp(e) {
  if (!rowDrag || e.pointerId !== rowDrag.id) return;
  const d = rowDrag; rowDrag = null;
  const cells = $("board").children;
  for (let i = 0; i < 16; i++) {
    const t = cells[i].querySelector(".tile");
    if (t) { t.classList.remove("lift"); t.style.transform = ""; }
  }
  /* With the pointer captured, the click lands on the board rather than the
     cell, so the tap is handled here: a press that did not move takes the word
     back, exactly as before; a drag does not. */
  swallowClickUntil = performance.now() + 400;
  if (d.moved) litColumns();
  else takeBack(d.start);
}

/* The word's tiles go back to the hand and its row is left empty and becomes
   the target, so you can retype into the same seat. Nothing else moves. */
function takeBack(r) {
  if (S.ended || !S.rows[r]) return;
  startClock();
  S.rows[r] = null;
  S.takebacks++;
  S.staged = [];
  S.target = r;
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

/* Filling a gap can bring columns good further down as well, so every row from
   this one to the bottom is checked against how it stood before. */
function celebrate(r, before) {
  const cells = $("board").children;
  const after = currentScore();
  const detail = after.rows[r];
  if (!detail) return;
  for (let c = 0; c < 4; c++) cells[r * 4 + c].querySelector(".tile")?.classList.add("ink");
  $("board").style.position = "relative";
  chipAt(cells[r * 4 + 3], `+${detail.across}`, "across", 120);

  let k = 0;
  for (let rr = r; rr < 4; rr++) {
    const row = after.rows[rr];
    if (!row) continue;
    const was = new Set((((before && before.rows[rr]) || {}).downs || []).map((d) => d.col));
    for (const d of row.downs) {
      if (rr !== r && was.has(d.col)) continue;
      const delay = 460 + (k++) * 260;
      for (let i = 0; i <= rr; i++) {
        const cell = cells[i * 4 + d.col];
        setTimeout(() => {
          cell.classList.add("downlit");
          setTimeout(() => cell.classList.remove("downlit"), 900);
        }, delay);
      }
      const label = d.word.length === 4 ? `↓ ${d.word.toUpperCase()} +${d.score} ×2` : `↓ +${d.score}`;
      chipAt(cells[rr * 4 + d.col], label, "down", delay);
    }
  }
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
  const used = placedIds();
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
  stuckShrug();
  let removed = 0;
  let pick = null;
  while (true) {
    const { left, counts } = remainingCounts();
    const list = E.makeableWords(left, FOUR_LIST);
    const need = 4 - filledCount();
    pick = list.find((w) => completable(minus(counts, w), list, need - 1));
    if (pick || !filledCount()) break;
    /* the lowest word on the grid goes first */
    for (let r = 3; r >= 0; r--) if (S.rows[r]) { S.rows[r] = null; break; }
    S.takebacks++;
    removed++;
  }
  S.helped = true;
  S.staged = [];
  if (S.target == null || S.rows[S.target]) S.target = firstEmpty();
  if (!pick) {   /* cannot happen with a generated day; say something true anyway */
    repaint();
    $("vnote").className = "bad";
    $("vnote").textContent = "Nothing fits these tiles.";
    return;
  }
  const used = placedIds();
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
 * What happened yesterday
 *
 * A daily game with no memory is a game you have no particular reason to come
 * back to. This is one localStorage key holding {date, score, percent} per day:
 * enough for a streak, a personal best and a count, and nothing else.
 *
 * Recorded from showCard rather than finish, and keyed on the date, so it is
 * idempotent — reloading a finished day rewrites the same row rather than
 * inflating anything.
 * ------------------------------------------------------------------------- */
const HISTORY_KEY = "hexadec-history";

function shiftDate(iso, days) {
  return new Date(Date.parse(iso + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
}
function readHistory() {
  try {
    const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(a)) return [];
    return a.filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.d) && typeof e.s === "number");
  } catch (e) { return []; }
}
function recordDay(score, pct) {
  const h = readHistory().filter((e) => e.d !== S.date);
  h.push({ d: S.date, s: score, p: pct });
  h.sort((a, b) => (a.d < b.d ? -1 : 1));
  const kept = h.slice(-HISTORY_DAYS);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(kept)); } catch (e) {}
  return kept;
}
/* Consecutive days up to and including today. */
function streakOf(h) {
  const days = new Set(h.map((e) => e.d));
  let n = 0, d = S.date;
  while (days.has(d)) { n++; d = shiftDate(d, -1); }
  return n;
}
function bestOf(h) { return h.reduce((m, e) => Math.max(m, e.s), 0); }

/* ---------------------------------------------------------------------------
 * Saving
 * ------------------------------------------------------------------------- */
const KEY = () => "hexadec-" + S.date;
function save() {
  try {
    localStorage.setItem(KEY(), JSON.stringify({
      v: 2, rows: S.rows.map((r) => (r ? r.ids : null)), ms: elapsedMs(),
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
  /* v1 (before 10 Oct 2026) kept the words as a list from the top, with no
     gaps; v2 keeps all four rows, null where a row is empty. */
  if (!d || (d.v !== 1 && d.v !== 2) || !Array.isArray(d.rows) || d.rows.length > 4) return false;
  const seen = new Set();
  const rows = [null, null, null, null];
  for (let r = 0; r < d.rows.length; r++) {
    const ids = d.rows[r];
    if (ids == null && d.v === 2) continue;
    if (!Array.isArray(ids) || ids.length !== 4) return false;
    for (const id of ids) {
      if (typeof id !== "number" || id < 0 || id > 15 || seen.has(id)) return false;
      seen.add(id);
    }
    const word = ids.map((i) => S.tiles[i].ch).join("");
    if (!FOUR_SET.has(word)) return false;
    rows[r] = { word, ids };
  }
  S.rows = rows;
  S.target = firstEmpty();
  if (Array.isArray(d.order) && d.order.length === 16) S.order = d.order;
  S.ms = typeof d.ms === "number" && d.ms >= 0 ? d.ms : 0;
  S.helped = !!d.helped;
  S.takebacks = d.takebacks | 0;
  S.ended = !!d.ended;
  return true;
}

/* ---------------------------------------------------------------------------
 * Finishing
 * ------------------------------------------------------------------------- */
function finish() {
  if (S.watch) return;   // someone else's board: no card, no history, no report
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
  detail.rows.forEach((row, r) => row && row.downs.forEach((d) => {
    if (d.word.length === 4) for (let i = 0; i < 4; i++) full.add(i * 4 + d.col);
  }));
  const out = [];
  for (let r = 0; r < 4; r++) {
    let line = "";
    for (let c = 0; c < 4; c++) {
      if (full.has(r * 4 + c)) { line += "\u{1F7EA}"; continue; }
      const code = S.layout[r][c];
      const lm = code === "d" ? 2 : code === "t" ? 3 : 1;
      const v = S.rows[r] ? E.letterValue(S.rows[r].word[c]) * lm : 0;
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
  const streak = streakOf(readHistory());
  if (streak > 1) bits.push("", `${streak} days running`);
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

  const downs = detail.rows.filter(Boolean).flatMap((r) => r.downs);
  const fulls = downs.filter((d) => d.word.length === 4);

  const rowLines = detail.rows.filter(Boolean).map((r, i) =>
    `<code>${r.word.toUpperCase()}</code> ${r.total}` +
    (r.downs.length ? ` <span class="muted">(${r.downs.map((d) => "↓" + d.word.toUpperCase() + " " + d.score).join(" ")})</span>` : "")
  ).join("<br>");

  const history = recordDay(finalScore(), pct);
  const streak = streakOf(history);
  const best = bestOf(history);

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
    <div class="breakdown" id="dayStats"></div>
    <div class="tally">
      ${streak > 1 ? `<span><b>${streak}</b> day streak</span>` : ""}
      <span>Best <b>${best.toLocaleString()}</b></span>
      <span><b>${history.length}</b> played</span>
    </div>
    <div class="wordlist">${rowLines}</div>
    ${downs.length ? `<div class="muted" style="margin-top:6px">${downs.length} column word${downs.length > 1 ? "s" : ""}${fulls.length ? `, ${fulls.length} of them the full four` : ""}.</div>` : '<div class="muted" style="margin-top:6px">No columns came good. That is where the points hide.</div>'}
    <div class="row-btns" style="margin-top:14px">
      <button class="btn primary" id="btnShare">Share score</button>
      <button class="btn small" id="btnBest"><span class="bot" aria-hidden="true"><img class="gbimg" src="/guffbot.webp" alt="" width="20" height="20"></span> GuffBot's best</button>
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
  /* The card is up. Nothing below may take it down again: each extra is on
     its own, so one failing leaves the score on screen. */
  const extras = [
    () => $("btnShare").addEventListener("click", doShare),
    () => $("btnBest").addEventListener("click", guffbotShow),
    () => $("subForm").addEventListener("submit", subscribe),
    () => paintDayStats(),
    () => barToEnd(),
    () => tickNext(),
  ];
  for (const f of extras) { try { f(); } catch (e) { console.error(e); } }
  paintExtras();
}

/* ---------------------------------------------------------------------------
 * GuffBot's turn (31 Oct 2026)
 *
 * The best line used to be a line of plain text on the end card. Now the card
 * steps aside and GuffBot plays it on the real board: your tiles go back to the
 * tray, his four words fly up one at a time with the usual chips, and then he
 * slides the rows into the best order while the score climbs. He says ooh and
 * aah as he goes. Nothing he does is saved or reported; when he is done your
 * own grid comes back and the card reopens.
 *
 * Why the order matters: the search finds the four words AND the row order
 * that pays most. So he lands them in the WORST order first and tidies up,
 * which is the part that shows where the hidden points were.
 * ------------------------------------------------------------------------- */
let show = null;           // { rows, order, best, bestWords, timers:[] }
let showSpeed = 1;         // tests run it at a fraction of the pace

const OOHS = ["Ooh.", "Aah.", "Ooh, nice.", "Mm, lovely.", "Oh I say.", "Aah, look at that."];
const sayLine = (() => { let i = Math.floor(Math.random() * OOHS.length); return () => OOHS[i++ % OOHS.length]; })();

function wait(ms) {
  return new Promise((res) => {
    const t = setTimeout(res, ms * showSpeed);
    if (show) show.timers.push(t);
  });
}

function say(text, big) {
  let b = $("gbsay");
  if (!b) {
    b = el("div", "gbsay");
    b.id = "gbsay";
    b.innerHTML = `<img class="gbface" src="/guffbot.webp" alt="GuffBot" width="44" height="44"><div class="bubble" aria-live="polite"></div>`;
    $("boardwrap").before(b);
  }
  b.style.display = "flex";
  const bub = b.querySelector(".bubble");
  bub.innerHTML = text;
  bub.classList.toggle("big", !!big);
  if (!CALM.matches) {
    const face = b.querySelector(".gbface");
    face.classList.remove("nod"); void face.offsetWidth; face.classList.add("nod");
  }
}

/* The row order that pays LEAST for these four words, so the tidy-up has
   somewhere to go. Falls back to the best order reversed if they all tie. */
function worstOrder(words) {
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  let worst = null, low = Infinity;
  for (const p of perms(words)) {
    const s = E.scorePlacement(p, S.layout, isWord).total;
    if (s < low) { low = s; worst = p; }
  }
  if (!worst || worst.join() === words.join()) worst = words.slice().reverse();
  return worst;
}

async function guffbotShow() {
  if (show || !S.ended || S.watch) return;
  const rack = S.tiles.map((t) => t.ch).join("");
  const list = E.makeableWords(rack, FOUR_LIST);
  const { best, bestWords } = E.maximise(rack, list, S.layout, isWord);
  if (!bestWords) return;
  const mine = currentScore().total;

  show = { rows: S.rows, order: S.order, best, bestWords, timers: [] };
  $("overlay").classList.remove("on");
  emptyRows();
  S.target = null;
  S.staged = [];
  S.order = S.tiles.map((t) => t.id);
  document.body.classList.add("gbshow");
  repaint();
  $("board").style.position = "relative";
  let btn = $("btnShowDone");
  if (!btn) {
    btn = el("button", "btn small", "Back to my score");
    btn.id = "btnShowDone";
    btn.addEventListener("click", endShow);
    $("doneBtns").appendChild(btn);
  }
  $("doneBtns").style.display = "flex";
  $("btnResult").style.display = "none";
  btn.style.display = "";

  const calm = CALM.matches;
  const start = worstOrder(bestWords);

  try {
    say("Right. Watch this.");
    await wait(calm ? 300 : 1100);

    /* the four words, worst order first */
    for (let r = 0; r < 4; r++) {
      const word = start[r];
      const before = currentScore();
      for (const ch of word) {
        const used = placedIds();
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
        if (!t) throw new Error("tile missing");
        if (!calm) await flyToBoard(t.id, r, S.staged.length);
        S.staged.push(t.id);
        S.target = r;
        paintTray(); paintBoard();
        if (!calm) await wait(210);
      }
      S.rows[r] = { word, ids: S.staged.slice() };
      S.staged = [];
      S.target = null;
      repaint();
      if (!calm) {
        celebrate(r, before);
        const downs = (currentScore().rows[r] || { downs: [] }).downs.length;
        say(downs ? `${sayLine()} A column.` : sayLine());
        await wait(downs ? 1500 : 1000);
      }
    }

    /* the tidy-up: rows slide into the best order, one at a time */
    if (currentScore().total !== best) {
      say("Now then. Let's get these in order.");
      await wait(calm ? 200 : 1300);
      for (let i = 0; i < 4; i++) {
        const j = S.rows.findIndex((row) => row && row.word === bestWords[i]);
        if (j === i) continue;
        const was = currentScore().total;
        if (calm) {
          const rows = S.rows.slice(); const [row] = rows.splice(j, 1); rows.splice(i, 0, row); S.rows = rows;
          repaint();
        } else {
          await slideRow(j, i);
        }
        const now = currentScore().total;
        const gain = now - was;
        say(`${sayLine()} <span class="${gain >= 0 ? "pts" : "neg"}">${gain >= 0 ? "+" : ""}${gain}</span>`);
        await wait(calm ? 150 : 1300);
      }
    }
    litColumns();
    const pct = Math.round(mine / best * 100);
    say(`<b>${best.toLocaleString()}</b>. Every point there was.<br>` +
      (mine >= best ? "And you found the lot. Take a bow." : `You found ${mine.toLocaleString()}, which is ${pct}% of it.`), true);
  } catch (e) {
    console.error(e);
    endShow();
  }
}

/* A tile lifts out of the tray and flies to its square. */
function flyToBoard(id, r, c) {
  return new Promise((res) => {
    const from = $("tray").querySelector(`.tile[data-id="${id}"]`);
    const cell = $("board").children[r * 4 + c];
    if (!from || !cell) return res();
    const a = from.getBoundingClientRect(), b = cell.getBoundingClientRect();
    const f = tileNode(tileById(id), "floating up");
    f.setAttribute("aria-hidden", "true");
    f.style.left = a.left + "px"; f.style.top = a.top + "px";
    f.style.width = a.width + "px"; f.style.height = a.height + "px";
    f.style.transition = "none";
    document.body.appendChild(f);
    from.style.visibility = "hidden";
    const anim = f.animate([
      { transform: "translate(0,0) scale(1) rotate(0deg)" },
      { transform: `translate(${(b.left - a.left) * 0.5}px, ${(b.top - a.top) * 0.5 - 30}px) scale(1.25) rotate(${c % 2 ? 8 : -8}deg)`, offset: 0.55 },
      { transform: `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width}) rotate(0deg)` },
    ], { duration: 380 * showSpeed, easing: "cubic-bezier(.3,.9,.4,1)", fill: "forwards" });
    anim.onfinish = () => { f.remove(); res(); };
  });
}

/* Row j slides to seat i; the rows between shuffle to make room. FLIP on the
   tiles, with the moving row lifted and the others gliding. */
function slideRow(j, i) {
  return new Promise((res) => {
    const cells = $("board").children;
    const before = new Map();
    for (let k = 0; k < 16; k++) {
      const t = cells[k].querySelector(".tile");
      if (t) before.set(t.dataset.id, t.getBoundingClientRect());
    }
    const moving = new Set((S.rows[j] || { ids: [] }).ids.map(String));
    const rows = S.rows.slice(); const [row] = rows.splice(j, 1); rows.splice(i, 0, row); S.rows = rows;
    repaint();
    let n = 0, done = 0;
    for (let k = 0; k < 16; k++) {
      const t = cells[k].querySelector(".tile");
      if (!t) continue;
      const a = before.get(t.dataset.id); if (!a) continue;
      const b = t.getBoundingClientRect();
      const dy = a.top - b.top;
      if (!dy) continue;
      n++;
      const lift = moving.has(t.dataset.id);
      t.style.zIndex = lift ? 5 : 1;
      const an = t.animate(lift ? [
        { transform: `translateY(${dy}px) scale(1)`, boxShadow: "0 1px 0 #d9c7a6,0 2px 4px rgba(70,45,20,.26)" },
        { transform: `translateY(${dy * 0.5}px) scale(1.08)`, boxShadow: "0 6px 0 #d9c7a6,0 16px 22px rgba(70,45,20,.3)", offset: 0.5 },
        { transform: "translateY(0) scale(1)", boxShadow: "0 1px 0 #d9c7a6,0 2px 4px rgba(70,45,20,.26)" },
      ] : [
        { transform: `translateY(${dy}px)` }, { transform: "translateY(0)" },
      ], { duration: (lift ? 620 : 480) * showSpeed, easing: "cubic-bezier(.25,1.1,.4,1)", delay: (lift ? 0 : 80) * showSpeed, fill: "backwards" });
      an.onfinish = () => { t.style.zIndex = ""; if (++done === n) res(); };
    }
    if (!n) res();
  });
}

function endShow() {
  if (!show) return;
  for (const t of show.timers) clearTimeout(t);
  for (const f of document.querySelectorAll(".tile.floating")) f.remove();
  S.rows = show.rows;
  S.order = show.order;
  S.staged = [];
  S.target = null;
  show = null;
  document.body.classList.remove("gbshow");
  const b = $("gbsay"); if (b) b.style.display = "none";
  const btn = $("btnShowDone"); if (btn) btn.style.display = "none";
  $("btnResult").style.display = "";
  for (const c of $("board").children) c.classList.remove("colword");
  repaint();
  showCard();
}

/* The day's average, from the Worker's own /api/day. Aggregates only, cached a
   minute, and public. Held back until a few people have played, because "1
   person has played today, averaging 166" is you, and telling someone their
   score is exactly average when they are the only player is worse than silence.
   Any failure leaves the line empty: on the static dev server it 404s. */
async function paintDayStats() {
  const node = $("dayStats");
  if (!node) return;
  try {
    const res = await fetch(`/api/day?date=${encodeURIComponent(S.date)}`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d || !d.players || d.players < 3 || d.avgScore == null) return;
    const mine = finalScore();
    const how = mine > d.avgScore ? "You are above it."
      : mine < d.avgScore ? "You are below it." : "Bang on it.";
    node.innerHTML = `${d.players} people have played today, averaging <b>${d.avgScore}</b>. ${how}`;
  } catch (e) { /* silence is the correct failure */ }
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
        date: S.date, complete: filledCount() === 4 ? 1 : 0,
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
      date: S.date,
      score: Math.min(9999, total), max: LEAGUE_MAX,
      perfect: words >= S.max,   // every point on the board: the bar throws a party (5 Oct 2026)
      display: `${total.toLocaleString()} · ${pct}%`,
      // The finished grid goes with the score (6 Oct 2026): four rows of tile
      // numbers. The day's tiles and layout come from the date, so this is all
      // the league needs to draw the board again. Only when the grid is whole.
      replay: filledCount() === 4 ? { v: 1, rows: S.rows.map((r) => r.ids) } : undefined,
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
 * Typing
 *
 * On a laptop the natural thing is to type the word, so let people. A letter
 * takes the first matching tile still in the tray, backspace gives the last one
 * back, enter places, escape clears. Ignored while a text field has focus or
 * the end card is up.
 * ------------------------------------------------------------------------- */
function onKey(e) {
  if (S.ended || drag || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("overlay").classList.contains("on")) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

  const k = e.key;
  if (inArrange()) {
    /* a focused word moves with the arrows; enter finishes */
    const cell = t && t.closest ? t.closest(".cell") : null;
    const r = cell ? +cell.dataset.r : -1;
    if ((k === "ArrowUp" || k === "ArrowDown") && r >= 0) {
      const to = r + (k === "ArrowUp" ? -1 : 1);
      moveRow(r, to);
      const n = $("board").children[Math.max(0, Math.min(3, to)) * 4 + (+cell.dataset.c)];
      if (n) n.focus();
      e.preventDefault();
    } else if (k === "Enter" && !cell) { finish(); e.preventDefault(); }
    return;
  }
  if (/^[a-zA-Z]$/.test(k)) {
    if (S.staged.length >= 4) return;
    const ch = k.toLowerCase();
    const placed = placedIds();
    const id = S.order.find((i) =>
      !placed.has(i) && !S.staged.includes(i) && tileById(i).ch === ch);
    if (id == null) return;
    stage(id);
    e.preventDefault();
    return;
  }
  if (k === "ArrowUp" || k === "ArrowDown") {
    /* move the target to the next empty row that way */
    const step = k === "ArrowUp" ? -1 : 1;
    for (let r = (S.target == null ? 0 : S.target) + step; r >= 0 && r < 4; r += step) {
      if (!S.rows[r]) { setTarget(r); break; }
    }
    e.preventDefault();
    return;
  }
  if (k === "Backspace") {
    if (S.staged.length) unstage(S.staged.length - 1);
    e.preventDefault();
  } else if (k === "Enter") {
    if (!$("btnPlay").disabled) placeWord();
    e.preventDefault();
  } else if (k === "Escape") {
    if (S.staged.length) clearStage();
    e.preventDefault();
  }
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

/* One-off NEW cards, each seen once by each returning player on their next
   visit, whenever that is. Never on a day already finished. Someone who has
   never played before gets no card (to them nothing is new, and there is no
   first-visit rules panel either); they are simply marked as told so it cannot
   surprise them later. Skipped under automation (navigator.webdriver) so
   npm run ui is not left clicking at a card that covers the tray.

   28 Sept 2026: rearranging the rack. 10 Oct 2026: tiles go straight onto the
   board and any row can be aimed at, which replaces the rack card: anyone who
   never saw that one learns about dragging from this one's last line. */
const NEWS_KEY = "hexadec-news-arrange";
function newsCard(returning) {
  if (S.ended || navigator.webdriver) return;
  try {
    if (localStorage.getItem(NEWS_KEY)) return;
    localStorage.setItem(NEWS_KEY, "1");
  } catch (e) { return; }
  if (!returning) return;
  $("cardBody").innerHTML = `
    <div class="news">
      <span class="newtag">NEW</span>
      <h1>Shuffle your rows</h1>
      <p>The sixteenth tile no longer ends the game. With the grid full, drag any
      word up or down to try another order: the same words on different rows
      catch different squares and make different columns. The score follows every
      move.</p>
      <p class="muted">Tap <b>Finish</b> when you're happy. The clock keeps running, so don't dawdle.</p>
      <button class="btn primary" id="btnNews">Lovely, let me at it</button>
    </div>`;
  $("overlay").classList.add("on");
  $("btnNews").addEventListener("click", () => $("overlay").classList.remove("on"));
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

  let returning = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("hexadec-") && !k.startsWith("hexadec-news-")) { returning = true; break; }
    }
  } catch (e) {}
  if (/[?&]watch=/.test(location.search)) { startWatch(); return; }
  restore();
  $("dateline").textContent = new Date(S.date + "T12:00:00")
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  repaint();

  $("btnPlay").addEventListener("click", placeWord);
  $("btnClear").addEventListener("click", clearStage);
  $("btnMix").addEventListener("click", mix);
  const tray = $("tray");
  tray.addEventListener("pointerdown", onTrayDown);
  window.addEventListener("pointermove", onTrayMove, { passive: false });
  window.addEventListener("pointerup", onTrayUp);
  window.addEventListener("pointercancel", onTrayUp);
  /* The press that ended a drag must not also stage the tile. */
  tray.addEventListener("click", (e) => {
    if (performance.now() < swallowClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  $("btnStuck").addEventListener("click", useStuck);
  $("btnResult").addEventListener("click", finish);
  $("linkHome").addEventListener("click", (e) => { e.preventDefault(); homeScreenCard(); });
  $("btnClose").addEventListener("click", () => {
    $("overlay").classList.remove("on");
    if (S.ended) barToPage();
  });

  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", () => setTimeout(fit, 120));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { stopClock(); save(); }
  });
  /* A backstop for the button's visibility; every interaction paints it too. */
  setInterval(() => { if (!S.ended) paintExtras(); }, 2000);

  $("btnFinish").addEventListener("click", finish);
  const board = $("board");
  board.addEventListener("pointerdown", onBoardDown);
  board.addEventListener("pointermove", onBoardMove, { passive: false });
  board.addEventListener("pointerup", onBoardUp);
  board.addEventListener("pointercancel", onBoardUp);
  board.addEventListener("click", (e) => {
    if (performance.now() < swallowClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  if (S.ended) { finish(); }
  else if (filledCount() === 4) { enterArrange(); newsCard(returning); }
  else newsCard(returning);
}

/* ---------------------------------------------------------------------------
 * Looking at someone else's finished board (6 Oct 2026)
 *
 * ?watch=<date>.<INI> from the league's all-time greats. Hexadec's replay is the
 * final grid only (Carl: not much fun in watching the video of this one), so
 * there is no playback: guff-watch.js (on the hub) fetches the board, applies
 * the spoiler rule and runs the bar; this draws that day's grid with their four
 * words on it, each row's points beneath. Nothing is saved or reported.
 * ------------------------------------------------------------------------- */
function loadWatch() {
  return new Promise((res, rej) => {
    if (window.GuffWatch) return res(window.GuffWatch);
    const sc = document.createElement("script");
    sc.src = "https://guff.carl-b82.workers.dev/guff-watch.js";
    sc.onload = () => res(window.GuffWatch); sc.onerror = rej;
    document.head.appendChild(sc);
  });
}
function startWatch() {
  document.body.classList.add("iswatch");
  loadWatch().then((GW) => {
    GW.run({
      game: "hexadec", name: "Hexadec", still: true,
      played: (date) => {
        try { const d = JSON.parse(localStorage.getItem("hexadec-" + date)); return !!(d && (d.ended || (d.rows && d.rows.filter(Boolean).length === 4))); }
        catch (e) { return false; }
      },
      begin(data) {
        const ids = data.replay && Array.isArray(data.replay.rows) ? data.replay.rows : [];
        S.date = data.date;
        if (!loadDay()) throw new Error("no such day");
        S.watch = data.initials; S.ended = true; emptyRows(); S.target = null;
        ids.slice(0, 4).forEach((r, i) => { S.rows[i] = { ids: r, word: r.map((k) => S.tiles[k].ch).join("") }; });
        dressCloth(S.idx); fit(); buildBoard(); S.staged = [];
        $("dateline").textContent = new Date(data.date + "T12:00:00")
          .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
        repaint();
        const detail = currentScore(), pct = Math.round(detail.total / S.max * 100);
        let sum = $("watchSum");
        if (!sum) { sum = el("div", ""); sum.id = "watchSum"; $("boardwrap").after(sum); }
        sum.innerHTML = detail.rows.filter(Boolean).map((r) =>
          `<code>${r.word.toUpperCase()}</code> ${r.total}` +
          (r.downs.length ? ` <span class="muted">(${r.downs.map((d) => "↓" + d.word.toUpperCase() + " " + d.score).join(" ")})</span>` : "")
        ).join("<br>") +
          `<div class="muted" style="margin-top:6px">${detail.total} on the grid, ${pct}% of the best possible ${S.max}.</div>`;
        GW.note("");
        return 0;
      },
      finish() {},
    });
  }).catch(() => {
    document.body.classList.remove("iswatch");
    toast("The replay player didn't load. Try again in a moment.");
  });
}

/* Test and tooling hook, in the family style. */
window.__hx = {
  S, E, isWord, FOUR_LIST, currentScore, placeWord, stage, unstage, takeBack, setTarget, useStuck,
  dragging: () => !!drag, placedIds, filledCount, moveRow, inArrange,
  guffbotShow, endShow, showing: () => !!show, setShowSpeed: (x) => { showSpeed = x; },
  shareText, finish, timeBonus, penalty, finalScore, state: () => ({
    rows: filledRows().map((r) => r.word), grid: S.rows.map((r) => (r ? r.word : null)),
    target: S.target, score: currentScore().total,
    max: S.max, ended: S.ended, helped: S.helped, takebacks: S.takebacks,
  }),
};

boot();
