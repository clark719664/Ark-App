# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Ark is a private fantasy football hub for a Yahoo league. It reads the league
through a real browser the user signs into, computes analytics locally, and
serves a React app. Nothing leaves the user's machine.

## Commands

```bash
npm run dev                 # API (8787) + Vite (5173) together
npm test                    # full suite
npm test -- risk            # single file by name fragment
npx vitest run server/analytics/risk.test.ts   # single file by path
npm run typecheck           # client and server tsconfigs, both must pass
npm run build               # typecheck server + vite build

npm run yahoo:login         # one-time interactive sign-in, opens a real browser
npm run yahoo:sync          # scrape the league into .cache/league.json
npm run yahoo:capture       # save raw HTML + Yahoo's own JSON calls for debugging
npm run sim 2500            # play N simulated seasons, score the strategies
npm run data:fetch          # download ~50MB of open NFL data (nflverse)
npm run data:analyse        # rebuild data/derived/football.json from it
```

`yahoo:sync` takes `--fresh` (ignore checkpoint), `--skip-players`, `--headed`.

With no `.env` the app runs on a generated demo league — zero config, useful
for any UI or analytics work.

## Architecture

The central design decision is that **sync and serve are separate**:

```
Chrome (user's login) → scrapers → .cache/league.json → Express API → React
       npm run yahoo:sync                    npm run dev
```

Only `yahoo:sync` touches Yahoo. The API reads the cached snapshot and never
makes a network call, so the hub stays fast, works offline, and survives a
lapsed session. `shared/types.ts` is the contract every layer speaks — a Yahoo
redesign can only break `server/yahoo/`, never anything above it.

### One value function

`bestLineup()` in `server/analytics/lineup.ts` answers "what is the best legal
lineup these players can produce this week", and Start/Sit, waivers and trades
all reduce to it. A free agent is worth what he raises that number by; a trade
is worth taking when it raises it for both sides. Prefer extending this over
adding a parallel valuation.

### Two questions that must stay separate

`projectionOf()` answers *who do I start this week*. `rosterValue()` answers
*who do I add or drop*, blending the weekly projection with season-long form.

This is not a stylistic preference. Ranking add/drop candidates by a single
week's projection selects for whichever estimate got the luckiest noise — the
optimizer's curse — and in simulation it cost about 13 points of true roster
talent per season and flipped a championship lead into a deficit. If you find
yourself using a weekly projection for a roster decision, that is the bug
returning.

### Comparing scenarios

`server/analytics/season.ts` simulates the rest of the season; `impact.ts`
prices trades and waiver claims as a change in playoff and title probability.
Scenarios **must** share a `RandomBlock` (common random numbers), and draws are
indexed by (simulation, game, side) rather than consumed from a stream — an
extra draw in one scenario would shift every later value and destroy the
pairing. Measured: paired draws give a stable reading where independent draws
swing ±0.9pp, which is larger than most effects being measured.

## Working with the Yahoo scrapers

**The scrapers have never been run against a live Yahoo account.** They were
written against the documented page structure and synthetic fixtures. Treat
them as uncalibrated.

- Columns are found **by header name**, never by position
  (`server/yahoo/dom.ts`). A reordered column is a non-event; a renamed one
  produces a warning rather than silent zeroes. Do not introduce
  `tr:nth-child(3) td:nth-child(5)` style selectors.
- `extractTables`/`extractAnchors` walk text nodes and join with spaces.
  `textContent` concatenates adjacent elements, so `<a>Team 2</a><span>99.30`
  reads as "Team 299.30" and a score parses as 299.3. This bit twice.
- `server/yahoo/scrape.test.ts` runs the real scrapers in a browser against
  synthetic pages via request interception.
- `server/yahoo/calibration.test.ts` runs the same scrapers against **real**
  captured pages in `.cache/raw/`. It skips until `npm run yahoo:capture` has
  been run. When it fails it names the page and the field — that is the fastest
  path from "the numbers look wrong" to a fix.

Every sync is graded (`assessDataQuality`). When projections are missing the
tools fall back to season averages and say so on the page rather than
presenting a guess as a ranking.

## Numbers come from data, not intuition

`data/derived/football.json` holds constants measured from 26 seasons of
nflverse data (1999–2024). Raw data is gitignored; the derived file is
committed so the app ships measured and runs without the dataset.

Do not hand-edit constants that live there. Change the analysis in
`data/analysis/` and re-run `npm run data:analyse`.

What is measured today: weekly volatility as `sd = intercept + slope × mean`
per position (a constant coefficient of variation is the wrong shape — the
intercepts are large), how much hot and cold streaks persist (24% and 57%, they
are not symmetric), within-player age curves, breakout rates by signal, and
injury recovery by weeks missed and body part.

## The draft board runs without a league

A draft happens before a league has anything to sync, so the board reads a
committed pool (`data/derived/draft-pool-2026.json`, rebuilt with
`npm run data:draft`) rather than `.cache/league.json`. A fresh clone can run a
live draft with nothing but `npm run dev`.

Ranking is value over replacement, not projected points. Raw points put nine
quarterbacks in the top twenty, and in a one-quarterback league the twelfth best
quarterback is nearly as good as the third, so none of them is worth an early
pick. `rankPool()` also drops any position the league does not start — which is
how a league with no IDP slots avoids a board carrying four hundred linebackers.

**nflverse leaves `fantasy_points` blank for kickers and defenders.** The raw
events are all there; nothing sums them. So kicker, team defence and individual
defender scoring are all computed in `data/draft/` from the underlying events —
field goals by distance, and for defences sacks, takeaways, return touchdowns
and points allowed. Points allowed is the one component absent from the
defensive columns entirely, so it is derived from what the opponent scored, and
`pointsScored()` excludes `receiving_tds` because the passing touchdown on the
same play is already counted.

Two things that look like oversights and are not:

- Defences regress much harder than players (`confidence` caps at 0.55): a unit
  carried by a takeaway rate that will not repeat looks elite in hindsight.
- Depth chart rank is not applied to defensive players. The measured gap is
  large, but nearly all of it is already inside their own production, earned on
  back-up snaps. The multiplier exists to catch a *changed* role, and telling a
  promotion from a career back-up needs two depth chart snapshots. Only the
  current one is published, so it stays unapplied rather than guessed.

IDP replacement levels (LB 6.7, DB 6.2, DL 3.9 points a game) are the 24th best
player at each group last season — the last starter in a twelve team league
starting two of each. A single shared IDP replacement level would badly misprice
linemen against linebackers.

## The simulation is a test, not a demo

`npm run sim` plays the shipped analytics as a manager against rival strategies
over thousands of seasons. It found the roster-decay bug described above, which
every unit test had passed straight through.

Two properties keep it honest and should be preserved: agents never see the
hidden truth (they get noisy projections), and the world is deliberately
misspecified against Ark's own assumptions (right-skewed gamma scores against a
risk model that assumes normal). A model that only wins when handed its own
assumptions has proved nothing.

## Conventions and constraints

- The server binds `127.0.0.1` by default. `POST /api/sync` drives a browser
  holding a live Yahoo session, so it must not be network-reachable.
- Ark is **read-only** with respect to Yahoo. It never sets a lineup, submits a
  claim, or sends a trade. Keep it that way.
- `.cache/` and `.browser-profile/` hold the user's league data and a live
  logged-in session. Both are gitignored; never commit them or paste their
  contents anywhere.
- Strict TypeScript with `noUncheckedIndexedAccess`. Both tsconfigs must pass.
- `tsconfig.server.json` covers `server`, `shared`, `sim` and `data`;
  `tsconfig.json` covers `src` and `shared`.
