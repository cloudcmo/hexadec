-- Hexadec play stats. Aggregate only: no accounts, no per-player rows.
-- Apply with:  npm run db:remote
CREATE TABLE IF NOT EXISTS plays (
  date         TEXT PRIMARY KEY,
  total        INTEGER NOT NULL DEFAULT 0,  -- games finished
  completions  INTEGER NOT NULL DEFAULT 0,  -- all four rows filled
  score_sum    INTEGER NOT NULL DEFAULT 0,  -- grid score + time bonus
  words_sum    INTEGER NOT NULL DEFAULT 0,  -- grid score alone
  seconds_sum  INTEGER NOT NULL DEFAULT 0,
  pct_sum      INTEGER NOT NULL DEFAULT 0,  -- % of the best possible
  helped       INTEGER NOT NULL DEFAULT 0   -- games that used "show me a word"
);
