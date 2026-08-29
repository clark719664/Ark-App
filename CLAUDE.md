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
