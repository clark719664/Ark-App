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

### Managing your team

**Dashboard** — your record, power rank, playoff odds and luck at a glance, a
"before kickoff" list of the few things actually worth doing this week, the live
scoreboard, and plain-language reads on what the numbers say about the league.

**Start / Sit** — the highest-value screen here, because over a season lineup
mistakes cost more than every waiver claim combined. Ark solves for the best
legal lineup your roster can produce, tells you exactly which changes to make
and what each is worth, flags starters who are on bye or ruled out, and gives
you a win probability for the week — projected from the lineups both teams can
actually field, so an opponent with three starters out is priced accordingly.

**Waiver wire** — every free agent scored by how much he raises your best
possible lineup, not by raw projection. A great receiver is worth nothing to you
if you already start three better ones, and a mediocre defense is worth a lot
the week yours is on bye. Targets say why they matter, who they'd displace, and
how likely they are to clear waivers.

**Trades** — deals where *both* rosters end up projecting more points, which is
the only kind anyone accepts. Each idea shows what both sides gain and how
evenly, with a plain-English reason. Alongside it: buy-low and sell-high
candidates, based on how far a player's last week has pulled away from his own
season baseline.

### Looking at the league

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

### Research

**Players** — the pool, searchable and filterable by position, availability and
season/average/projected points.

**Draft board** — a live board for draft night. Every available player grouped
into **tiers**, so you can see when a position is about to fall off a cliff;
best-available ranked by **value over replacement**, so cross-position
comparison means something; one click to cross a player off, one to claim him.
State is kept in `localStorage`, so a refresh mid-draft costs you nothing. Past
draft results show up in a second tab.

### When the numbers aren't there

Every ranking depends on a projection, and a scrape can come back without one.
Rather than quietly ranking everyone at zero, Ark grades each sync: if weekly
projections are missing it falls back to season averages and says so on the
page; if there is no scoring data at all it says the rankings are not reliable
and points you at `yahoo:capture`. A tool that is wrong is worse than a tool
that admits it does not know.

### One value function, used everywhere

Start/Sit, the waiver wire and the trade finder all ask the same question: *what
is the best legal lineup these players can produce this week?* A free agent is
worth the amount he raises that number; a trade is worth taking when it raises
it for both sides.

Doing it this way rather than with per-position rules of thumb is what makes the
answers trustworthy in the awkward cases — a flex spot the new player would take
instead, a starter on bye, a second tight end who cannot start because there is
only one slot for him.

### How playoff odds are computed

Every remaining game is simulated from each team's own scoring distribution —
its observed mean and spread, shrunk toward the league average so that one
180-point week doesn't convince the model a mediocre team is a juggernaut. Final
standings are sorted by wins with points-for as the tiebreak, then a seeded
single-elimination bracket is played out, with byes for the top seeds. That runs
20,000 times.

The result is deterministic for a given snapshot: the same data always produces
the same odds.

## Trusting the output

The Yahoo scrapers are the one part of Ark that cannot be verified against the
real thing by its author, so they are built to be checkable by you:

- **Fixture tests** run every scraper in a real browser against synthetic
  Yahoo-shaped pages, including the awkward cases — renamed columns, reordered
  columns, missing projections, and minified markup where adjacent elements run
  together. These caught two genuine bugs that fixtures with friendlier
  whitespace had hidden.
- **Calibration tests** run those same scrapers against *your* captured pages in
  `.cache/raw/`. They skip until you have run `yahoo:capture`, and once you have,
  a failure names the page and the field rather than leaving you to guess.
- **Data-quality grading** on every sync, surfaced in the app.

```bash
npm run yahoo:capture   # save your real pages
npm test                # check the parsers against them
```

## What Ark deliberately does not do

Ark is read-only. It never sets your lineup, submits a waiver claim, or proposes
a trade on your behalf — it tells you what to do and you do it in Yahoo. Driving
a browser to *read* your own league is one thing; having software take roster
actions on your account without you watching is another, and it is not a line
worth crossing for a few saved clicks.

It also doesn't try to replace the parts of Yahoo that are Yahoo: live scoring
push notifications, league chat, mock drafts, or the transaction log. Keep the
app for those. Ark is the analysis layer on top.

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
you only want scores), `--headed` to watch it work, and `--fresh` to start over
rather than resume.

A sync is a few dozen page loads at a deliberate pace, so it checkpoints as it
goes. If one fails partway through — a lapsed session, a flaky page, a closed
laptop — re-running it picks up from the last completed stage instead of walking
everything again.

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
  history.ts           Archive of past syncs, for real week-over-week movement
  analytics/
    index.ts           Power rankings, luck, schedule strength, playoff odds
    matchup.ts         Weekly win probability from each side's actual lineup
    lineup.ts          The shared "best legal lineup" solver
    waivers.ts         Free agents scored by marginal lineup value
    trades.ts          Two-sided trade search, buy-low / sell-high
    slots.ts           Lineup slot eligibility (FLEX, superflex, IDP)
  providers/demo.ts    The deterministic fake league
  routes.ts            HTTP API
src/
  pages/               Dashboard, Start/Sit, Waivers, Trades, Standings,
                       Matchups, Team, Players, Draft board, Analytics
  lib/tiers.ts         Tier breaks and value over replacement
```

## Adding another platform

The rest of the app only knows `shared/types.ts`. To add ESPN or Sleeper, write
something that produces a `LeagueSnapshot` and point `getSnapshot()` in
`server/store.ts` at it. Nothing in the analytics engine or the UI needs to
change.
