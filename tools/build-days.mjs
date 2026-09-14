/* tools/build-days.mjs — writes public/days.js, the year ahead.
 *
 *   npm run days [count] [startDate]
 *
 * Every other Guff game that needs no API key builds its day in the browser
 * from a date seed. Hexadec cannot: a day is only worth playing if it is known
 * to hold four whole words, to be finishable by a greedy player, and to have a
 * maximum score worth quoting — and establishing all three means an exhaustive
 * search that takes a second on a laptop and would be an unkind thing to do to
 * a phone on a train. So the search happens here, once, and the browser is
 * handed the answer.
 *
 * Each day ships as three values and nothing more:
 *   tiles   the sixteen letters, already shuffled
 *   layout  an index into the premium templates in engine.js
 *   max     the best score the day can possibly give, time bonus excluded
 *
 * Note what is NOT shipped: the four words the day was cut from, and the line
 * that achieves the maximum. Both would be sitting in plain sight in the page
 * source. The game finds its own solutions when it needs one, from the same
 * dictionary the player is playing against.
 *
 * ⚠️ Regenerate whenever the tile values, DOWN_MULT, the premium templates, the
 * dictionary or the gates change — every one of them moves `max`, and a stale
 * maximum quietly lies to every player about how well they did.
 *
 * DAYS ALREADY PLAYED ARE NEVER REGENERATED. If public/days.js already starts
 * on the requested date, every row up to and including today is copied across
 * untouched and only tomorrow onwards is rebuilt. Changing the dictionary
 * changes which racks pass the gates, so without this a rebuild would swap the
 * tiles out from under anyone midway through today's puzzle, and silently
 * restate the maximum that yesterday's players were already given. Pass
 * --fresh to rebuild the lot anyway.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../public/engine.js";
import { FOURS, THREES, TWOS } from "../public/words.js";
import { buildDay, GATES } from "./day.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "public", "days.js");

const ARGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FRESH = process.argv.includes("--fresh");
const COUNT = parseInt(ARGS[0] || "400", 10);
const START = ARGS[1] || "2026-09-15";

const todayISO = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

/* Rows for days that have already been served. Copied across verbatim. */
function existingDays() {
  if (FRESH || !fs.existsSync(OUT)) return null;
  try {
    const text = fs.readFileSync(OUT, "utf8");
    const from = text.match(/DAYS_FROM = "(\d{4}-\d{2}-\d{2})"/);
    if (!from || from[1] !== START) return null;
    const tiles = text.match(/TILES = "([a-z ]+)"/)[1].split(" ");
    const layouts = JSON.parse(text.match(/LAYOUTS = (\[[^\]]*\])/)[1]);
    const maxes = JSON.parse(text.match(/MAXES = (\[[^\]]*\])/)[1]);
    const pars = JSON.parse(text.match(/PARS = (\[[^\]]*\])/)[1]);
    const n = Math.round((Date.parse(todayISO + "T12:00:00Z") - Date.parse(START + "T12:00:00Z")) / 86400000) + 1;
    const keep = Math.max(0, Math.min(n, tiles.length));
    return keep > 0 ? { tiles: tiles.slice(0, keep), layouts: layouts.slice(0, keep),
      maxes: maxes.slice(0, keep), pars: pars.slice(0, keep), keep } : null;
  } catch (e) {
    console.warn("could not read the existing table, rebuilding it all:", e.message);
    return null;
  }
}

const fours = FOURS.split(" ");
const wordSet = new Set([...fours, ...THREES.split(" "), ...TWOS.split(" ")]);
const isWord = (s) => wordSet.has(s);
const common = fs.readFileSync(path.join(HERE, "data", "common4.txt"), "utf8")
  .split("\n").filter(Boolean);

const tiles = [];
const layouts = [];
const maxes = [];
const pars = [];
const misses = [];

const kept = existingDays();
if (kept) {
  tiles.push(...kept.tiles); layouts.push(...kept.layouts);
  maxes.push(...kept.maxes); pars.push(...kept.pars);
  console.log(`keeping ${kept.keep} day(s) already served, through ${todayISO}; rebuilding from tomorrow`);
}

let d = new Date(Date.parse(START + "T12:00:00Z") + tiles.length * 86400000);
const t0 = Date.now();
for (let i = tiles.length; i < COUNT; i++) {
  const date = d.toISOString().slice(0, 10);
  const day = buildDay(date, common, fours, isWord);
  if (!day) {
    misses.push(date);
    /* A hole in the table is not survivable — the game would have nothing to
       serve that morning — so fail loudly rather than ship a gap. */
    console.error(`\nNo day could be built for ${date} within ${GATES.attempts} attempts. Loosen tools/day.mjs GATES and rerun.`);
    process.exit(1);
  }
  tiles.push(day.tiles.join(""));
  layouts.push(day.layout);
  maxes.push(day.max);
  pars.push(day.par);
  if ((i + 1) % 50 === 0) process.stdout.write(`  ${i + 1}/${COUNT}\r`);
  d = new Date(+d + 86400000);
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const last = new Date(+new Date(START + "T12:00:00Z") + (COUNT - 1) * 86400000).toISOString().slice(0, 10);

const header = `/* Hexadec daily puzzles — GENERATED by tools/build-days.mjs (npm run days).
   Do not hand-edit.

   ${COUNT} days, ${START} to ${last}.
   Maximum score: min ${q(maxes, 0)} · median ${q(maxes, 0.5)} · max ${q(maxes, 1)}
   Greedy-player par: min ${q(pars, 0)} · median ${q(pars, 0.5)} · max ${q(pars, 1)}

   Every day here has been proved to hold at least ${GATES.solutionsMin} complete
   four-word solutions and to be finishable by a greedy player inside
   ${GATES.parBudget} take-backs. REGENERATE after any change to the tile values,
   DOWN_MULT, the premium templates, the dictionary or the gates. */
`;

const body = `export const DAYS_FROM = ${JSON.stringify(START)};
export const TILES = ${JSON.stringify(tiles.join(" "))}.split(" ");
export const LAYOUTS = ${JSON.stringify(layouts)};
export const MAXES = ${JSON.stringify(maxes)};
export const PARS = ${JSON.stringify(pars)};

/* Index of an ISO date in the tables above, or -1 if the day is outside them. */
export function dayIndex(iso) {
  const a = Date.UTC(+DAYS_FROM.slice(0, 4), +DAYS_FROM.slice(5, 7) - 1, +DAYS_FROM.slice(8, 10));
  const b = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const i = Math.round((b - a) / 86400000);
  return i >= 0 && i < TILES.length ? i : -1;
}
`;

fs.writeFileSync(OUT, header + body);
console.log(`\npublic/days.js written: ${COUNT} days, ${START} to ${last}, in ${secs}s (${(fs.statSync(OUT).size / 1024).toFixed(1)}KB)`);
console.log(`maximum score: min ${q(maxes, 0)} p25 ${q(maxes, .25)} median ${q(maxes, .5)} p75 ${q(maxes, .75)} max ${q(maxes, 1)}`);
console.log(`par:           min ${q(pars, 0)} p25 ${q(pars, .25)} median ${q(pars, .5)} p75 ${q(pars, .75)} max ${q(pars, 1)}`);
