# Hexadec

Sixteen lettered tiles. Hidden among them are four four-letter words that use
every tile exactly once. Build one and it lands on the next row of a 4×4 grid,
scored against premium squares. Columns that happen to read as words score too.

The catch, and the whole game: far more words can be made than can be *used*.
Three good words will often leave you holding four letters that spell nothing —
measured at about 85% of the time for a player choosing plausible words without
thinking ahead. So you take one back, and the words below it move up onto
different squares, and everything rescores.

Finish inside five quiet minutes and you keep a point for every five seconds
left, up to 60. There is no clock on screen.

Live at **https://hexadec.carlosfandango.net/** · repo
`github.com/cloudcmo/hexadec` · local `~/code/Hexa`

Eighth of the Guff games, after What Word, Whenly, Pub Quiz Daily, Groupie,
Twentee, Spellbound and Guffinoes.

---

## The shape of it

```
public/engine.js   the rules: tile values, premium layouts, scoring, the search
public/words.js    GENERATED — the play dictionary (3,100 / 980 / 126 words)
public/days.js     GENERATED — 400 days of tiles, layout and maximum score
public/app.js      the game: tiles, taps, animations, saving, the end card
public/index.html  markup and all the styling
src/index.js       the Worker: assets, signup, play stats, the runway alarm
tools/             the build and the measuring kit
```

`engine.js` is imported by the browser **and** by the build tools. That is
deliberate: the "% of the best possible" on the end card is only honest if the
maximum was computed by the same function that scored the player.

---

## Rules, precisely

**Tile values** are banded 1 to 12 and derived from letter frequency across the
2,015-word common four-letter pool, not from general English — four-letter
words inflate S (plurals) and K and W, and starve V, J, Z, X and Q.

```
1  A E O S        2  I L N R T      3  D M P U      4  B C G H
5  F K W          6  Y               8  V           9  J X Z     12  Q
```

**A row word** scores each letter against the square under it, then multiplies
by every word multiplier in that row. All four tiles are newly placed, so all
four premiums are live.

**A column** scores whenever it reads as a real word top to bottom. It can pay
out three times over a game — at two letters, again at three, again at four.
A full four-letter column scores double. The premium rule is the board-game
one: only the square you have just covered is live, so letters placed on
earlier rows contribute face value. An invalid column never blocks a play; a
grid whose rows and columns are all words is a double word square, which is
vanishingly rare, and requiring one would make almost every day unwinnable.

**Taking a word back** removes that row and closes the gap — the rows below
move up. Score is not accumulated; it is recomputed from the ordered list of
words every time that list changes, so there is no way to bank points from a
word and then remove it. `npm run ui` asserts this by placing and removing the
same word ten times.

**The clock** is five minutes, hidden, started on the first tap and paused when
the tab is. What is left of it scores **one point per five seconds**, so the
bonus tops out at 60 against a grid score of 100 to 250. Using *Show me a word*
forfeits it entirely.

It was a point per second to begin with, which paid up to 300 and made the
clock worth more than the puzzle. Shortening the clock to three minutes would
have paid up to 180 and *also* put a hurry on a game meant to be unhurried;
scoring the same five minutes more cheaply fixes the proportion and leaves the
pace alone.

---

## Why the days are built offline

Every other keyless Guff game builds its day in the browser from a date seed.
Hexadec cannot, because a day is only worth serving once three things are
known, and knowing them means an exhaustive search:

1. the sixteen tiles really do hold four whole words;
2. a greedy player can finish it inside four take-backs;
3. the best score the day can possibly give.

That search is a second or so on a laptop and an unkindness on a phone, so
`tools/build-days.mjs` does it once and `public/days.js` ships the answer:
tiles, a layout index, the maximum, and par. About 12KB for 400 days.

Deliberately **not** shipped: the four words the day was cut from, and the line
that achieves the maximum. Both would be sitting in the page source. When the
end card offers *Best line*, it recomputes it from the same dictionary the
player was playing against.

### ⚠️ Regenerate days.js after any rules change

The tile values, `DOWN_MULT`, the premium templates, the dictionary and the
gates in `tools/day.mjs` all move `max`. A stale maximum quietly lies to every
player about how well they did, and nothing will fail loudly. `npm run check`
section 5 catches it — it recomputes a sample of shipped days and compares.

### The one failure mode

The table is finite. It runs out on the date in the header of `days.js`, and
only a laptop can refill it. The daily cron reads the table and emails
`ALERT_EMAIL` once fewer than 45 days remain — six weeks of warning for a
five-minute job:

```
cd ~/code/Hexa
npm run days 400 <the day after the current table ends>
npx wrangler deploy
```

---

## The search

`E.maximise(rack, candidates, layout, isWord)` walks rows 1 to 4 choosing a
word that still fits. Because the rack holds exactly sixteen tiles and every
word is exactly four, **any path that reaches row 4 has used the rack exactly**,
so every complete path is a legal game and no separate partition check is
needed. Row order is part of the search rather than a loop over 24
permutations, so the score of rows 1..r is computed once and carried down.

Three things make it affordable: each word's letters are held as (index, count)
pairs so adding and removing one is a handful of operations; the candidate list
is narrowed once per level rather than rescanned at every node; and a loose
admissible ceiling abandons branches that cannot catch the best line so far.
Typical day: 60–500ms. It was 10× that before the narrowing.

`npm run check` compares it against a deliberately stupid version — every
solution, uncapped, all 24 orders, scored through the same `scorePlacement` the
game uses — on 30 racks. They must agree exactly.

---

## Tuning, and what happened when it was measured

`tools/day.mjs` `GATES` is the whole surface. Change a number, then run
`npm run bot` before believing anything.

**The first instinct was wrong.** The plan was to make complete solutions
scarce so players would strand themselves. Measurement killed it: a random rack
cut from four ordinary words has *thousands* of complete solutions, and a
player picking plausible words at random still strands about 84% of the time,
because the makeable words (100–450 of them) vastly outnumber the ones that
finish. The trap is free. What has to be protected is the other side — the day
being finishable by someone thinking reasonably — and that gets *better* as
solutions get denser. Hence `solutionsMin: 60`, not a maximum.

The real acceptance test is `parBudget`: a greedy player, allowed four
take-backs, must finish. A day nobody sensible can close is not a hard day, it
is a broken one. Before that gate went in, a greedy player failed on 23% of
days. After it, 0%. Its score becomes par.

`DOWN_MULT` is a seesaw and the comment in `engine.js` carries the measured
numbers: raising it lifts the ceiling but lowers everyone's percentage, because
only an exhaustive search reliably finds full columns. At 1 the maximum sits at
189 and a greedy player takes 74% of it; at 2, 209 and 67%; at 3, 249 and 58%.
Two is the compromise.

Current 400-day table: maximum score min 170, median **200**, max 296. Par
median 132.

---

## Tools

```
npm run serve     static server on :8787 — everything else drives this
npm run check     engine unit checks, including maximum-vs-brute-force
npm run ui        the real game in a real browser, four viewports
npm run bot 60    difficulty report: strand rate, par, % of maximum
npm run days 400  regenerate public/days.js  (~5 minutes)
npm run words     regenerate public/words.js
```

`npm run ui` needs `npm i -D playwright`. In the Anthropic cloud sandbox the
bundled Chromium does not match the npm package's revision, so point at it
rather than patching the file:

```
HX_CHROMIUM=/opt/pw-browsers/chromium npm run ui
```

Module scripts do not load from `file://`, so opening `public/index.html`
directly will not work — use `npm run serve`.

Test hook: `window.__hx` = {S, E, isWord, FOUR_LIST, currentScore, placeWord,
stage, takeBack, showMeAWord, shareText, finish, timeBonus, state()}.

---

## The dictionary

Source is SCOWL British "huge" (level ≤80), the same free-licence list the rest
of the family uses; the well-known tournament lists are publisher property and
cannot be redistributed. SCOWL licence: free use with notice,
http://wordlist.aspell.net/scowl-readme/

SCOWL at level 80 carries a great deal that is not a word for our purposes —
ACCT, BLVD, DEPT, ECOL, SHPT, RONG, TIRR, YOHO. Those are listed in
`tools/data/junk4.txt` and `junk3.txt` and removed, taking 5,178 four-letter
entries down to 3,100. This matters more here than in a normal word game:
**every word in the dictionary is a word the maximum score assumes you could
have found**, so junk in the list makes everyone's percentage worse.

Three lists come out of it:

| | words | job |
|---|---|---|
| `FOURS` | 3,100 | what the game accepts, and what the maximum is searched over |
| `THREES` / `TWOS` | 980 / 126 | column bonuses; the twos are curated, not imported |
| `tools/data/common4.txt` | 2,015 | the **target pool** — the four words a day is cut from. Never shipped to the browser. |

The target pool is what keeps a day fair: the four words it was built from are
always ordinary vocabulary, even though obscure words remain playable.

**If a player reports a real word being refused**, delete that line from
`tools/data/junk4.txt` and run `npm run words`, then `npm run days` — never
widen the dictionary wholesale.

Blocklist in `tools/data/offensive.txt`, same policy as the other Guff games:
never playable, and `npm run check` asserts none of it leaked back in.

### ⚠️ Standing rule
**No reference to the other tile game anywhere** — not in copy, not in code
comments. Same rule as Guffinoes, same reason. Say "a familiar shape,
deliberately not identical to anyone else's" if a comparison is unavoidable.
The premium colours are a cool pair (letter bonuses) and a warm pair (word
bonuses), chosen to look nothing like the famous blue/pink/red, and every
premium square carries its own label so the board reads correctly in
greyscale rather than relying on colour at all.

---

## In the Guff canon

- **The bar** — `index.html` includes `guff-bar.js` with `data-game="hexadec"`;
  the end of the game calls `GuffBar.completedToday`. The node is *moved* into
  the end card rather than re-rendered, because a second `completedToday` would
  report the day twice.
- **The league** — submits grid score + time bonus, `max: 360`, display
  `"166 · 58%"`.
- **The docket, the hub and the league page** need changes in *other* repos
  before any of this shows up. See the deploy notes below.

## Infrastructure

- **D1** `hexadec`, `plays` table (aggregate only, no accounts).
- **Secrets**: `RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `ADMIN_TOKEN`. Mirror the
  admin token on the PQD Netlify site as `HEXADEC_ADMIN_TOKEN` or the 06:00
  daily report's Hexadec card reads "unreachable".
- **Var**: `ALERT_EMAIL` (carl@mesnerlyons.com — the inbox that is actually
  watched).
- **Cron** 06:35 UTC: the day-table runway check. No API key, no model call.
- Routes: `/api/subscribe`, `/api/played`, `/api/day`, `/api/stats`,
  `/api/health`.
- localStorage: `hexadec-<date>`, `hexadec-sent-<date>`, `hexadec-rules-seen`.
- Custom domain in the **Cloudflare dashboard**, not `wrangler.toml` — a routes
  block and the dashboard fight over route ownership.

## Still open

- The clock starts on the first tap, so it is possible to study the tiles for
  a while before starting. Self-limiting, and kind to a thoughtful player.
- No archive of past days, deliberately: the daily stays scarce.
- The clock starts on the first tap, so it is possible to study the tiles before
  starting. Self-limiting, and kind to a thoughtful player.
