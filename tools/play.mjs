/* tools/play.mjs — model players.
 *
 * Used two ways. tools/bot.mjs runs them to report on a batch of days, and
 * tools/day.mjs runs SENSIBLE as an acceptance gate: a day that a greedy
 * player cannot finish inside a small budget of take-backs never ships. That
 * gate is the reason the game is hard rather than unfair — the trap springs on
 * the careless constantly, but there is always a line through that does not
 * require inspiration.
 */

import * as E from "../public/engine.js";

const RARE = new Set("jqxzvkwy".split(""));

export function fits(w, c) {
  for (let i = 0; i < 4; i++) { const k = w.charCodeAt(i) - 97; if (c[k] <= 0) return false; c[k]--; }
  for (let i = 0; i < 4; i++) c[w.charCodeAt(i) - 97]++;
  return true;
}
export function take(c, w) {
  const o = c.slice();
  for (const ch of w) o[ch.charCodeAt(0) - 97]--;
  return o;
}
export function options(c, list) {
  const out = [];
  for (const w of list) if (fits(w, c.slice())) out.push(w);
  return out;
}

/* Can what is left still be split into whole words? The in-game "show me a
   word" uses the same idea, which is why it can never offer a word that leads
   nowhere. */
export function solvable(counts, list, depth) {
  if (depth === 0) { for (let i = 0; i < 26; i++) if (counts[i]) return false; return true; }
  for (const w of list) {
    if (!fits(w, counts.slice())) continue;
    if (solvable(take(counts, w), list, depth - 1)) return true;
  }
  return false;
}

/* policy: "random" | "sensible" | "perfect" */
export function play(day, words, isWord, { policy = "sensible", budget = 6, rnd = Math.random } = {}) {
  const layout = E.layoutFrom(day.layout);
  const rack = day.tiles.join("");
  const placed = [];
  let counts = E.countLetters(rack);
  let strands = 0, undos = 0, steps = 0;
  const tried = [new Set(), new Set(), new Set(), new Set()];

  while (placed.length < 4) {
    if (steps++ > 400) return { placed, done: false, strands, undos, score: 0 };
    const depth = placed.length;
    let opts = options(counts, words).filter((w) => !tried[depth].has(w));
    if (policy === "perfect") opts = opts.filter((w) => solvable(take(counts, w), words, 3 - depth));

    if (!opts.length) {
      if (depth === 0) return null;
      strands++;
      if (undos >= budget) return { placed, done: false, strands, undos, score: 0 };
      undos++;
      const back = placed.pop();
      tried[depth] = new Set();
      tried[depth - 1].add(back);
      counts = E.countLetters(rack);
      for (const w of placed) counts = take(counts, w);
      continue;
    }

    let choice;
    if (policy === "random") {
      choice = opts[Math.floor(rnd() * opts.length)];
    } else {
      let bestV = -1;
      for (const w of opts) {
        const s = E.scorePlacement([...placed, w], layout, isWord).total;
        const rare = w.split("").filter((ch) => RARE.has(ch)).length;
        const v = s + rare * 0.5;
        if (v > bestV) { bestV = v; choice = w; }
      }
    }
    tried[depth].add(choice);
    placed.push(choice);
    counts = take(counts, choice);
  }
  return {
    placed, done: true, strands, undos,
    score: E.scorePlacement(placed, layout, isWord).total,
  };
}
