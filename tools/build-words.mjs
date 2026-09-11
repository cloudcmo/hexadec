/* tools/build-words.mjs — rebuilds public/words.js.
 *
 * Hexadec needs three lists and they do different jobs:
 *
 *   FOURS  the play dictionary. What the game will accept as one of your four
 *          words, and — just as important — the set the maximum score is
 *          searched over. A word in here that no human would ever find does
 *          not make the game richer, it makes everyone's percentage worse.
 *   THREES ) the same, for the two, three and four letter words that score as
 *   TWOS   ) bonuses when a column happens to read as a word.
 *
 * and one more that never ships to the browser:
 *
 *   tools/data/common4.txt  the TARGET POOL. The four words a day is built
 *          from come from here and nowhere else, so the day is always solvable
 *          by someone with an ordinary vocabulary.
 *
 * Source: SCOWL British "huge" (level <=80), the same free-licence list the
 * rest of the Guff games use — the well-known tournament lists are publisher
 * property and cannot be redistributed. SCOWL licence: free use with notice,
 * http://wordlist.aspell.net/scowl-readme/
 *
 * SCOWL at level 80 carries a lot that is not a word for our purposes: ACCT,
 * BLVD, DEPT, ECOL, SHPT, RONG, TIRR, YOHO. Those are listed in
 * tools/data/junk4.txt and junk3.txt and removed here. If a player ever
 * complains that a real word was refused, the fix is to delete that line from
 * the junk file and rebuild — never to widen the dictionary wholesale, because
 * every word added is a word the maximum score assumes you could have found.
 *
 * Run:  npm run words                 (uses /usr/share/dict/british-english-huge)
 *       node tools/build-words.mjs ../guffinoes/public/words.js
 *         — the Guff family's existing dictionary works as a source too, and
 *           saves installing wbritish-huge just to rebuild.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DATA = path.join(HERE, "data");
const OUT = path.join(ROOT, "public", "words.js");
const SRC = process.argv[2] || "/usr/share/dict/british-english-huge";

/* The curated two-letter list. SCOWL's two-letter entries are mostly
   abbreviations (bd, cc, kg, vs), so this is the recognised playable set,
   inherited from Guffinoes where it earns the same keep. */
const TWOS = `
aa ab ad ae ag ah ai al am an ar as at aw ax ay
ba be bi bo by
ch
da de di do
ea ee ef eh el em en er es et ew ex
fa fe fy
gi go gu
ha he hi hm ho
id if in io is it
ja jo
ka ki ko ky
la li lo
ma me mi mm mo mu my
na ne no nu ny
ob od oe of oh oi ok om on oo op or os ou ow ox oy
pa pe ph pi po
qi
re
sh si so st
ta te ti to
ug uh um un up ur us ut
we wo
xi xu
ya ye yo yu
za zo
`.trim().split(/\s+/);

function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
}

/* Accepts either a newline word list or another Guff game's words.js. */
function readSource(file) {
  if (!fs.existsSync(file)) {
    console.error(`Source word list not found: ${file}

Either install the SCOWL British huge list:
    sudo apt install wbritish-huge
or point this at another Guff game's dictionary:
    node tools/build-words.mjs ../guffinoes/public/words.js`);
    process.exit(1);
  }
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".js")) {
    const m = text.match(/const WORDS_RAW\s*=\s*"([^"]*)"/);
    if (!m) { console.error(`No WORDS_RAW found in ${file}`); process.exit(1); }
    return m[1].split(" ");
  }
  return text.split("\n");
}

const src = readSource(SRC).map((w) => w.trim().toLowerCase());

const junk4 = new Set(readList(path.join(DATA, "junk4.txt")));
const junk3 = new Set(readList(path.join(DATA, "junk3.txt")));
const offensive = new Set(readList(path.join(DATA, "offensive.txt")));
const common4src = new Set(readList(path.join(DATA, "common4.txt")));

const fours = src.filter((w) => /^[a-z]{4}$/.test(w) && !junk4.has(w) && !offensive.has(w));
const threes = src.filter((w) => /^[a-z]{3}$/.test(w) && !junk3.has(w) && !offensive.has(w));
const twos = TWOS.filter((w) => !offensive.has(w));

const F = [...new Set(fours)].sort();
const T3 = [...new Set(threes)].sort();
const T2 = [...new Set(twos)].sort();

/* The target pool has to be a subset of the play dictionary, or a day could be
   built around a word the game then refuses. */
const fourSet = new Set(F);
const common4 = [...common4src].filter((w) => fourSet.has(w)).sort();
const dropped = [...common4src].filter((w) => !fourSet.has(w));
if (dropped.length) {
  console.warn(`warning: ${dropped.length} target-pool words are not in the play dictionary and were dropped: ${dropped.slice(0, 12).join(" ")}${dropped.length > 12 ? " ..." : ""}`);
}
if (common4.length < 400) {
  console.error(`Target pool is only ${common4.length} words. That is too few for a year of distinct days — check tools/data/common4.txt.`);
  process.exit(1);
}
fs.writeFileSync(path.join(DATA, "common4.txt"), common4.join("\n") + "\n");

/* Letter frequency across the target pool — the basis for VALUES in
   public/engine.js. Printed on every build so that if the pool is ever
   re-cut, the drift is visible rather than silent. */
const freq = {};
let n = 0;
for (const w of common4) for (const ch of w) { freq[ch] = (freq[ch] || 0) + 1; n++; }
const dist = Object.entries(freq).sort((a, b) => b[1] - a[1])
  .map(([l, k]) => `${l.toUpperCase()}${(k / n * 100).toFixed(2)}`).join(" ");

const header = `/* Hexadec word data — built by tools/build-words.mjs. Do not hand-edit.
   FOURS  ${F.length} four-letter words: the play dictionary, and the set the
          maximum score is searched over.
   THREES ${T3.length} three-letter and TWOS ${T2.length} two-letter words, for the
          column bonuses. The two-letter list is curated, not imported.
   Built from SCOWL British "huge" with tools/data/junk4.txt, junk3.txt and
   offensive.txt removed. SCOWL: http://wordlist.aspell.net/scowl-readme/
   Target-pool letter frequency at build time (%):
   ${dist} */
`;

const body = `export const FOURS = "${F.join(" ")}";
export const THREES = "${T3.join(" ")}";
export const TWOS = "${T2.join(" ")}";
`;

fs.writeFileSync(OUT, header + body);

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`public/words.js written: ${F.length} fours, ${T3.length} threes, ${T2.length} twos (${kb}KB)`);
console.log(`target pool: ${common4.length} common four-letter words`);
console.log(`letter frequency: ${dist}`);
