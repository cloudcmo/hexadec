/* tools/day.mjs — how one day is built.
 *
 * Shared by tools/build-days.mjs (which writes the year ahead) and
 * tools/bot.mjs (which plays it), so the day the bot measures is byte for byte
 * the day that ships.
 *
 * The shape of a good day, learned by measuring rather than guessing:
 *
 *  - Sixteen tiles taken from four ordinary words, so a solution always exists
 *    and always exists in everyday vocabulary.
 *  - MANY complete solutions, not few. The first instinct was to make
 *    solutions scarce so the player would strand themselves. Measurement
 *    killed that: a player picking three plausible words at random already
 *    strands about 84% of the time, because the makeable words vastly
 *    outnumber the ones that actually finish. The trap is free. What has to be
 *    protected is the other side — the day being finishable by someone
 *    thinking reasonably — and that improves as solutions get denser.
 *  - Plenty of makeable words, so the board is full of tempting wrong turns.
 *
 * GATES is the whole tuning surface. Change a number here, then run
 * `npm run bot` before believing anything.
 */

import * as E from "../public/engine.js";
import { play } from "./play.mjs";

export const GATES = {
  maxRepeatedLetter: 4,   // no rack that is five of one letter
  vowelsMin: 4,
  vowelsMax: 8,
  wordsMin: 90,           // enough tempting wrong turns
  wordsMax: 460,          // beyond this the rack is mush and everything works
  solutionsMin: 60,       // density is fairness; see the note above
  solutionsProbeCap: 400, // we only need to know it clears the bar
  maxScoreMin: 170,
  maxScoreMax: 900,
  parBudget: 4,           // a greedy player must finish inside this many take-backs
  attempts: 600,
};

const VOWELS = "aeiou".split("").map((c) => c.charCodeAt(0) - 97);

/* Builds the day for an ISO date, or null if the gates could not be met.
   `common` is the target pool, `fours` the play dictionary. */
export function buildDay(date, common, fours, isWord, gates = GATES) {
  const rnd = E.rngFor("hexadec|day|" + date);

  for (let attempt = 0; attempt < gates.attempts; attempt++) {
    /* four distinct everyday words */
    const target = [];
    const seen = new Set();
    let guard = 0;
    while (target.length < 4 && guard++ < 40) {
      const w = common[Math.floor(rnd() * common.length)];
      if (seen.has(w)) continue;
      seen.add(w);
      target.push(w);
    }
    if (target.length < 4) continue;

    const rackStr = target.join("");
    const counts = E.countLetters(rackStr);
    if (Math.max(...counts) > gates.maxRepeatedLetter) continue;
    const vowels = VOWELS.reduce((a, i) => a + counts[i], 0);
    if (vowels < gates.vowelsMin || vowels > gates.vowelsMax) continue;

    const makeable = E.makeableWords(rackStr, fours);
    if (makeable.length < gates.wordsMin || makeable.length > gates.wordsMax) continue;

    const sols = E.findSolutions(rackStr, makeable, gates.solutionsProbeCap);
    if (sols.length < gates.solutionsMin) continue;

    const layoutIndex = Math.floor(rnd() * E.LAYOUT_COUNT);
    const layout = E.layoutFrom(layoutIndex);
    const { best, bestWords, nodes } = E.maximise(rackStr, makeable, layout, isWord);
    if (best < gates.maxScoreMin || best > gates.maxScoreMax) continue;

    /* The acceptance test that matters: a greedy player, allowed a few
       take-backs, has to be able to finish. A day nobody sensible can close is
       not a hard day, it is a broken one. Its score becomes par. */
    const tiles0 = E.shuffled(rackStr.split(""), E.rngFor("hexadec|tiles|" + date));
    const probe = play({ tiles: tiles0, layout: layoutIndex }, makeable, isWord,
      { policy: "sensible", budget: gates.parBudget });
    if (!probe || !probe.done) continue;

    /* The tiles are shuffled so the four source words are not sitting there in
       order waiting to be read off the rack. */
    const tiles = tiles0;

    return {
      date,
      tiles,
      layout: layoutIndex,
      max: best,
      par: probe.score,
      parUndos: probe.undos,
      bestWords,
      target,
      words: makeable,
      nWords: makeable.length,
      nSols: sols.length,
      nodes,
      attempt,
    };
  }
  return null;
}
