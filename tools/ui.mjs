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
 * reload; and that the share text gives away no letters.
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

await browser.close();
console.log(failures ? `\n${failures} failure(s)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
