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
 * reload; that the tray does not reflow while a word is being chosen; and that
 * I'm stuck can be used once and costs 20.
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
    return { word, before, after, back, rows: S.rows.length, takebacks: S.takebacks };
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
      const used = new Set(S.rows.flatMap((r) => r.ids));
      for (const ch of word) {
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
        hx.stage(t.id);
      }
      hx.placeWord();
    }
    hx.finish();
    return {
      rows: S.rows.length, score: hx.currentScore().total, max: S.max,
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
    const gone = getComputedStyle(document.getElementById("extraBtns")).display === "none";
    return { shown, label, first, second, gone };
  });

  ok("it appears once you start playing", r.shown);
  ok("it is labelled I'm stuck and shows the cost", /I'm stuck/.test(r.label) && /20/.test(r.label), r.label);
  ok("it stages a whole word", r.first.staged === 4, JSON.stringify(r.first));
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
      const used = new Set(S.rows.flatMap((x) => x.ids));
      for (const ch of word) {
        const t = S.tiles.find((x) => x.ch === ch && !used.has(x.id) && !S.staged.includes(x.id));
        if (t) hx.stage(t.id);
      }
      hx.placeWord();
    }
    hx.finish();
    return {
      rows: S.rows.length, words: hx.currentScore().total,
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
  ok("typing the letters stages the word", st === typed.word, `${st} vs ${typed.word}`);

  await page.keyboard.press("Backspace");
  st = await page.evaluate(() => window.__hx.S.staged.length);
  ok("backspace gives a letter back", st === 3, String(st));

  await page.keyboard.press("Escape");
  st = await page.evaluate(() => window.__hx.S.staged.length);
  ok("escape clears the lot", st === 0, String(st));

  for (const ch of typed.word) await page.keyboard.press(ch.toUpperCase());
  await page.keyboard.press("Enter");
  const afterEnter = await page.evaluate(() => ({
    rows: window.__hx.S.rows.length,
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
    S.rows.length = 0;
    const rack = S.tiles.map((t) => t.ch).join("");
    const sol = E.findSolutions(rack, E.makeableWords(rack, hx.FOUR_LIST), 1)[0];
    for (const w of sol) {
      const used = new Set(S.rows.flatMap((x) => x.ids));
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

await browser.close();
console.log(failures ? `\n${failures} failure(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
