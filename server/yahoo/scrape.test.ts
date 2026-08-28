import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { scrapeDraft, scrapeRoster, scrapeScoreboard, scrapeStandings, scrapePlayers, type ScrapeContext } from './scrape.js'
import {
  DEFAULT_ROSTER, LEAGUE_ID, playersPage, rosterPage, scoreboardPage, standingsPage,
} from './fixtures/build.js'

/**
 * The scrapers, run end to end against synthetic Yahoo-shaped pages.
 *
 * Requests to the Yahoo host are intercepted and fulfilled from a fixture, so
 * every function under test runs exactly as it does in production — real
 * navigation, real DOM, real extraction — without a network or an account.
 *
 * These tests cannot prove Ark matches today's Yahoo markup; only a capture
 * from a live league can do that. What they do prove is that the parsing
 * strategy is sound and that the known failure modes behave: a renamed column
 * warns instead of returning zeroes, a reordered one is a non-event, and a
 * missing projection column is visible rather than silent.
 */

let browser: Browser
let context: BrowserContext
let page: Page

/** Whatever HTML the next navigation should receive. */
let currentHtml = ''

function executablePath(): string | undefined {
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH']
  if (!root) return undefined
  const link = path.join(root, 'chromium')
  return fs.existsSync(link) ? link : undefined
}

beforeAll(async () => {
  const exe = executablePath()
  browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) })
  context = await browser.newContext()

  await context.route('**://football.fantasysports.yahoo.com/**', (route) => {
    void route.fulfill({ status: 200, contentType: 'text/html', body: currentHtml })
  })

  page = await context.newPage()
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

function ctx(warnings: string[]): ScrapeContext {
  return { page, leagueId: LEAGUE_ID, warn: (m) => warnings.push(m) }
}

function serve(html: string): void {
  currentHtml = html
}

describe('scrapeStandings', () => {
  it('reads teams, records and points from a standard table', async () => {
    serve(standingsPage())
    const warnings: string[] = []
    const teams = await scrapeStandings(ctx(warnings))

    expect(teams).toHaveLength(3)
    expect(teams[0]).toMatchObject({
      id: '1',
      name: 'Gridiron Gulls',
      pointsFor: 1266.9,
      pointsAgainst: 1070.5,
      streak: 'W2',
    })
    expect(teams[0]!.record).toEqual({ wins: 8, losses: 2, ties: 0 })
    expect(teams[2]!.record).toEqual({ wins: 2, losses: 8, ties: 0 })
    expect(warnings).toHaveLength(0)
  })

  it('is unaffected by column order', async () => {
    serve(standingsPage({ reverseColumns: true }))
    const teams = await scrapeStandings(ctx([]))

    expect(teams).toHaveLength(3)
    expect(teams[0]!.pointsFor).toBe(1266.9)
    expect(teams[0]!.record).toEqual({ wins: 8, losses: 2, ties: 0 })
  })

  it('reads a record split across separate W, L and T columns', async () => {
    serve(standingsPage({ splitRecord: true }))
    const teams = await scrapeStandings(ctx([]))
    expect(teams[0]!.record).toEqual({ wins: 8, losses: 2, ties: 0 })
  })

  it('still finds points-for when Yahoo renames the header', async () => {
    serve(standingsPage({ pointsForHeader: 'Points For' }))
    const teams = await scrapeStandings(ctx([]))
    expect(teams[0]!.pointsFor).toBe(1266.9)
  })

  it('warns rather than reporting zeroes when a column disappears', async () => {
    serve(standingsPage({ omitPointsAgainst: true }))
    const warnings: string[] = []
    const teams = await scrapeStandings(ctx(warnings))

    expect(teams).toHaveLength(3)
    expect(warnings.join(' ')).toMatch(/points against/i)
  })

  it('warns and returns nothing when there is no standings table at all', async () => {
    serve('<!doctype html><html><body><p>Nothing here</p></body></html>')
    const warnings: string[] = []
    const teams = await scrapeStandings(ctx(warnings))

    expect(teams).toEqual([])
    expect(warnings.join(' ')).toMatch(/no standings table/i)
  })
})

describe('scrapeRoster', () => {
  it('reads slots, players and projections', async () => {
    serve(rosterPage())
    const roster = await scrapeRoster(ctx([]), '1')

    expect(roster).toHaveLength(DEFAULT_ROSTER.length)

    const qb = roster[0]!
    expect(qb.slot).toBe('QB')
    expect(qb.starter).toBe(true)
    expect(qb.player).toMatchObject({ name: 'Xavier Mercado', position: 'QB', nflTeam: 'DET' })
    expect(qb.projected).toBe(26.6)
    expect(qb.player!.byeWeek).toBe(9)
  })

  it('puts the scoring numbers on the player, not only the roster row', async () => {
    // The regression this guards: a Player with no points silently projects 0,
    // which made start/sit, waivers and trades produce confident nonsense.
    serve(rosterPage())
    const roster = await scrapeRoster(ctx([]), '1')

    for (const entry of roster) {
      expect(entry.player!.points?.projected).toBeGreaterThan(0)
    }
  })

  it('marks bench slots as non-starters', async () => {
    serve(rosterPage())
    const roster = await scrapeRoster(ctx([]), '1')
    const bench = roster.find((entry) => entry.slot === 'BN')!
    expect(bench.starter).toBe(false)
    expect(roster.find((entry) => entry.slot === 'W/R/T')!.starter).toBe(true)
  })

  it('picks up injury designations', async () => {
    serve(rosterPage())
    const roster = await scrapeRoster(ctx([]), '1')
    const injured = roster.find((entry) => entry.player?.name === 'Bo Vance')!
    expect(injured.player!.injury?.code).toBe('Q')
    expect(injured.player!.injury?.label).toBe('Questionable')
  })

  it('leaves projections absent — not zero — when the column is missing', async () => {
    serve(rosterPage({ omitProjection: true }))
    const roster = await scrapeRoster(ctx([]), '1')

    expect(roster).toHaveLength(DEFAULT_ROSTER.length)
    for (const entry of roster) {
      expect(entry.projected).toBeUndefined()
      expect(entry.player!.points?.projected).toBeUndefined()
      // The points that *were* on the page still come through.
      expect(entry.player!.points?.lastWeek).toBeGreaterThan(0)
    }
  })

  it('reads a minified page where elements run together', async () => {
    // Real pages ship without whitespace between elements. Concatenated text
    // nodes turn "Xavier Mercado" + "DET - QB" into "Xavier MercadoDET - QB",
    // which silently loses the NFL team and the position.
    serve(rosterPage({ tightMarkup: true }))
    const roster = await scrapeRoster(ctx([]), '1')

    const qb = roster[0]!.player!
    expect(qb.name).toBe('Xavier Mercado')
    expect(qb.nflTeam).toBe('DET')
    expect(qb.position).toBe('QB')

    const injured = roster.find((entry) => entry.player?.name === 'Bo Vance')!.player!
    expect(injured.injury?.code).toBe('Q')
    expect(injured.nflTeam).toBe('DAL')
  })

  it('warns when a team page has no roster rows', async () => {
    serve('<!doctype html><html><body><p>No roster</p></body></html>')
    const warnings: string[] = []
    const roster = await scrapeRoster(ctx(warnings), '7')

    expect(roster).toEqual([])
    expect(warnings.join(' ')).toMatch(/no roster rows/i)
  })
})

describe('scrapePlayers', () => {
  it('reads the pool with ownership, points and bye weeks', async () => {
    serve(playersPage())
    const players = await scrapePlayers(ctx([]), { pages: 1 })

    expect(players).toHaveLength(3)
    const qb = players.find((p) => p.name === 'Jalen Cardoso')!
    expect(qb.position).toBe('QB')
    expect(qb.nflTeam).toBe('ATL')
    expect(qb.byeWeek).toBe(11)
    expect(qb.points?.season).toBe(279.9)
    expect(qb.points?.average).toBe(28)
    expect(qb.points?.projected).toBe(31)
    expect(qb.ownership?.percentOwned).toBe(93)
  })

  it('distinguishes free agents from rostered players', async () => {
    serve(playersPage())
    const players = await scrapePlayers(ctx([]), { pages: 1 })

    expect(players.find((p) => p.name === 'Jalen Cardoso')!.ownerTeamId).toBeNull()
    expect(players.find((p) => p.name === 'Silas Grady')!.ownerTeamId).toBe('2')
  })

  it('stops walking pages once nothing new comes back', async () => {
    // Every page serves the same three players, so page two adds nothing.
    serve(playersPage())
    const players = await scrapePlayers(ctx([]), { pages: 5 })
    expect(players).toHaveLength(3)
  })
})

describe('scrapeScoreboard', () => {
  it('pairs teams into matchups and reads their scores', async () => {
    serve(
      scoreboardPage([
        { away: '2', awayScore: 99.3, home: '1', homeScore: 120.5, final: true },
        { away: '3', awayScore: 84.1, home: '4', homeScore: 74.4, final: true },
      ]),
    )
    const matchups = await scrapeScoreboard(ctx([]), 11)

    expect(matchups).toHaveLength(2)
    expect(matchups[0]!.away).toMatchObject({ teamId: '2', score: 99.3 })
    expect(matchups[0]!.home).toMatchObject({ teamId: '1', score: 120.5 })
    expect(matchups[0]!.final).toBe(true)
    expect(matchups[0]!.winnerTeamId).toBe('1')
  })

  it('leaves a winner unset while a matchup is still in progress', async () => {
    serve(scoreboardPage([{ away: '2', awayScore: 40.0, home: '1', homeScore: 55.0 }]))
    const matchups = await scrapeScoreboard(ctx([]), 11)

    expect(matchups[0]!.final).toBe(false)
    expect(matchups[0]!.winnerTeamId).toBeNull()
  })

  it('warns when no matchups can be paired', async () => {
    serve('<!doctype html><html><body><p>Bye week</p></body></html>')
    const warnings: string[] = []
    const matchups = await scrapeScoreboard(ctx(warnings), 11)

    expect(matchups).toEqual([])
    expect(warnings.join(' ')).toMatch(/could be paired/i)
  })
})

describe('scrapeDraft', () => {
  it('warns rather than inventing picks when a league has not drafted', async () => {
    serve('<!doctype html><html><body><p>Your draft has not started.</p></body></html>')
    const warnings: string[] = []
    const picks = await scrapeDraft(ctx(warnings))

    expect(picks).toEqual([])
    expect(warnings.join(' ')).toMatch(/no draft picks/i)
  })
})
