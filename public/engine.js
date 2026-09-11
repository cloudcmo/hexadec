/* Hexadec engine — the rules, in one file.
 *
 * Everything that decides a number lives here: the tile values, the premium
 * layouts, how a placement scores, and the exhaustive search for the best
 * score a day can possibly yield. The game front end and the build tools both
 * import this module, which is deliberate — the "% of the best possible" on
 * the end card is only honest if the maximum was computed by the same function
 * that scored the player.
 *
 * No DOM, no globals, no side effects. Safe to run in a Worker or in node.
 */

/* ---------------------------------------------------------------------------
 * Tile values
 *
 * Derived from letter frequency across the 2,015-word common four-letter pool
 * (tools/build-words.mjs prints the distribution), not from general English.
 * Four-letter words are not a fair sample of the language: S is inflated by
 * plurals and third persons, K and W are far commoner than their reputation,
 * and V, J, Z, X and Q are rarer still. Values run 1-12 in bands, so they are
 * recognisably a word-game scale without being anyone else's.
 *
 * The anagram tension Carl wanted falls out of this: GNAT and TANG cost the
 * same to hold but not the same to place, because G is 4 and T is 2, so which
 * of them lands on the triple letter decides the score.
 * ------------------------------------------------------------------------- */
export const VALUES = {
  a: 1, e: 1, o: 1, s: 1,
  i: 2, l: 2, n: 2, r: 2, t: 2,
  d: 3, m: 3, p: 3, u: 3,
  b: 4, c: 4, g: 4, h: 4,
  f: 5, k: 5, w: 5,
  y: 6,
  v: 8,
  j: 9, x: 9, z: 9,
  q: 12,
};

export function letterValue(ch) {
  return VALUES[ch.toLowerCase()] || 0;
}

/* Column words are the hard part and the pretty part, so they pay for it.
 * A two-letter column is mostly luck and scores flat; a full four-letter
 * column means the player has been thinking four moves ahead about letters
 * they had not placed yet, and triples. This is also what lifts a good game
 * into the two hundreds, and it is the number to move first if the scoring
 * ever needs rebalancing. */
export const DOWN_MULT = { 2: 1, 3: 1, 4: 2 };

/* ---------------------------------------------------------------------------
 * The premium layouts
 *
 * Sixteen squares is a small canvas, so each template carries only four to six
 * premiums and every one of them has 180-degree rotational symmetry, which is
 * what stops a layout looking like a mistake.
 *
 *   .  plain      d  double letter   t  triple letter
 *   D  double word                   T  triple word
 *
 * Symmetry is about how the board LOOKS. It does not make the board play the
 * same way up: rows fill from the top, so a triple word in row 4 is worth far
 * more than the same square in row 1 — it multiplies the fourth word AND every
 * four-letter column that completes underneath it. That asymmetry is the whole
 * game, which is why the eight dihedral transforms below are real variety and
 * not decoration.
 * ------------------------------------------------------------------------- */
export const TEMPLATES = [
  ["T..d", ".d..", "..d.", "d..T"],
  [".d.D", "d..t", "t..d", "D.d."],
  ["..T.", ".D..", "..D.", ".T.."],
  ["d..t", ".D..", "..D.", "t..d"],
  [".t..", "D..d", "d..D", "..t."],
  ["T...", "..d.", ".d..", "...T"],
  [".D.t", "....", "....", "t.D."],
  ["d.d.", "..T.", ".T..", ".d.d"],
  ["..d.", "t.D.", ".D.t", ".d.."],
  ["D..d", ".t..", "..t.", "d..D"],
  ["..t.", ".D.d", "d.D.", ".t.."],
  [".d..", "t..D", "D..t", "..d."],
];

/* The eight ways to sit a square grid on the table. */
function transform(grid, k) {
  const n = 4;
  let g = grid.map((row) => row.split(""));
  if (k & 4) g = g.map((row) => row.slice().reverse()); // mirror
  for (let r = 0; r < (k & 3); r++) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push([]);
      for (let j = 0; j < n; j++) out[i].push(g[n - 1 - j][i]);
    }
    g = out;
  }
  return g.map((row) => row.join(""));
}

/* layoutIndex is 0..(TEMPLATES.length*8-1); the day picks one. */
export function layoutFrom(index) {
  const t = TEMPLATES[Math.abs(index) % TEMPLATES.length];
  const k = Math.floor(Math.abs(index) / TEMPLATES.length) % 8;
  return transform(t, k);
}

export const LAYOUT_COUNT = TEMPLATES.length * 8;

function letterMult(code) { return code === "d" ? 2 : code === "t" ? 3 : 1; }
function wordMult(code) { return code === "D" ? 2 : code === "T" ? 3 : 1; }

/* ---------------------------------------------------------------------------
 * Scoring
 *
 * Words fill the grid from row 1 downwards. Placing a row scores:
 *
 *   1. the row word itself, with every premium under it applied (all four
 *      tiles are newly placed, so all four premiums are live);
 *   2. a bonus for each column that now reads as a real word top-to-bottom.
 *      A column can pay out three times over a game — at two letters, again at
 *      three, again at four — which is where the animation lives.
 *
 * The premium rule for a column bonus is the board-game one and it matters:
 * only the square just filled is live. Letters placed on earlier turns
 * contribute their face value. So a triple word in row 3 triples the
 * three-letter column that completes there, but the double letter in row 1
 * does not double that same column's first letter a second time.
 *
 * Score is a pure function of the ordered list of words. Nothing accumulates,
 * which is what lets a player take any word back at any time: the grid is
 * rescored from scratch and there is no way to farm points by placing and
 * removing the same word.
 * ------------------------------------------------------------------------- */
export function scorePlacement(words, layout, isWord) {
  const rows = [];
  let total = 0;
  const n = words.length;

  for (let r = 0; r < n; r++) {
    const word = words[r].toLowerCase();
    let base = 0;
    let mult = 1;
    for (let c = 0; c < 4; c++) {
      const code = layout[r][c];
      base += letterValue(word[c]) * letterMult(code);
      mult *= wordMult(code);
    }
    const acrossScore = base * mult;

    /* columns that have just become words */
    const downs = [];
    if (r >= 1) {
      for (let c = 0; c < 4; c++) {
        let s = "";
        for (let i = 0; i <= r; i++) s += words[i][c].toLowerCase();
        if (!isWord(s)) continue;
        let dBase = 0;
        for (let i = 0; i < r; i++) dBase += letterValue(words[i][c]);
        dBase += letterValue(word[c]) * letterMult(layout[r][c]);
        const dScore = dBase * wordMult(layout[r][c]) * DOWN_MULT[s.length];
        downs.push({ col: c, word: s, score: dScore, mult: DOWN_MULT[s.length] });
      }
    }

    const rowTotal = acrossScore + downs.reduce((a, d) => a + d.score, 0);
    total += rowTotal;
    rows.push({ word, across: acrossScore, downs, total: rowTotal });
  }
  return { total, rows };
}

/* ---------------------------------------------------------------------------
 * Racks and words
 * ------------------------------------------------------------------------- */
export function countLetters(letters) {
  const c = new Array(26).fill(0);
  for (const ch of letters) {
    const i = ch.toLowerCase().charCodeAt(0) - 97;
    if (i >= 0 && i < 26) c[i]++;
  }
  return c;
}

function fitsIn(wordCount, rackCount) {
  for (let i = 0; i < 26; i++) if (wordCount[i] > rackCount[i]) return false;
  return true;
}

/* Every four-letter word the rack can spell. ~3,100 dictionary words against
   a 26-slot tally: fast enough to run on a phone, though in practice the build
   tool is the only caller. */
export function makeableWords(rack, fours) {
  const rc = countLetters(rack);
  const out = [];
  for (const w of fours) {
    const wc = countLetters(w);
    if (fitsIn(wc, rc)) out.push(w);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Complete solutions
 *
 * A "solution" is four words that use all sixteen tiles exactly. Words are
 * chosen in index order so each SET is produced once, but the index may repeat
 * so a rack holding two of everything can legitimately play the same word
 * twice. GNAT and TANG are separate entries and so are separately enumerated —
 * they are different plays with different scores.
 * ------------------------------------------------------------------------- */
export function findSolutions(rack, candidates, cap = 20000) {
  const counts = candidates.map((w) => countLetters(w));
  const rc = countLetters(rack);
  const out = [];
  const pick = [];

  function recurse(start, remaining, depth) {
    if (out.length >= cap) return;
    if (depth === 4) {
      for (let i = 0; i < 26; i++) if (remaining[i] !== 0) return;
      out.push(pick.slice());
      return;
    }
    for (let i = start; i < candidates.length; i++) {
      const wc = counts[i];
      if (!fitsIn(wc, remaining)) continue;
      for (let k = 0; k < 26; k++) remaining[k] -= wc[k];
      pick.push(candidates[i]);
      recurse(i, remaining, depth + 1);
      pick.pop();
      for (let k = 0; k < 26; k++) remaining[k] += wc[k];
      if (out.length >= cap) return;
    }
  }
  recurse(0, rc, 0);
  return out;
}

/* The 24 orders of four things. */
const ORDERS = (() => {
  const out = [];
  const a = [0, 1, 2, 3];
  const perm = (arr, k) => {
    if (k === arr.length) { out.push(arr.slice()); return; }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm(a, 0);
  return out;
})();

/* ---------------------------------------------------------------------------
 * The best a day can give
 *
 * Not a sample and not an estimate: every ordered way of laying four words
 * across the sixteen tiles. The search walks rows 1 to 4 choosing a word that
 * still fits, and because the rack holds exactly sixteen tiles and every word
 * is exactly four, any path that reaches row 4 has used the rack exactly — so
 * every complete path is a legal game and no separate partition check is
 * needed. Row order is part of the search rather than a loop over the 24
 * permutations, which is what makes it affordable: the score of rows 1..r is
 * computed once and carried down, instead of the whole grid being rescored for
 * every arrangement.
 *
 * The time bonus is deliberately excluded. There is no way to know how long
 * someone will take, and folding in a perfect clock would put the percentage
 * out of reach by construction.
 * ------------------------------------------------------------------------- */
export function maximise(rack, candidates, layout, isWord) {
  const n = candidates.length;

  /* Each word as (letterIndex, count) pairs — at most four, so adding and
     removing a word from the tally is a handful of operations rather than a
     sweep of the alphabet. */
  const pairs = candidates.map((w) => {
    const c = countLetters(w);
    const out = [];
    for (let i = 0; i < 26; i++) if (c[i]) out.push(i, c[i]);
    return out;
  });

  /* across score for every (word, row) pair, and the face value of every
     letter of every word, computed once */
  const across = [];
  for (let r = 0; r < 4; r++) {
    const row = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const w = candidates[i];
      let base = 0, mult = 1;
      for (let c = 0; c < 4; c++) {
        const code = layout[r][c];
        base += letterValue(w[c]) * letterMult(code);
        mult *= wordMult(code);
      }
      row[i] = base * mult;
    }
    across.push(row);
  }
  const face = new Int32Array(n * 4);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 4; c++) face[i * 4 + c] = letterValue(candidates[i][c]);

  const remaining = countLetters(rack);

  /* An admissible ceiling on what rows d..3 can still add, used to abandon a
     branch that cannot catch the best line found so far. Loose, but it only
     has to be cheap and never optimistic in the wrong direction. */
  let maxFace = 0;
  for (let i = 0; i < 26; i++) if (remaining[i]) maxFace = Math.max(maxFace, letterValue(String.fromCharCode(97 + i)));
  const rowCeiling = new Int32Array(4);
  for (let r = 0; r < 4; r++) {
    let a = 0;
    for (let i = 0; i < n; i++) if (across[r][i] > a) a = across[r][i];
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const code = layout[r][c];
      d += (r * maxFace + maxFace * letterMult(code)) * wordMult(code) * (DOWN_MULT[r + 1] || 1);
    }
    rowCeiling[r] = a + d;
  }
  const tail = new Int32Array(5);
  for (let r = 3; r >= 0; r--) tail[r] = tail[r + 1] + rowCeiling[r];

  const picked = new Int32Array(4);
  const colStr = ["", "", "", ""];
  let best = -1;
  let bestWords = null;
  let nodes = 0;

  function downScore(r) {
    let sum = 0;
    const wi = picked[r];
    for (let c = 0; c < 4; c++) {
      if (!isWord(colStr[c])) continue;
      let base = 0;
      for (let i = 0; i < r; i++) base += face[picked[i] * 4 + c];
      base += face[wi * 4 + c] * letterMult(layout[r][c]);
      sum += base * wordMult(layout[r][c]) * DOWN_MULT[r + 1];
    }
    return sum;
  }

  /* `live` is the candidate list narrowed to what the remaining tiles still
     allow. Narrowing once per level instead of rescanning the whole dictionary
     at every node is most of the speed. */
  function dfs(depth, live, soFar) {
    if (depth === 4) {
      if (soFar > best) {
        best = soFar;
        bestWords = [0, 1, 2, 3].map((k) => candidates[picked[k]]);
      }
      return;
    }
    if (soFar + tail[depth] <= best) return;

    const next = [];
    for (let x = 0; x < live.length; x++) {
      const i = live[x];
      const p = pairs[i];
      let ok = true;
      for (let k = 0; k < p.length; k += 2) if (p[k + 1] > remaining[p[k]]) { ok = false; break; }
      if (ok) next.push(i);
    }

    for (let x = 0; x < next.length; x++) {
      const i = next[x];
      const p = pairs[i];
      for (let k = 0; k < p.length; k += 2) remaining[p[k]] -= p[k + 1];
      picked[depth] = i;
      const w = candidates[i];
      for (let c = 0; c < 4; c++) colStr[c] += w[c];
      nodes++;
      dfs(depth + 1, next, soFar + across[depth][i] + (depth ? downScore(depth) : 0));
      for (let c = 0; c < 4; c++) colStr[c] = colStr[c].slice(0, -1);
      for (let k = 0; k < p.length; k += 2) remaining[p[k]] += p[k + 1];
    }
  }

  const all = [];
  for (let i = 0; i < n; i++) all.push(i);
  dfs(0, all, 0);
  return { best: best < 0 ? 0 : best, bestWords, nodes };
}

/* Kept for diagnostics and for the in-game "show me a word", which asks only
   for the first solution it can find. */
export function bestScore(solutions, layout, isWord) {
  let best = 0;
  let bestWords = null;
  for (const sol of solutions) {
    for (const order of ORDERS) {
      const words = [sol[order[0]], sol[order[1]], sol[order[2]], sol[order[3]]];
      const s = scorePlacement(words, layout, isWord).total;
      if (s > best) { best = s; bestWords = words.slice(); }
    }
  }
  return { best, bestWords };
}

/* ---------------------------------------------------------------------------
 * Seeded randomness (mulberry32 on a hashed string)
 * ------------------------------------------------------------------------- */
export function rngFor(seedString) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedString.length; i++) {
    h ^= seedString.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* The tablecloth behind the board. Twelve classics, one per day in rotation
   with the pattern and the palette drifting independently, so the board never
   looks quite the same two weeks running. */
export const CLOTHS = [
  "gingham", "tartan", "check", "stripe", "polka", "windowpane",
  "houndstooth", "ticking", "madras", "plaid", "dot", "weave",
];
