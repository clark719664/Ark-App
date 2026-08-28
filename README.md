# Ark — Fantasy Football Hub

A private hub for your Yahoo fantasy football league: standings with the numbers
that actually predict the rest of the season, a live draft board, player
research, and Monte Carlo playoff odds.

Everything runs on your machine. Your league data never leaves it.

<!-- Screens: Dashboard, Standings, Analytics, Draft board -->

## Why it works the way it does

Yahoo has closed new Fantasy Sports OAuth app registrations, so there is no
token you can go get for your league. Ark takes the other route: it drives a
real Chrome window that **you** sign into once, keeps that session in a browser
profile on disk, and reads your league through it.

The pipeline is deliberately split in two:

```
  Chrome (your login)  →  scraper  →  .cache/league.json  →  API  →  React hub
  ─────── npm run yahoo:sync ──────    ──────────── npm run dev ────────────
```

Only `yahoo:sync` talks to Yahoo. The hub reads the cached snapshot and nothing
else, which means it stays fast, keeps working when Yahoo is slow or your
session lapses, and can be used on a plane. It also means the UI is completely
insulated from Yahoo's markup: a Yahoo redesign can only break the adapters in
`server/yahoo/`.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173. You will see a generated **demo league** — twelve
teams, a full season of results, a player pool and a draft. Everything works, so
you can see what the hub does before wiring up your own league.

## Connecting your Yahoo league

**1. Find your league id.** It's the number in your league URL:

```
https://football.fantasysports.yahoo.com/f1/123456
                                            ^^^^^^
```

**2. Fill in `.env`:**

```ini
FF_PROVIDER=yahoo
YAHOO_LEAGUE_ID=123456
YAHOO_TEAM_ID=4          # optional: your team's number, to highlight it
BROWSER_CHANNEL=chrome   # uses your installed Chrome
```

**3. Sign in, once:**

```bash
npm run yahoo:login
```

A Chrome window opens on Yahoo Fantasy. Log in — including 2FA, or whatever
Yahoo asks for. The window closes itself once it sees you're through. Your
session is saved to `.browser-profile/` and reused from then on.

**4. Pull your league:**

```bash
npm run yahoo:sync
```

This walks your standings, every week's scoreboard, all rosters, the free-agent
pool and the draft results, then writes `.cache/league.json`.

**5. Run it:**

```bash
npm run dev
```

Re-run `yahoo:sync` whenever you want fresh data — before you set your lineup,
after Sunday's games. There's a refresh button in the app's top-right that runs
the same thing.

### If a sync comes back thin

Ark can't be tested against a live Yahoo account by its author, so treat the
first sync as a calibration run. It reports warnings for anything it couldn't
read rather than silently filling in zeroes. When something looks wrong:

```bash
npm run yahoo:capture
```

This opens your league in a visible browser and records what Yahoo actually
served:

| Location | What's in it |
| --- | --- |
| `.cache/raw/*.html` | The rendered page, after Yahoo's JavaScript ran |
| `.cache/raw/*.png` | Full-page screenshots |
| `.cache/net/*.json` | Every JSON payload Yahoo's own frontend fetched |
| `.cache/capture-index.json` | Index of both, with URLs and sizes |

The JSON dumps are the interesting ones. Yahoo's frontend fetches a fair amount
of its own data, and a JSON endpoint is far more stable to read than markup — if
a capture turns one up that holds your league, wire it into
`server/yahoo/scrape.ts` in place of the HTML parser.

The HTML parsers are built to survive ordinary change: they find columns by
header name (`server/yahoo/dom.ts`), never by position. A reordered column is a
non-event; a renamed one produces a named warning instead of wrong numbers.

## What's in the hub

**Dashboard** — your record, power rank, playoff odds and luck at a glance, the
live scoreboard, and a few plain-language reads on what the numbers say about
the league.

**Standings** — the usual columns, plus the ones that matter:

- **All-play** — each team's record if it had played *every* team every week. It
  strips schedule luck out entirely.
- **Luck** — actual wins minus the wins all-play implies. Positive means a team
  has been winning more than it has earned, and is due to come back to the pack.
- **Power** — a composite weighted toward scoring (40%), recent form (25%),
  record (20%) and consistency (15%), because points predict future wins and a
  record built on narrow escapes does not.

**Matchups** — week-by-week scoreboard with projections, for any week.

**Analytics** — playoff and title odds, luck across the league, a scoring-vs-
consistency plot, weekly scoring for every team, and remaining strength of
schedule.

**Players** — the pool, searchable and filterable by position, availability and
season/average/projected points.

**Draft board** — a live board for draft night. Every available player grouped
into **tiers**, so you can see when a position is about to fall off a cliff;
best-available ranked by **value over replacement**, so cross-position
comparison means something; one click to cross a player off, one to claim him.
State is kept in `localStorage`, so a refresh mid-draft costs you nothing. Past
draft results show up in a second tab.

### How playoff odds are computed

Every remaining game is simulated from each team's own scoring distribution —
its observed mean and spread, shrunk toward the league average so that one
180-point week doesn't convince the model a mediocre team is a juggernaut. Final
standings are sorted by wins with points-for as the tiebreak, then a seeded
single-elimination bracket is played out, with byes for the top seeds. That runs
20,000 times.

The result is deterministic for a given snapshot: the same data always produces
the same odds.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API and web app together, with hot reload |
| `npm run yahoo:login` | Sign in to Yahoo, once |
| `npm run yahoo:sync` | Pull your league into `.cache/league.json` |
| `npm run yahoo:capture` | Record what Yahoo actually serves, for debugging |
| `npm test` | Run the test suite |
| `npm run typecheck` | Typecheck client and server |
| `npm run build` | Build for production |
| `npm start` | Serve the production build on one port |

`yahoo:sync` takes `--skip-players` to skip the free-agent pool (much faster when
you only want scores) and `--headed` to watch it work.

## Configuration

All settings live in `.env`; see `.env.example` for the annotated list. The ones
you're most likely to touch:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FF_PROVIDER` | `demo` | `yahoo` for your league, `demo` for the fake one |
| `YAHOO_LEAGUE_ID` | — | The number from your league URL |
| `YAHOO_TEAM_ID` | — | Your team's number, to highlight it |
| `BROWSER_CHANNEL` | `chrome` | Which browser to drive; blank uses Playwright's Chromium |
| `BROWSER_HEADED` | `0` | `1` to watch syncs happen |
| `SCRAPE_DELAY_MS` | `1200` | Pause between page loads |

If you don't have Chrome installed, set `BROWSER_CHANNEL=` (empty) and run
`npx playwright install chromium`.

## A note on your Yahoo session

`.browser-profile/` holds a live, logged-in Yahoo session. **Treat it like a
password** — anyone with that directory can act as you on Yahoo. It's gitignored,
along with `.cache/`, which holds your league's data. Neither should ever be
committed, and neither is sent anywhere: Ark has no server component beyond the
one running on your own machine.

Ark reads your own league at a deliberate, human pace (`SCRAPE_DELAY_MS`). It
doesn't log in for you, doesn't store your password, and doesn't touch anything
you couldn't see yourself in a browser.

## Project layout

```
shared/types.ts        The domain model every layer speaks
server/
  yahoo/
    browser.ts         Persistent-profile browser session + login
    capture.ts         Records raw HTML and Yahoo's own JSON calls
    dom.ts             Header-driven table extraction
    scrape.ts          Standings, scoreboards, rosters, players, draft
    sync.ts            Orchestrates a full sync into a snapshot
  analytics/           Power rankings, luck, schedule strength, playoff odds
  providers/demo.ts    The deterministic fake league
  routes.ts            HTTP API
src/
  pages/               Dashboard, Standings, Matchups, Team, Players, Draft, Analytics
  lib/tiers.ts         Tier breaks and value over replacement
```

## Adding another platform

The rest of the app only knows `shared/types.ts`. To add ESPN or Sleeper, write
something that produces a `LeagueSnapshot` and point `getSnapshot()` in
`server/store.ts` at it. Nothing in the analytics engine or the UI needs to
change.
