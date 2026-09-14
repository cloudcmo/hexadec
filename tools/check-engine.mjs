/* tools/check-engine.mjs — npm run check
 *
 * The maximum score is quoted to every player as a percentage of their own, so
 * it had better be a maximum. These checks exist because "exhaustive search
 * with an admissible bound and incremental scoring" is exactly the kind of code
 * that stays fast and quietly stops being right.
 *
 * The important one is section 3: the clever search is compared against a dumb
 * one — enumerate every complete solution with no cap, score all 24 orders of
 * each through the same scorePlacement the game uses, take the largest. They
 * must agree exactly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../public/engine.js";
import { FOURS, THREES, TWOS } from "../public/words.js";
import { TILES, LAYOUTS, MAXES, PARS, DAYS_FROM, dayIndex } from "../public/days.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fours = FOURS.split(" ");
const fourSet = new Set(fours);
const wordSet = new Set([...fours, ...THREES.split(" "), ...TWOS.split(" ")]);
const isWord = (s) => wordSet.has(s);
const common = fs.readFileSync(path.join(HERE, "data", "common4.txt"), "utf8")
  .split("\n").filter(Boolean);

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ✓ ${name}`);
  else { fails++; console.log(`  ✗ ${name} ${extra}`); }
};

/* ---- 1. layouts --------------------------------------------------------- */
console.log("\n1. Premium layouts");
{
  let symmetric = true, wellFormed = true;
  for (const t of E.TEMPLATES) {
    if (t.length !== 4 || t.some((r) => r.length !== 4)) wellFormed = false;
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        if (t[r][c] !== t[3 - r][3 - c]) symmetric = false;
  }
  ok("every template is 4×4", wellFormed);
  ok("every template has 180° rotational symmetry", symmetric);

  const seen = new Set();
  for (let i = 0; i < E.LAYOUT_COUNT; i++) seen.add(E.layoutFrom(i).join("/"));
  ok(`${E.LAYOUT_COUNT} layout indices give ${seen.size} distinct boards`, seen.size >= E.TEMPLATES.length * 2);
  ok("only legal square codes are used", [...seen].every((s) => /^[.dtDT/]+$/.test(s)));
  ok("layoutFrom wraps rather than throwing", E.layoutFrom(9999).length === 4 && E.layoutFrom(-3).length === 4);
}

/* ---- 2. scoring, by hand ------------------------------------------------ */
console.log("\n2. Scoring");
{
  const layout = ["T..d", ".d..", "..d.", "d..T"];
  /* GNAT on row 1: G4 on triple word, N2, A1, T2 doubled = 4+2+1+4 = 11, ×3 = 33 */
  ok("GNAT on the top row scores 33", E.scorePlacement(["gnat"], layout, isWord).total === 33,
    String(E.scorePlacement(["gnat"], layout, isWord).total));
  /* TANG: T2 ×3word, A1, N2, G4 doubled = 2+1+2+8 = 13, ×3 = 39 */
  ok("TANG on the same row scores 39 — the anagram choice matters",
    E.scorePlacement(["tang"], layout, isWord).total === 39);

  const two = E.scorePlacement(["gnat", "oboe"], layout, isWord);
  const downs = two.rows[1].downs.map((d) => d.word).sort().join(",");
  ok("placing a second row finds the columns that became words", downs === "go,te", downs);
  ok("a premium under an earlier row does not fire twice",
    two.rows[1].downs.find((d) => d.word === "go").score === 5,
    JSON.stringify(two.rows[1].downs));

  ok("score is a pure function of the word list",
    E.scorePlacement(["gnat", "oboe"], layout, isWord).total ===
    E.scorePlacement(["gnat", "oboe"], layout, isWord).total);
  ok("row order changes the score",
    E.scorePlacement(["gnat", "oboe"], layout, isWord).total !==
    E.scorePlacement(["oboe", "gnat"], layout, isWord).total);

  const four = E.scorePlacement(["bake", "area", "rest", "keys"], layout, isWord);
  ok("a full grid scores every row", four.rows.length === 4 && four.total > 0);
  ok("the total is the sum of the rows",
    four.total === four.rows.reduce((a, r) => a + r.total, 0));
}

/* ---- 3. the maximum really is the maximum ------------------------------- */
console.log("\n3. The maximum, against brute force");
{
  const rnd = E.rngFor("check-engine");
  let checked = 0, mismatches = 0, rescoreBad = 0;
  for (let i = 0; i < 800 && checked < 30; i++) {
    const pick = []; const seen = new Set();
    while (pick.length < 4) {
      const w = common[Math.floor(rnd() * common.length)];
      if (seen.has(w)) continue; seen.add(w); pick.push(w);
    }
    const rack = pick.join("");
    const list = E.makeableWords(rack, fours);
    if (list.length > 140) continue;            // keep the dumb version affordable
    const layout = E.layoutFrom(Math.floor(rnd() * E.LAYOUT_COUNT));
    const sols = E.findSolutions(rack, list, Infinity);
    const brute = E.bestScore(sols, layout, isWord);
    const fast = E.maximise(rack, list, layout, isWord);
    checked++;
    if (brute.best !== fast.best) { mismatches++; console.log(`    ${rack}: brute ${brute.best}, fast ${fast.best}`); }
    if (E.scorePlacement(fast.bestWords, layout, isWord).total !== fast.best) rescoreBad++;
  }
  ok(`${checked} racks agree with uncapped brute force`, mismatches === 0, `${mismatches} mismatches`);
  ok("the winning line rescores to the number claimed", rescoreBad === 0, `${rescoreBad} bad`);
}

/* ---- 4. the dictionary -------------------------------------------------- */
console.log("\n4. Dictionary");
{
  ok("every four-letter word is four lowercase letters", fours.every((w) => /^[a-z]{4}$/.test(w)));
  ok("no duplicates", new Set(fours).size === fours.length);
  ok("sorted", fours.every((w, i) => i === 0 || fours[i - 1] < w));
  const notPlayable = common.filter((w) => !fourSet.has(w));
  ok("every target-pool word is playable", notPlayable.length === 0, notPlayable.slice(0, 8).join(" "));
  ok("the target pool is big enough for years of days", common.length > 1200, String(common.length));
  const blocked = fs.readFileSync(path.join(HERE, "data", "offensive.txt"), "utf8").split("\n").filter(Boolean);
  const leaked = blocked.filter((w) => wordSet.has(w));
  ok("nothing from the blocklist is playable", leaked.length === 0, leaked.join(" "));
}

/* ---- 5. the shipped day table ------------------------------------------- */
console.log("\n5. The day table");
{
  ok("the tables are the same length",
    TILES.length === LAYOUTS.length && TILES.length === MAXES.length && TILES.length === PARS.length);
  ok("every day has sixteen tiles", TILES.every((t) => /^[a-z]{16}$/.test(t)));
  ok("dayIndex finds the first day", dayIndex(DAYS_FROM) === 0);
  ok("dayIndex refuses a day before the table", dayIndex("2000-01-01") === -1);
  ok("par never exceeds the maximum", PARS.every((p, i) => p <= MAXES[i]),
    String(PARS.findIndex((p, i) => p > MAXES[i])));

  /* Spot-check that the shipped maximum is what today's engine computes, and
     that the day really is solvable. A mismatch means days.js is stale. */
  const step = Math.max(1, Math.floor(TILES.length / 12));
  let stale = 0, unsolvable = 0;
  for (let i = 0; i < TILES.length; i += step) {
    const rack = TILES[i];
    const list = E.makeableWords(rack, fours);
    if (!E.findSolutions(rack, list, 1).length) unsolvable++;
    const { best } = E.maximise(rack, list, E.layoutFrom(LAYOUTS[i]), isWord);
    if (best !== MAXES[i]) { stale++; console.log(`    day ${i} (${rack}): shipped ${MAXES[i]}, engine says ${best}`); }
  }
  ok("sampled days are solvable", unsolvable === 0, `${unsolvable} with no solution`);
  ok("sampled maxima match this engine (days.js is not stale)", stale === 0,
    `${stale} differ — run: npm run days`);

  /* Days already served are deliberately NOT regenerated (see build-days.mjs),
     so after a dictionary change their maxima can drift. Two directions, two
     meanings: a shipped maximum BELOW the true one is harmless — the ceiling
     rose after the day was played and nobody can replay it. A shipped maximum
     ABOVE the true one is a lie in the harsh direction, and means the table is
     genuinely stale. Only the second is a failure. */
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const served = Math.min(TILES.length, Math.max(0, dayIndex(today) + 1));
  let over = 0, under = [];
  for (let i = 0; i < served; i++) {
    const rack = TILES[i];
    const { best } = E.maximise(rack, E.makeableWords(rack, fours), E.layoutFrom(LAYOUTS[i]), isWord);
    if (MAXES[i] > best) over++;
    else if (MAXES[i] < best) under.push(`${i}: ${MAXES[i]}→${best}`);
  }
  ok(`no served day overstates its maximum (${served} checked)`, over === 0, `${over} do`);
  if (under.length) {
    console.log(`    note: ${under.length} served day(s) understate it, which is harmless — ${under.join(", ")}`);
  }
}

console.log(fails ? `\n${fails} failure(s)\n` : "\nAll checks passed\n");
process.exit(fails ? 1 : 0);
