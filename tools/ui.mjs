/* tools/ui.mjs — drive the real game in a real browser.
 *
 *   npm run serve      (in one terminal)
 *   npm run ui         (in another)
 *
 * Needs `npm i -D playwright` on the machine. In the Anthropic cloud sandbox
 * the bundled Chromium does not match the npm package's expected revision, so
 * point at it instead of patching this file:
 *
 *   HX_CHROMIUM=/opt/pw-browsers/chromium npm run ui
 *
 * What it checks, in order: that the game boots and lays out without anything
 * falling below the fold on a small phone; that a word can be built, placed and
 * taken back; that score is a pure function of the grid and cannot be farmed by
 * placing and removing; that column bonuses fire; that a finished day survives a
 * reload; that the tray does not reflow while a word is being chosen; that I'm
 * stuck can be used once and costs 20; that shuffling the tray cannot lose
 * a tile or a half-typed word; that dragging tiles to rearrange the tray
 * puts them where they were dropped, is remembered, and leaves a tap a tap;
 * and (10 Oct 2026) that tiles go straight onto the board, any empty row can
 * be aimed at, a take-back leaves a gap, and a finished grid scores exactly as
 * it did when words could only stack from the top.
 */

import { chromium } from "playwright";

const BASE = process.env.HX_BASE || "http://localhost:8787";
const EXEC = process.env.HX_CHROMIUM || undefined;

let failures = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};

const VIEWPORTS = [
  { name: "iPhone SE 375×667", width: 375, height: 667 },
  { name: "small 375×600", width: 375, height: 600 },
  { name: "iPhone 390×844", width: 390, height: 844 },
  { name: "tablet 768×1024", width: 768, height: 1024 },
];

const browser = await chromium.launch({ executablePath: EXEC });

/* ---- 1. layout on every viewport ---------------------------------------- */
console.log("\n1. Layout");
for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(120);

  const box = await page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); return e ? e.getBoundingClientRect().bottom : -1; };
    return {
      tray: r("tray"), play: r("btnPlay"), board: r("board"),
      h: window.innerHeight, cells: document.querySelectorAll("#board .cell").length,
      tiles: document.querySelectorAll("#tray .tile").length,
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      rulesOpen: document.getElementById("rules").open,
      tagline: (document.querySelector(".sub") || {}).textContent,
    };
  });
  console.log(`  ${vp.name}`);
  ok("   16 cells and 16 tiles", box.cells === 16 && box.tiles === 16, `got ${box.cells}/${box.tiles}`);
  ok("   the tagline is there", box.tagline === "Four the win", String(box.tagline));
  ok("   tray on screen", box.tray > 0 && box.tray <= box.h + 1, `tray bottom ${Math.round(box.tray)} of ${box.h}`);
  ok("   Place button on screen", box.play > 0 && box.play <= box.h + 1, `button bottom ${Math.round(box.play)} of ${box.h}`);
  ok("   no sideways scroll", box.scrollW <= box.clientW + 1, `${box.scrollW} > ${box.clientW}`);
  ok("   the instructions stay shut until asked for", !box.rulesOpen);
  ok("   no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

/* ---- 2. playing ---------------------------------------------------------- */
console.log("\n2. Placing, taking back, and the score");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  /* find a word the rack can make, straight from the game's own engine */
  const first = await page.evaluate(() => {
    const { S } = window.__hx;
    return { rack: S.tiles.map((t) => t.ch).join("") };
  });
  ok("sixteen tiles in the rack", first.rack.length === 16, first.rack);

  const played = await page.evaluate(async () => {
    const hx = window.__hx;
    const { S, E } = hx;
    const rack = S.tiles.map((t) => t.ch).join("");
    const words = E.makeableWords(rack, hx.FOUR_LIST);
    const word = words[0];
    if (!word) return { error: "no word" };
    window.__HX_LASTWORD = word;
    const used = new Set();
    for (const ch of word) {
      const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id));
      used.add(t.id); hx.stage(t.id);
    }
    const before = hx.currentScore().total;
    hx.placeWord();
    const after = hx.currentScore().total;
    hx.takeBack(0);
    const back = hx.currentScore().total;
    return { word, before, after, back, rows: hx.filledCount(), takebacks: S.takebacks };
  });

  ok("a word was placed", !played.error && played.after > played.before, JSON.stringify(played));
  ok("taking it back returns the score to zero", played.back === 0, JSON.stringify(played));
  ok("taking it back clears the row", played.rows === 0, JSON.stringify(played));
  ok("the take-back was counted", played.takebacks === 1, JSON.stringify(played));

  /* place and remove the same word ten times: the score must not creep */
  const farmed = await page.evaluate(() => {
    const hx = window.__hx; const { S } = hx;
    const scores = [];
    for (let k = 0; k < 10; k++) {
      const rack = S.tiles.map((t) => t.ch).join("");
      const word = (window.__HX_LASTWORD || "");
      if (!word) return { skip: true };
      const used = new Set();
      for (const ch of word) {
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id));
        used.add(t.id); hx.stage(t.id);
      }
      hx.placeWord();
      scores.push(hx.currentScore().total);
      hx.takeBack(0);
    }
    return { scores, zero: hx.currentScore().total };
  });
  if (!farmed.skip) {
    ok("score cannot be farmed by replacing", new Set(farmed.scores).size === 1 && farmed.zero === 0,
      JSON.stringify(farmed));
  }

  ok("no page errors while playing", errors.length === 0, errors.join(" | "));
  await page.close();
}

/* ---- 3. a whole game, then a reload ------------------------------------- */
console.log("\n3. A full game, the end card, and a reload");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  const done = await page.evaluate(() => {
    const hx = window.__hx, { S, E } = hx;
    const rack = S.tiles.map((t) => t.ch).join("");
    const list = E.makeableWords(rack, hx.FOUR_LIST);
    const sols = E.findSolutions(rack, list, 1);
    if (!sols.length) return { error: "no solution" };
    for (const word of sols[0]) {
      const used = hx.placedIds();
      for (const ch of word) {
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
        hx.stage(t.id);
      }
      hx.placeWord();
    }
    hx.finish();
    return {
      rows: hx.filledCount(), score: hx.currentScore().total, max: S.max,
      ended: S.ended, share: hx.shareText(),
    };
  });

  ok("four rows filled", done.rows === 4, JSON.stringify(done).slice(0, 200));
  ok("the game ended", done.ended === true);
  ok("score is at most the computed maximum", done.score <= done.max, `${done.score} > ${done.max}`);
  await page.waitForTimeout(300);
  ok("the end card is showing", await page.isVisible("#card"));
  ok("the end card names a percentage", /% of the best possible/.test(await page.textContent("#cardBody")));

  /* the share text must give away nothing */
  const letters = (done.share || "").replace(/Hexadec|hexadec|carlosfandango|net|https?|of the best possible|on the grid|left on the clock|with a nudge/g, "");
  ok("share text leaks no four-letter word", !done.share.split("\n").some((l) => /^[A-Z]{4}$/.test(l.trim())), done.share);
  ok("share text has the grid art", /[⬜\u{1F7E8}\u{1F7E7}\u{1F7EA}]/u.test(done.share), done.share);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__hx.state());
  ok("the finished game survives a reload", after.ended === true && after.rows.length === 4, JSON.stringify(after));
  ok("the end card comes back", await page.isVisible("#card"));
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

/* ---- 4. the tray must not move under your thumb ------------------------- */
console.log("\n4. The tray holds its shape while you choose");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  const r = await page.evaluate(() => {
    const hx = window.__hx, { S, E } = hx;
    const count = () => document.querySelectorAll("#tray .tile").length;
    const hidden = () => [...document.querySelectorAll("#tray .tile")]
      .filter((n) => getComputedStyle(n).visibility === "hidden").length;
    /* where is the last tray tile, before and after staging? */
    const lastLeft = () => {
      const ns = document.querySelectorAll("#tray .tile");
      return ns.length ? Math.round(ns[ns.length - 1].getBoundingClientRect().left) : -1;
    };
    const before = { n: count(), hidden: hidden(), last: lastLeft() };

    const rack = S.tiles.map((t) => t.ch).join("");
    const word = E.makeableWords(rack, hx.FOUR_LIST)[0];
    const used = new Set();
    for (const ch of word) {
      const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id));
      used.add(t.id); hx.stage(t.id);
    }
    const staged = { n: count(), hidden: hidden(), last: lastLeft() };
    hx.placeWord();
    const placed = { n: count(), hidden: hidden(), last: lastLeft() };
    return { before, staged, placed, word };
  });

  ok("sixteen tiles to start", r.before.n === 16 && r.before.hidden === 0, JSON.stringify(r.before));
  ok("staging four leaves sixteen seats, four of them empty",
    r.staged.n === 16 && r.staged.hidden === 4, JSON.stringify(r.staged));
  ok("nothing shifted while choosing", r.staged.last === r.before.last,
    `last tile moved from ${r.before.last} to ${r.staged.last}`);
  ok("placing the word closes the gaps", r.placed.n === 12 && r.placed.hidden === 0,
    JSON.stringify(r.placed));
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

/* ---- 5. I'm stuck: once, and it costs ----------------------------------- */
console.log("\n5. I'm stuck");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });

  const hiddenAtStart = await page.isHidden("#extraBtns");
  ok("the button is not there before you start", hiddenAtStart);

  const r = await page.evaluate(() => {
    const hx = window.__hx, { S } = hx;
    hx.stage(S.tiles[0].id);                      // starts the clock
    const shown = getComputedStyle(document.getElementById("extraBtns")).display !== "none";
    const label = document.getElementById("btnStuck").textContent.replace(/\s+/g, " ").trim();
    hx.useStuck();
    const first = { staged: S.staged.length, helped: S.helped, penalty: hx.penalty() };
    hx.useStuck();                                 // a second go must do nothing
    const second = { helped: S.helped, penalty: hx.penalty() };
    return { shown, label, first, second };
  });
  /* the button waits for GuffBot's shrug (650ms) before it goes */
  await page.waitForTimeout(800);
  r.gone = await page.evaluate(() => getComputedStyle(document.getElementById("extraBtns")).display === "none");

  ok("it appears once you start playing", r.shown);
  ok("it is labelled I'm stuck and shows the cost", /I'm stuck/.test(r.label) && /20/.test(r.label), r.label);
  ok("it pencils a whole word onto the board", r.first.staged === 4, JSON.stringify(r.first));
  ok("it costs 20", r.first.penalty === 20, JSON.stringify(r.first));
  ok("a second use costs no more", r.second.penalty === 20, JSON.stringify(r.second));
  ok("the button goes away once used", r.gone);

  /* finish the day and check the 20 really comes off the total.
     The nudge above left a word staged; drop it and play a known solution, so
     the only thing under test here is the penalty. */
  const done = await page.evaluate(() => {
    const hx = window.__hx, { S, E } = hx;
    S.staged.length = 0;
    const rack = S.tiles.map((t) => t.ch).join("");
    const sol = E.findSolutions(rack, E.makeableWords(rack, hx.FOUR_LIST), 1)[0];
    for (const word of sol) {
      const used = hx.placedIds();
      for (const ch of word) {
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
        if (t) hx.stage(t.id);
      }
      hx.placeWord();
    }
    hx.finish();
    return {
      rows: hx.filledCount(), words: hx.currentScore().total,
      bonus: hx.timeBonus(), penalty: hx.penalty(), final: hx.finalScore(),
      card: document.getElementById("cardBody").textContent.replace(/\s+/g, " "),
    };
  });
  ok("the day finished", done.rows === 4, JSON.stringify(done).slice(0, 160));
  ok("final = grid + clock − 20", done.final === Math.max(0, done.words + done.bonus - done.penalty),
    JSON.stringify(done));
  ok("the end card owns up to the nudge", /for a nudge/.test(done.card), done.card.slice(0, 200));
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

/* ---- 6. memory, typing, and the things a screen reader needs ------------ */
console.log("\n6. Streak, keyboard, labels and premium pips");
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  /* seed yesterday so today makes it a streak of two */
  await page.addInitScript(() => {
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    localStorage.setItem("hexadec-history", JSON.stringify([{ d: y, s: 999, p: 90 }]));
  });
  await page.goto(BASE, { waitUntil: "networkidle" });

  /* --- tray tiles are real buttons with real labels --- */
  const a11y = await page.evaluate(() => {
    const first = document.querySelector("#tray .tile");
    return {
      tag: first.tagName,
      label: first.getAttribute("aria-label"),
      liveVerdict: document.getElementById("verdict").getAttribute("aria-live"),
    };
  });
  ok("tray tiles are buttons", a11y.tag === "BUTTON", a11y.tag);
  ok("and are labelled with letter and value", /^[A-Z], \d+ points?$/.test(a11y.label || ""), String(a11y.label));
  ok("the verdict is announced", a11y.liveVerdict === "polite", String(a11y.liveVerdict));

  /* --- typing builds the word --- */
  const typed = await page.evaluate(async () => {
    const hx = window.__hx, { S, E } = hx;
    const rack = S.tiles.map((t) => t.ch).join("");
    const word = E.makeableWords(rack, hx.FOUR_LIST)[0];
    window.__W = word;
    return { word };
  });
  for (const ch of typed.word) await page.keyboard.press(ch.toUpperCase());
  let st = await page.evaluate(() => window.__hx.S.staged.map((i) => window.__hx.S.tiles[i].ch).join(""));
  ok("typing the letters pencils the word onto the board", st === typed.word, `${st} vs ${typed.word}`);

  await page.keyboard.press("Backspace");
  st = await page.evaluate(() => window.__hx.S.staged.length);
  ok("backspace gives a letter back", st === 3, String(st));

  await page.keyboard.press("Escape");
  st = await page.evaluate(() => window.__hx.S.staged.length);
  ok("escape clears the lot", st === 0, String(st));

  for (const ch of typed.word) await page.keyboard.press(ch.toUpperCase());
  await page.keyboard.press("Enter");
  const afterEnter = await page.evaluate(() => ({
    rows: window.__hx.filledCount(),
    word: window.__hx.S.rows[0] && window.__hx.S.rows[0].word,
  }));
  ok("enter places it", afterEnter.rows === 1 && afterEnter.word === typed.word, JSON.stringify(afterEnter));

  /* --- a placed tile shows the square it covered --- */
  const pips = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("#board .cell")].slice(0, 4);
    const prem = cells.filter((c) => /dl|tl|dw|tw/.test(c.className)).length;
    const shown = cells.filter((c) => c.querySelector(".tile .prem")).length;
    const label = cells[0].getAttribute("aria-label") || "";
    const role = cells[0].getAttribute("role");
    return { prem, shown, label, role };
  });
  ok("every premium square under row 1 still shows itself",
    pips.shown === pips.prem, `${pips.shown} pips for ${pips.prem} premium squares`);
  ok("a placed row is reachable and explains itself",
    pips.role === "button" && /Take it back/.test(pips.label), `${pips.role} / ${pips.label}`);

  /* --- finish, and check the memory --- */
  const done = await page.evaluate(() => {
    const hx = window.__hx, { S, E } = hx;
    S.staged.length = 0;
    S.rows.fill(null);
    S.target = 0;
    const rack = S.tiles.map((t) => t.ch).join("");
    const sol = E.findSolutions(rack, E.makeableWords(rack, hx.FOUR_LIST), 1)[0];
    for (const w of sol) {
      const used = hx.placedIds();
      for (const ch of w) {
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
        if (t) hx.stage(t.id);
      }
      hx.placeWord();
    }
    hx.finish();
    const h = JSON.parse(localStorage.getItem("hexadec-history") || "[]");
    return {
      entries: h.length,
      today: h[h.length - 1],
      card: document.getElementById("cardBody").textContent.replace(/\s+/g, " "),
      share: hx.shareText(),
      score: hx.finalScore(),
    };
  });
  ok("today was written to the history", done.entries === 2 && done.today.s === done.score,
    JSON.stringify(done.today));
  ok("the card shows a two day streak", /2 day streak/.test(done.card), done.card.slice(0, 220));
  ok("the card shows a personal best and a count",
    /Best/.test(done.card) && /2 played/.test(done.card), done.card.slice(0, 260));
  ok("the share text mentions the streak", /2 days running/.test(done.share), done.share);

  /* showing it twice must not inflate anything */
  const again = await page.evaluate(() => {
    window.__hx.finish();
    return JSON.parse(localStorage.getItem("hexadec-history") || "[]").length;
  });
  ok("reopening the card does not add a second row for today", again === 2, String(again));

  ok("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

console.log("\n7. Shuffle");
/* The animation is decoration and is not worth asserting frame by frame. What
   is worth asserting is that it cannot lose a tile, cannot throw away a word
   you are halfway through typing, leaves the tiles square when it settles, and
   does not push PLACE WORD onto two lines on a small phone — which it did on
   the first attempt, at 375px, with four pixels in it. */
for (const width of [320, 375, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");

  const heights = await page.evaluate(() => ["btnPlay", "btnClear", "btnMix"]
    .map((id) => Math.round(document.getElementById(id).getBoundingClientRect().height)));
  ok(`${width}: the button row stays on one line`, heights.every((h) => h <= 46), heights.join("/"));

  const before = await page.$$eval("#tray .tile", (ns) => ns.map((n) => n.dataset.id));
  await page.click("#btnMix");
  ok(`${width}: the button's arrows turn`,
    /spin/.test(await page.$eval("#btnMix", (n) => n.className)));
  await page.waitForTimeout(900);
  const after = await page.$$eval("#tray .tile", (ns) => ns.map((n) => n.dataset.id));
  ok(`${width}: the same sixteen tiles come back`,
    after.length === 16 && [...after].sort().join() === [...before].sort().join());
  ok(`${width}: in a different order`, after.join() !== before.join());
  ok(`${width}: and they settle square`, await page.$$eval("#tray .tile", (ns) =>
    ns.every((n) => ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(getComputedStyle(n).transform))));

  /* Every fifth press is the showy one. It does nothing. */
  for (let i = 0; i < 4; i++) { await page.click("#btnMix"); await page.waitForTimeout(760); }
  ok(`${width}: every fifth press is the big tumble`,
    /spin-big/.test(await page.$eval("#btnMix", (n) => n.className)));
  await page.waitForTimeout(900);

  /* The reason the tray does not close its gaps mid-word applies here too. */
  await page.click("#tray .tile:not(.ghost)");
  await page.click("#tray .tile:not(.ghost)");
  const staged = await page.$$eval("#board .tile.pencil .ch", (n) => n.map((x) => x.textContent));
  await page.click("#btnMix");
  await page.waitForTimeout(800);
  const still = await page.$$eval("#board .tile.pencil .ch", (n) => n.map((x) => x.textContent));
  ok(`${width}: a half-typed word survives a shuffle`,
    staged.length === 2 && staged.join() === still.join(), `${staged} -> ${still}`);
  ok(`${width}: and the staged tiles keep their seats`,
    (await page.$$eval("#tray .tile.ghost", (n) => n.length)) === 2);

  ok(`${width}: no page errors`, errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  /* Asked for less movement: the shuffle still shuffles, silently. */
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  const before = await page.$$eval("#tray .tile", (ns) => ns.map((n) => n.dataset.id));
  await page.click("#btnMix");
  await page.waitForTimeout(300);
  const after = await page.$$eval("#tray .tile", (ns) => ns.map((n) => n.dataset.id));
  ok("reduced motion: it still shuffles", after.length === 16 && after.join() !== before.join());
  ok("reduced motion: with nothing animating",
    (await page.evaluate(() => document.getAnimations().length)) === 0);
  ok("reduced motion: no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

console.log("\n8. Rearranging the tray by hand");
/* Drag a tile and the rest make room; let go and it stays there. A press that
   barely moves is still a tap. None of it may lose a tile, stage a tile by
   accident, disturb a half-built word, or survive a reload in the wrong order. */
const ids = (page) => page.$$eval("#tray .tile", (ns) => ns.map((n) => +n.dataset.id));
async function dragTile(page, from, to, steps = 14) {
  const tiles = await page.$$("#tray .tile");
  const a = await tiles[from].boundingBox(), b = await tiles[to].boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
  await page.mouse.up();
  await page.waitForTimeout(750);   // the drop (170ms) and its squash (300ms) finish
}
const moved = (arr, from, to) => { const o = arr.slice(); const [x] = o.splice(from, 1); o.splice(to, 0, x); return o; };

for (const width of [320, 375, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");

  const start = await ids(page);
  await dragTile(page, 0, 5);
  const one = await ids(page);
  ok(`${width}: along a row, the tile lands where it was dropped`, one.join() === moved(start, 0, 5).join(),
    `${start} -> ${one}`);
  ok(`${width}: and nothing was staged by the drag`, (await page.$$("#board .tile.pencil")).length === 0);
  ok(`${width}: the clock started`, await page.evaluate(() => window.__hx.S.running));
  ok(`${width}: no hollow or floating tile left behind`,
    (await page.$$("#tray .tile.hole, .tile.floating")).length === 0);

  await dragTile(page, 2, 12);
  const two = await ids(page);
  ok(`${width}: across rows too`, two.join() === moved(one, 2, 12).join(), `${one} -> ${two}`);
  ok(`${width}: still sixteen tiles`, two.length === 16 && new Set(two).size === 16);
  ok(`${width}: and they settle square`, await page.$$eval("#tray .tile", (ns) =>
    ns.every((n) => ["none", "matrix(1, 0, 0, 1, 0, 0)"].includes(getComputedStyle(n).transform))));

  /* A wobble is a tap. */
  const t = await (await page.$$("#tray .tile"))[4].boundingBox();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 3, t.y + t.height / 2 + 2);
  await page.mouse.up();
  await page.waitForTimeout(100);
  ok(`${width}: a press that barely moves still picks the tile`, (await page.$$("#board .tile.pencil")).length === 1);

  /* Mid-word: the word survives and its seats travel with the order. */
  await page.click("#tray .tile:not(.ghost)");
  const word = await page.$$eval("#board .tile.pencil .ch", (n) => n.map((x) => x.textContent).join(""));
  const live = await page.$$eval("#tray .tile", (ns) => ns.map((n, i) => n.classList.contains("ghost") ? -1 : i).filter((i) => i >= 0));
  await dragTile(page, live[0], live[live.length - 1]);
  ok(`${width}: a half-built word survives a rearrange`,
    word.length === 2 && word === await page.$$eval("#board .tile.pencil .ch", (n) => n.map((x) => x.textContent).join("")));
  ok(`${width}: and its tiles keep their holes`, (await page.$$("#tray .tile.ghost")).length === 2);
  await page.keyboard.press("Escape");

  /* Remembered. */
  const kept = await ids(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  ok(`${width}: the arrangement survives a reload`, (await ids(page)).join() === kept.join());

  ok(`${width}: no page errors`, errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  /* A finger: the tile rides above it, so you can see what you are carrying. */
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  const r = await page.evaluate(async () => {
    const n = document.querySelectorAll("#tray .tile")[1];
    const b = n.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const ev = (type, dx) => new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true,
      clientX: x + dx, clientY: y, bubbles: true, cancelable: true });
    n.dispatchEvent(ev("pointerdown", 0));
    for (let dx = 2; dx <= 20; dx += 2) n.dispatchEvent(ev("pointermove", dx));
    await new Promise((res) => setTimeout(res, 200));
    const f = document.querySelector(".tile.floating");
    const fr = f && f.getBoundingClientRect();
    const out = { floating: !!f, above: fr ? fr.top + fr.height / 2 < y - b.height * 0.5 : false,
      hole: !!document.querySelector("#tray .tile.hole") };
    window.dispatchEvent(ev("pointerup", 20));
    await new Promise((res) => setTimeout(res, 400));
    out.clean = !document.querySelector(".tile.floating, #tray .tile.hole");
    out.staged = document.querySelectorAll("#board .tile.pencil").length;
    return out;
  });
  ok("touch: the tile lifts off the tray", r.floating && r.hole);
  ok("touch: and rides above the finger", r.above);
  ok("touch: letting go tidies up without staging anything", r.clean && r.staged === 0, JSON.stringify(r));
  ok("touch: no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  const start = await ids(page);
  await dragTile(page, 0, 3);
  ok("reduced motion: it still rearranges", (await ids(page)).join() === moved(start, 0, 3).join());
  ok("reduced motion: with nothing animating", (await page.evaluate(() => document.getAnimations().length)) === 0);
  ok("reduced motion: no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

console.log("\n9. Straight onto the board, any row");
/* The staging slots went on 10 Oct 2026. Tapped tiles are pencilled straight
   into the target row, which is the highest empty one unless another is
   tapped; a take-back leaves a gap and nothing else moves; and scoring reads
   columns from the top, which is what keeps every finished grid scoring what
   it always did. That last point matters most: the maximum on the end card
   comes from days.js, which was built under the old rule. */
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  ok("there are no staging slots any more", (await page.$$("#slots, .slot")).length === 0);
  ok("the top row is the target to start with", (await page.evaluate(() => window.__hx.S.target)) === 0);

  const sol = await page.evaluate(() => {
    const hx = window.__hx, { S, E } = hx;
    const rack = S.tiles.map((t) => t.ch).join("");
    return E.findSolutions(rack, E.makeableWords(rack, hx.FOUR_LIST), 1)[0];
  });
  const tapLetter = async (ch) => {
    const id = await page.evaluate((c) => {
      const hx = window.__hx, { S } = hx;
      const used = hx.placedIds();
      const t = S.order.map((i) => S.tiles[i]).find((x) => x.ch === c && !used.has(x.id) && !S.staged.includes(x.id));
      return t.id;
    }, ch);
    await page.click(`#tray .tile[data-id="${id}"]`);
  };
  const cell = (r, c) => `#board .cell[data-r="${r}"][data-c="${c}"]`;

  await tapLetter(sol[0][0]);
  ok("a tapped tile lands on the target row, pencilled",
    (await page.$$(`${cell(0, 0)} .tile.pencil`)).length === 1);
  ok("and leaves a hole in the tray", (await page.$$("#tray .tile.ghost")).length === 1);

  await page.click(cell(2, 1));
  let st = await page.evaluate(() => window.__hx.state());
  ok("tapping an empty row aims there", st.target === 2, JSON.stringify(st));
  ok("and the pencilled letter moves with it",
    (await page.$$(`${cell(2, 0)} .tile.pencil`)).length === 1 && (await page.$$(`${cell(0, 0)} .tile`)).length === 0);

  await page.click(cell(2, 0));
  ok("tapping a pencilled letter puts it back in the tray",
    (await page.$$("#board .tile.pencil")).length === 0 && (await page.$$("#tray .tile.ghost")).length === 0);

  for (const ch of sol[0]) await tapLetter(ch);
  const note = await page.textContent("#vnote");
  ok("four letters show the score to come", /\+\d+/.test(note), note);
  await page.click("#btnPlay");
  await page.waitForTimeout(150);
  st = await page.evaluate(() => window.__hx.state());
  ok("Place inks the word into the row that was aimed at", st.grid[2] === sol[0] && st.grid[0] === null, JSON.stringify(st.grid));
  ok("and the target goes back to the highest empty row", st.target === 0, String(st.target));

  const lone = await page.evaluate((w) => {
    const hx = window.__hx, { S, E, isWord } = hx;
    return { score: hx.currentScore().total, across: E.scorePlacement([w], [S.layout[2]], isWord).total };
  }, sol[0]);
  ok("a word below a gap scores its own row and no columns", lone.score === lone.across, JSON.stringify(lone));

  await page.keyboard.press("ArrowDown");
  st = await page.evaluate(() => window.__hx.state());
  ok("the down arrow moves to the next empty row", st.target === 1, String(st.target));
  await page.keyboard.press("ArrowDown");
  st = await page.evaluate(() => window.__hx.state());
  ok("and skips a filled one", st.target === 3, String(st.target));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  st = await page.evaluate(() => window.__hx.state());
  ok("up goes back to the top", st.target === 0, String(st.target));

  /* rows 3 then 0, by typing */
  for (const [w, r] of [[sol[1], 3], [sol[2], 0]]) {
    await page.evaluate((rr) => window.__hx.setTarget(rr), r);
    for (const ch of w) await page.keyboard.press(ch.toUpperCase());
    await page.keyboard.press("Enter");
  }
  const gapped = await page.evaluate(() => {
    const hx = window.__hx;
    const before = hx.state().grid.slice();
    hx.takeBack(3);
    return { before, after: hx.state().grid, target: hx.S.target };
  });
  ok("a take-back leaves its row empty", gapped.after[3] === null, JSON.stringify(gapped));
  ok("and nothing else moves", [0, 1, 2].every((i) => gapped.after[i] === gapped.before[i]), JSON.stringify(gapped));
  ok("and that row becomes the target", gapped.target === 3, String(gapped.target));

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  st = await page.evaluate(() => window.__hx.state());
  ok("a grid with gaps survives a reload, gaps and all",
    st.grid[3] === null && st.grid[1] === null && st.grid[2] === sol[0] && st.grid[0] === sol[2] && st.target === 1,
    JSON.stringify(st));

  /* finish: row 3 first, the gap at row 1 last, so columns arrive late */
  await page.evaluate(([a, b]) => {
    const hx = window.__hx, { S } = hx;
    const put = (w, r) => {
      hx.setTarget(r);
      const used = hx.placedIds();
      for (const ch of w) { const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id)); hx.stage(t.id); }
      hx.placeWord();
    };
    put(b, 3); put(a, 1);
  }, [sol[3], sol[1]]);
  await page.waitForTimeout(1400);
  const fin = await page.evaluate(() => {
    const hx = window.__hx, { S, E, isWord } = hx;
    return { st: hx.state(), old: E.scorePlacement(S.rows.map((r) => r.word), S.layout, isWord).total };
  });
  ok("filled in any order, the grid finishes", fin.st.ended && fin.st.rows.length === 4, JSON.stringify(fin.st));
  ok("and scores exactly what the old top-down rule gives that grid", fin.st.score === fin.old, `${fin.st.score} vs ${fin.old}`);
  ok("which is never more than the day's maximum", fin.st.score <= fin.st.max);
  ok("the end card is showing", await page.isVisible("#card"));
  ok("no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}
{
  /* A save from before 10 Oct 2026 (v1: a list of words from the top) loads.
     Planted before the page starts, because a reload saves on the way out. */
  const probe = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await probe.goto(BASE, { waitUntil: "networkidle" });
  const seed = await probe.evaluate(() => {
    const hx = window.__hx, { S, E } = hx;
    const rack = S.tiles.map((t) => t.ch).join("");
    const w = E.findSolutions(rack, E.makeableWords(rack, hx.FOUR_LIST), 1)[0][0];
    const used = new Set(), out = [];
    for (const ch of w) { const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id)); used.add(t.id); out.push(t.id); }
    return { key: "hexadec-" + S.date, val: JSON.stringify({ v: 1, rows: [out], ms: 1000, helped: false, ended: false, takebacks: 0 }) };
  });
  await probe.close();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript((sd) => localStorage.setItem(sd.key, sd.val), seed);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#tray .tile");
  const st = await page.evaluate(() => window.__hx.state());
  ok("an old save loads into the top row", !!st.grid[0] && st.grid[1] === null && st.target === 1, JSON.stringify(st));
  ok("old save: no page errors", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} failure(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
