/* tools/bot.mjs — how hard is a day, really?
 *
 *   npm run bot [days] [startDate]
 *
 * Three players walk every day and the differences between them are the whole
 * design argument:
 *
 *   RANDOM    picks any word the remaining tiles allow. A stand-in for someone
 *             playing the first thing they see. Its strand rate is the
 *             frequency of the trap Carl is after — three words down and the
 *             last four tiles spell nothing.
 *   SENSIBLE  picks the word that scores best right now, breaking ties towards
 *             clearing awkward letters. This is a competent human on a good
 *             day, and it is the number that decides whether the game is fair.
 *             It is allowed a budget of take-backs, which is what a real player
 *             does when stranded.
 *   PERFECT   only ever plays a word the remainder can still be finished from,
 *             and takes the best such line. Never strands. The ceiling.
 *
 * What to watch: SENSIBLE finishing inside a handful of take-backs, and its
 * score landing at a respectable but beatable share of the maximum. If SENSIBLE
 * needs a dozen take-backs the game is a slog; if it scores 95% of maximum the
 * scoring has no headroom and the percentage on the end card is meaningless.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../public/engine.js";
import { FOURS, THREES, TWOS } from "../public/words.js";
import { buildDay } from "./day.mjs";
import { play } from "./play.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fours = FOURS.split(" ");
const wordSet = new Set([...fours, ...THREES.split(" "), ...TWOS.split(" ")]);
const isWord = (s) => wordSet.has(s);
const common = fs.readFileSync(path.join(HERE, "data", "common4.txt"), "utf8")
  .split("\n").filter(Boolean);

const DAYS = parseInt(process.argv[2] || "60", 10);
const START = process.argv[3] || "2026-09-15";

const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const fmt = (a) => `min ${q(a, 0)} p25 ${q(a, .25)} med ${q(a, .5)} p75 ${q(a, .75)} max ${q(a, 1)}`;

const days = [];
let d = new Date(START + "T12:00:00Z");
const t0 = Date.now();
for (let i = 0; i < DAYS; i++) {
  const date = d.toISOString().slice(0, 10);
  const day = buildDay(date, common, fours, isWord);
  if (day) days.push(day);
  d = new Date(+d + 86400000);
}
console.log(`built ${days.length}/${DAYS} days in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const rnd = E.rngFor("bot");
const randStrand = [], sensScore = [], sensUndo = [], sensPct = [], maxes = [], wordCounts = [], solCounts = [];
let sensFail = 0;
for (const day of days) {
  maxes.push(day.max);
  wordCounts.push(day.nWords);
  solCounts.push(day.nSols);
  let strandHits = 0;
  for (let t = 0; t < 40; t++) { const r = play(day, day.words, isWord, { policy: "random", budget: 0, rnd }); if (!r || !r.done) strandHits++; }
  randStrand.push(Math.round(strandHits / 40 * 100));
  const s = play(day, day.words, isWord, { policy: "sensible", budget: 8, rnd });
  if (s && s.done) {
    sensScore.push(s.score); sensUndo.push(s.undos);
    sensPct.push(Math.round(s.score / day.max * 100));
  } else sensFail++;
}

console.log("maximum score    ", fmt(maxes));
console.log("makeable words   ", fmt(wordCounts));
console.log("solutions (cap)  ", fmt(solCounts));
console.log("");
console.log("RANDOM strand %  ", fmt(randStrand), "  <- how often the trap springs on a careless player");
console.log("");
console.log("SENSIBLE score   ", fmt(sensScore));
console.log("SENSIBLE % of max", fmt(sensPct), "  <- what the end card will say for a decent game");
console.log("SENSIBLE takebacks", fmt(sensUndo));
console.log("PAR (built-in gate)", fmt(days.map(d=>d.par)), " undos", fmt(days.map(d=>d.parUndos)));
console.log("build attempts   ", fmt(days.map(d=>d.attempt)));
console.log(`SENSIBLE failed to finish within 8 take-backs on ${sensFail}/${days.length} days`);
