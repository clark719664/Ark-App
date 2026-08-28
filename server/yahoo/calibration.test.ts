import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { config } from '../config.js'
import { scrapePlayers, scrapeRoster, scrapeScoreboard, scrapeStandings, type ScrapeContext } from './scrape.js'

/**
 * Calibration against your own league.
 *
 * The fixture tests prove the parsing strategy is sound against Yahoo-shaped
 * markup. This file proves it against *your* markup — the real thing.
 *
 *   1. npm run yahoo:login
 *   2. npm run yahoo:capture      # writes .cache/raw/*.html
 *   3. npm test
 *
 * With no captures present every test here skips, so this costs nothing until
 * you have real pages to check. Once you do, a failure here names exactly which
 * page and which field the parsers get wrong, which is the fastest possible
 * route from "the numbers look off" to a fix.
 */

const RAW_DIR = config.cache.rawDir
const LEAGUE_ID = config.yahoo.leagueId || '0'

function capture(name: string): string | null {
  const file = path.join(RAW_DIR, `${name}.html`)
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  } catch {
    return null
  }
}

const hasCaptures = fs.existsSync(RAW_DIR) && fs.readdirSync(RAW_DIR).some((f) => f.endsWith('.html'))

let browser: Browser
let context: BrowserContext
let page: Page
let currentHtml = ''

function executablePath(): string | undefined {
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH']
  if (!root) return undefined
  const link = path.join(root, 'chromium')
  return fs.existsSync(link) ? link : undefined
}

beforeAll(async () => {
  if (!hasCaptures) return
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

describe.skipIf(!hasCaptures)('calibration against captured Yahoo pages', () => {
  it('reads real standings', async () => {
    const html = capture('standings')
    if (!html) return

    currentHtml = html
    const warnings: string[] = []
    const teams = await scrapeStandings(ctx(warnings))

    expect(teams.length, `No teams parsed from ${RAW_DIR}/standings.html. Warnings: ${warnings.join('; ')}`)
      .toBeGreaterThan(1)

    for (const team of teams) {
      expect(team.id, 'every team needs an id from its link href').toMatch(/^\d+$/)
      expect(team.name.length, `team ${team.id} has no name`).toBeGreaterThan(0)
    }

    const scoring = teams.filter((t) => t.pointsFor > 0).length
    expect(scoring, 'no team had points-for — the column was not found').toBeGreaterThan(0)
  })

  it('reads a real roster, with the projections the lineup tools depend on', async () => {
    const file = fs.existsSync(RAW_DIR)
      ? fs.readdirSync(RAW_DIR).find((f) => f.startsWith('team-') && f.endsWith('.html'))
      : undefined
    if (!file) return

    currentHtml = fs.readFileSync(path.join(RAW_DIR, file), 'utf8')
    const teamId = file.replace(/^team-|\.html$/g, '')
    const warnings: string[] = []
    const roster = await scrapeRoster(ctx(warnings), teamId)

    expect(roster.length, `No roster rows parsed from ${file}. Warnings: ${warnings.join('; ')}`)
      .toBeGreaterThan(0)

    const named = roster.filter((entry) => entry.player?.name)
    expect(named.length, 'roster rows parsed but no player names were read').toBeGreaterThan(0)

    const withTeam = named.filter((entry) => entry.player!.nflTeam.length > 0)
    expect(
      withTeam.length,
      'no NFL teams parsed — the player cell layout differs from what parsePlayerCell expects',
    ).toBeGreaterThan(0)

    const withProjection = named.filter((entry) => (entry.player!.points?.projected ?? 0) > 0)
    expect(
      withProjection.length,
      'no projections found on the team page. Waivers and start/sit fall back to season ' +
        'average unless the players page supplies them — check the column headers in ' +
        `${RAW_DIR}/${file}`,
    ).toBeGreaterThan(0)
  })

  it('reads the real player pool', async () => {
    const html = capture('players')
    if (!html) return

    currentHtml = html
    const warnings: string[] = []
    const players = await scrapePlayers(ctx(warnings), { pages: 1 })

    expect(players.length, `No players parsed. Warnings: ${warnings.join('; ')}`).toBeGreaterThan(0)
    expect(
      players.filter((p) => p.position !== 'UNKNOWN').length,
      'every player parsed with an UNKNOWN position — the player cell format differs',
    ).toBeGreaterThan(0)
  })

  it('pairs real scoreboard matchups', async () => {
    const html = capture('scoreboard')
    if (!html) return

    currentHtml = html
    const warnings: string[] = []
    const matchups = await scrapeScoreboard(ctx(warnings), 1)

    expect(matchups.length, `No matchups paired. Warnings: ${warnings.join('; ')}`).toBeGreaterThan(0)

    for (const matchup of matchups) {
      expect(matchup.home.teamId).not.toBe(matchup.away.teamId)
    }

    const scored = matchups.filter((m) => m.home.score > 0 || m.away.score > 0).length
    expect(scored, 'matchups paired but no scores were read from the cards').toBeGreaterThan(0)
  })
})

describe.skipIf(hasCaptures)('calibration', () => {
  it('is skipped until real pages are captured', () => {
    // Documents why the suite above is silent rather than leaving it a mystery.
    expect(hasCaptures).toBe(false)
  })
})
