import type { Page } from 'playwright'
import type {
  DraftPick, League, Matchup, Player, RosterEntry, Team,
} from '../../shared/types.js'
import { config } from '../config.js'
import { gotoAuthed, politeDelay } from './browser.js'
import { yahooUrls } from './urls.js'
import {
  cell, cellText, columnIndex, extractAnchors, extractTables, num, numOr,
  parseRecord, pickTable, teamIdFromHref, type TableDump,
} from './dom.js'
import { parseBye, parsePlayerCell, toPosition } from './parsePlayer.js'

/**
 * Yahoo page scrapers.
 *
 * Each function takes a logged-in page, navigates, and returns normalized
 * domain objects plus any warnings. Warnings are first-class: a scraper that
 * can't find a column says so rather than quietly reporting zeroes, and those
 * warnings ride along into the API response and the UI.
 */

export interface ScrapeContext {
  page: Page
  leagueId: string
  warn: (message: string) => void
}

const BENCH_SLOTS = new Set(['BN', 'BENCH', 'IR', 'IR-R', 'NA', 'TAXI'])

export function isStarterSlot(slot: string): boolean {
  return !BENCH_SLOTS.has(slot.toUpperCase().replace(/\s+/g, ''))
}

// --- League metadata --------------------------------------------------------

export async function scrapeLeagueMeta(ctx: ScrapeContext): Promise<League> {
  const { page, leagueId, warn } = ctx
  await gotoAuthed(page, yahooUrls.home(leagueId))

  const name =
    (await page.locator('#league-name, .Navtarget .league-name, h1').first().textContent().catch(() => null))
      ?.replace(/\s+/g, ' ')
      .trim() || `League ${leagueId}`

  // Yahoo shows the active week in the scoreboard header, e.g. "Week 7".
  const bodyText = (await page.locator('body').innerText().catch(() => '')) || ''
  const weekMatch = bodyText.match(/\bWeek\s+(\d{1,2})\b/i)
  const currentWeek = weekMatch?.[1] ? Number(weekMatch[1]) : 1
  if (!weekMatch) warn('Could not read the current week from the league home page; defaulting to week 1.')

  await politeDelay()
  const settings = await scrapeSettings(ctx).catch((err: unknown) => {
    warn(`Settings page unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    return {} as Partial<League>
  })

  return {
    id: leagueId,
    provider: 'yahoo',
    name,
    season: config.yahoo.season,
    numTeams: settings.numTeams ?? 0,
    currentWeek,
    regularSeasonWeeks: settings.regularSeasonWeeks ?? 14,
    playoffTeams: settings.playoffTeams ?? 6,
    ...(settings.scoringType ? { scoringType: settings.scoringType } : {}),
    pprType: settings.pprType ?? 'unknown',
    isAuction: settings.isAuction ?? false,
    ...(settings.rosterSlots ? { rosterSlots: settings.rosterSlots } : {}),
    url: yahooUrls.home(leagueId),
  }
}

/**
 * The settings page is a two-column "label / value" table rather than a data
 * grid, so it's read as a key-value map instead of by column.
 */
async function scrapeSettings(ctx: ScrapeContext): Promise<Partial<League>> {
  const { page, leagueId } = ctx
  await gotoAuthed(page, yahooUrls.settings(leagueId))
  const tables = await extractTables(page)

  const settings = new Map<string, string>()
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.length < 2) continue
      const key = (row[0]?.text ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
      const value = row[1]?.text ?? ''
      if (key && value && !settings.has(key)) settings.set(key, value)
    }
  }

  const lookup = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      for (const [k, v] of settings) if (k.includes(key)) return v
    }
    return undefined
  }

  const scoringType = lookup('scoring type')
  const numTeams = num(lookup('number of teams', 'league size'))
  const playoffTeams = num(lookup('number of playoff teams', 'playoff teams'))
  const playoffStart = num(lookup('playoffs start', 'playoff start'))
  const draftType = lookup('draft type') ?? ''

  const result: Partial<League> = {
    pprType: inferPprType(scoringType, settings),
    isAuction: /auction|salary/i.test(draftType),
  }
  if (scoringType) result.scoringType = scoringType
  if (numTeams !== undefined) result.numTeams = numTeams
  if (playoffTeams !== undefined) result.playoffTeams = playoffTeams
  // "Playoffs start week 15" means the regular season ends at week 14.
  if (playoffStart !== undefined) result.regularSeasonWeeks = Math.max(1, playoffStart - 1)

  const rosterSlots = parseRosterSlots(tables)
  if (rosterSlots.length > 0) result.rosterSlots = rosterSlots

  return result
}

function inferPprType(scoringType: string | undefined, settings: Map<string, string>): League['pprType'] {
  const haystack = `${scoringType ?? ''} ${Array.from(settings.values()).join(' ')}`.toLowerCase()
  if (/half[\s-]?ppr|0\.5\s*(point|pt)s?\s*per\s*reception/.test(haystack)) return 'half-ppr'
  if (/\bppr\b|point per reception|1 point per reception/.test(haystack)) return 'ppr'
  if (/standard/.test(haystack)) return 'standard'
  return 'unknown'
}

function parseRosterSlots(tables: TableDump[]): Array<{ slot: string; count: number }> {
  // The roster-positions table lists each slot and how many of it a team carries.
  const table = pickTable(tables, [['position'], ['count'], ['roster position']])
  if (!table) return []
  const slotIdx = columnIndex(table, ['position', 'roster position'])
  const countIdx = columnIndex(table, ['count', 'starters', 'number'])
  if (slotIdx === -1 || countIdx === -1) return []

  const slots: Array<{ slot: string; count: number }> = []
  for (const row of table.rows) {
    const slot = row[slotIdx]?.text.trim()
    const count = num(row[countIdx]?.text)
    if (slot && count !== undefined && count > 0) slots.push({ slot, count })
  }
  return slots
}

// --- Standings --------------------------------------------------------------

const STANDINGS_COLUMNS = {
  team: ['team', 'teams'],
  record: ['wlt', 'w l t', 'record', 'wl'],
  wins: ['w', 'wins'],
  losses: ['l', 'losses'],
  ties: ['t', 'ties'],
  pointsFor: ['pts for', 'ptsfor', 'points for', 'pf'],
  pointsAgainst: ['pts agnst', 'pts against', 'points against', 'pa'],
  streak: ['streak', 'strk'],
  waiver: ['waiver', 'waiver priority'],
  moves: ['moves'],
  trades: ['trades'],
} as const

export async function scrapeStandings(ctx: ScrapeContext): Promise<Team[]> {
  const { page, leagueId, warn } = ctx
  await gotoAuthed(page, yahooUrls.standings(leagueId))
  const tables = await extractTables(page)

  const table = pickTable(tables, [
    [...STANDINGS_COLUMNS.team],
    [...STANDINGS_COLUMNS.pointsFor],
    [...STANDINGS_COLUMNS.record],
  ])
  if (!table) {
    warn('No standings table found. Re-run `npm run yahoo:capture` and inspect .cache/raw/standings.html')
    return []
  }

  const teams: Team[] = []
  for (const [i, row] of table.rows.entries()) {
    const teamCell = cell(table, row, [...STANDINGS_COLUMNS.team]) ?? row[0]
    if (!teamCell) continue

    const link = teamCell.links.find((l) => teamIdFromHref(l.href, leagueId))
    const id = link ? teamIdFromHref(link.href, leagueId) : undefined
    if (!id) continue

    // Record is either one "10-3-0" column or separate W/L/T columns.
    const recordText = cellText(table, row, [...STANDINGS_COLUMNS.record])
    const record = recordText
      ? parseRecord(recordText)
      : {
          wins: numOr(cellText(table, row, [...STANDINGS_COLUMNS.wins]), 0),
          losses: numOr(cellText(table, row, [...STANDINGS_COLUMNS.losses]), 0),
          ties: numOr(cellText(table, row, [...STANDINGS_COLUMNS.ties]), 0),
        }

    // The team cell holds the team name as link text and the manager below it.
    const name = link?.text || teamCell.text
    const manager = teamCell.text.replace(name, '').replace(/\d+-\d+-?\d*/, '').trim()

    const team: Team = {
      id,
      name,
      record,
      pointsFor: numOr(cellText(table, row, [...STANDINGS_COLUMNS.pointsFor]), 0),
      pointsAgainst: numOr(cellText(table, row, [...STANDINGS_COLUMNS.pointsAgainst]), 0),
      rank: i + 1,
      isMine: config.yahoo.teamId !== '' && config.yahoo.teamId === id,
    }
    if (manager) team.managerName = manager
    if (teamCell.img) team.logoUrl = teamCell.img
    const streak = cellText(table, row, [...STANDINGS_COLUMNS.streak])
    if (streak) team.streak = streak
    const waiver = num(cellText(table, row, [...STANDINGS_COLUMNS.waiver]))
    if (waiver !== undefined) team.waiverPriority = waiver
    const moves = num(cellText(table, row, [...STANDINGS_COLUMNS.moves]))
    if (moves !== undefined) team.movesMade = moves
    const trades = num(cellText(table, row, [...STANDINGS_COLUMNS.trades]))
    if (trades !== undefined) team.tradesMade = trades

    teams.push(team)
  }

  if (teams.length === 0) {
    warn('Standings table was found but no team rows could be read from it.')
  }
  if (columnIndex(table, [...STANDINGS_COLUMNS.pointsAgainst]) === -1) {
    warn('No "points against" column in the standings; luck and schedule-strength numbers will be limited.')
  }
  return teams
}

// --- Scoreboard -------------------------------------------------------------

/**
 * The scoreboard is a set of matchup cards rather than a table, so it can't be
 * read by column. Instead: take every team link on the page and group them by
 * their position in the DOM tree, then pick the grouping depth at which the
 * page resolves into pairs. A matchup card is precisely a container holding
 * exactly two distinct team links, so the correct depth is the one that yields
 * the most such containers.
 */
export async function scrapeScoreboard(ctx: ScrapeContext, week: number): Promise<Matchup[]> {
  const { page, leagueId, warn } = ctx

  let loaded = false
  for (const url of yahooUrls.scoreboardCandidates(leagueId, week)) {
    try {
      await gotoAuthed(page, url)
      loaded = true
      break
    } catch {
      // Try the next URL shape.
    }
  }
  if (!loaded) {
    warn(`Could not load a scoreboard page for week ${week}.`)
    return []
  }

  const anchors = await extractAnchors(page, `/f1/${leagueId}/\\d+(?:[/?#]|$)`)
  const pairs = groupIntoPairs(
    anchors.map((a) => ({ ...a, teamId: teamIdFromHref(a.href, leagueId) ?? '' })).filter((a) => a.teamId),
  )

  if (pairs.length === 0) {
    warn(`No matchups could be paired on the week ${week} scoreboard.`)
    return []
  }

  const matchups: Matchup[] = []
  for (const pair of pairs) {
    const [away, home] = pair
    if (!away || !home) continue
    const awayScore = scoreFromContext(away.contextText)
    const homeScore = scoreFromContext(home.contextText)
    // "Final" is written on the matchup card, not on either team's own row.
    const final = /\bfinal\b/i.test(`${away.cardText} ${home.cardText}`)

    matchups.push({
      week,
      away: { teamId: away.teamId, score: awayScore ?? 0 },
      home: { teamId: home.teamId, score: homeScore ?? 0 },
      winnerTeamId:
        final && awayScore !== undefined && homeScore !== undefined && awayScore !== homeScore
          ? (awayScore > homeScore ? away.teamId : home.teamId)
          : null,
      final,
    })
  }

  const missingScores = matchups.filter((m) => m.home.score === 0 && m.away.score === 0).length
  if (missingScores > 0) {
    warn(`Week ${week}: ${missingScores} matchup(s) had no readable scores.`)
  }
  return matchups
}

interface TeamAnchor {
  teamId: string
  groupKey: string
  contextText: string
  cardText: string
}

/**
 * Choose the DOM depth at which team links resolve into two-team containers,
 * and return those pairs in document order.
 */
export function groupIntoPairs(anchors: TeamAnchor[]): Array<[TeamAnchor, TeamAnchor]> {
  let best: Array<[TeamAnchor, TeamAnchor]> = []

  const maxDepth = Math.max(0, ...anchors.map((a) => a.groupKey.split('/').length))
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const groups = new Map<string, TeamAnchor[]>()
    for (const anchor of anchors) {
      const key = anchor.groupKey.split('/').slice(0, depth).join('/')
      const existing = groups.get(key)
      if (existing) existing.push(anchor)
      else groups.set(key, [anchor])
    }

    const pairs: Array<[TeamAnchor, TeamAnchor]> = []
    for (const members of groups.values()) {
      // Collapse repeated links to the same team inside one card (logo + name).
      const distinct: TeamAnchor[] = []
      for (const member of members) {
        if (!distinct.some((d) => d.teamId === member.teamId)) distinct.push(member)
      }
      const [first, second] = distinct
      if (distinct.length === 2 && first && second) pairs.push([first, second])
    }

    if (pairs.length > best.length) best = pairs
  }

  return best
}

/** Fantasy scores carry a decimal; prefer those over stray integers. */
function scoreFromContext(text: string): number | undefined {
  const decimal = text.match(/\b\d{1,3}\.\d{1,2}\b/)
  if (decimal) return Number(decimal[0])
  const integer = text.match(/\b\d{1,3}\b/)
  return integer ? Number(integer[0]) : undefined
}

// --- Rosters ----------------------------------------------------------------

export async function scrapeRoster(
  ctx: ScrapeContext,
  teamId: string,
  week?: number,
): Promise<RosterEntry[]> {
  const { page, leagueId, warn } = ctx
  await gotoAuthed(page, yahooUrls.team(leagueId, teamId, week))
  const tables = await extractTables(page)

  const entries: RosterEntry[] = []
  // A team page carries the starters table and the bench table separately.
  for (const table of tables) {
    const posIdx = columnIndex(table, ['pos', 'position', 'slot'])
    const playerIdx = columnIndex(table, ['player', 'players', 'offense', 'kickers', 'defense'])
    if (posIdx === -1 || playerIdx === -1) continue

    for (const row of table.rows) {
      const slot = row[posIdx]?.text.trim() ?? ''
      if (!slot) continue
      const playerCell = row[playerIdx]
      const parsed = parsePlayerCell(playerCell)

      const points = num(cellText(table, row, ['fan pts', 'fanpts', 'points', 'pts']))
      const projected = num(cellText(table, row, ['proj pts', 'projpts', 'proj', 'projected']))
      const seasonPoints = num(cellText(table, row, ['season pts', 'total pts', 'season']))
      const averagePoints = num(cellText(table, row, ['avg pts', 'avgpts', 'average', 'ppg']))

      // Attach the scoring numbers to the player, not just to the roster row.
      // Everything downstream values players, and a Player with no points at
      // all silently projects zero — which would make the whole start/sit and
      // waiver model produce confident nonsense.
      const playerPoints: Player['points'] = {
        ...(seasonPoints !== undefined ? { season: seasonPoints } : {}),
        ...(averagePoints !== undefined ? { average: averagePoints } : {}),
        ...(points !== undefined ? { lastWeek: points } : {}),
        ...(projected !== undefined ? { projected } : {}),
      }

      const entry: RosterEntry = {
        slot,
        starter: isStarterSlot(slot),
        player: parsed.name
          ? {
              id: parsed.id ?? `${teamId}-${slot}-${parsed.name}`,
              name: parsed.name,
              position: parsed.position ?? 'UNKNOWN',
              nflTeam: parsed.nflTeam ?? '',
              ownerTeamId: teamId,
              ...(parsed.eligiblePositions ? { eligiblePositions: parsed.eligiblePositions } : {}),
              ...(parsed.injury ? { injury: parsed.injury } : {}),
              ...(Object.keys(playerPoints).length > 0 ? { points: playerPoints } : {}),
            }
          : null,
      }

      if (points !== undefined) entry.points = points
      if (projected !== undefined) entry.projected = projected
      const bye = parseBye(cellText(table, row, ['bye']))
      if (bye !== undefined && entry.player) entry.player.byeWeek = bye

      entries.push(entry)
    }
  }

  if (entries.length === 0) {
    warn(`No roster rows found for team ${teamId}. Inspect .cache/raw/team-${teamId}.html`)
  }
  return entries
}

// --- Player pool ------------------------------------------------------------

export interface PlayerScrapeOptions {
  /** "A" available, "T" taken, "ALL" everyone. */
  status?: string
  position?: string
  /** How many 25-player pages to walk. */
  pages?: number
}

export async function scrapePlayers(
  ctx: ScrapeContext,
  opts: PlayerScrapeOptions = {},
): Promise<Player[]> {
  const { page, leagueId, warn } = ctx
  const pageCount = opts.pages ?? 4
  const players: Player[] = []
  const seen = new Set<string>()

  for (let i = 0; i < pageCount; i += 1) {
    const url = yahooUrls.players(leagueId, {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.position ? { pos: opts.position } : {}),
      count: i * 25,
    })
    await gotoAuthed(page, url)
    const tables = await extractTables(page)

    const table = pickTable(tables, [['player', 'players'], ['owner'], ['pts', 'fan pts']])
    if (!table) {
      if (i === 0) warn('No player table found on the players page.')
      break
    }

    const before = players.length
    for (const row of table.rows) {
      const playerCell = cell(table, row, ['player', 'players'])
      const parsed = parsePlayerCell(playerCell)
      if (!parsed.name) continue

      const id = parsed.id ?? `name:${parsed.name}`
      if (seen.has(id)) continue
      seen.add(id)

      const ownerCell = cell(table, row, ['owner', 'team', 'owned by'])
      const ownerLink = ownerCell?.links.find((l) => teamIdFromHref(l.href, leagueId))
      const ownerTeamId = ownerLink ? teamIdFromHref(ownerLink.href, leagueId) ?? null : null

      const player: Player = {
        id,
        name: parsed.name,
        position: parsed.position ?? 'UNKNOWN',
        nflTeam: parsed.nflTeam ?? '',
        ownerTeamId,
        ...(parsed.eligiblePositions ? { eligiblePositions: parsed.eligiblePositions } : {}),
        ...(parsed.injury ? { injury: parsed.injury } : {}),
      }

      const bye = parseBye(cellText(table, row, ['bye']))
      if (bye !== undefined) player.byeWeek = bye

      const season = num(cellText(table, row, ['fan pts', 'pts', 'points']))
      const avg = num(cellText(table, row, ['avg pts', 'avg', 'ppg']))
      const projected = num(cellText(table, row, ['proj pts', 'proj']))
      if (season !== undefined || avg !== undefined || projected !== undefined) {
        player.points = {
          ...(season !== undefined ? { season } : {}),
          ...(avg !== undefined ? { average: avg } : {}),
          ...(projected !== undefined ? { projected } : {}),
        }
      }

      const owned = num(cellText(table, row, ['% owned', 'owned', 'rostered']))
      const started = num(cellText(table, row, ['% started', 'started']))
      if (owned !== undefined || started !== undefined) {
        player.ownership = {
          ...(owned !== undefined ? { percentOwned: owned } : {}),
          ...(started !== undefined ? { percentStarted: started } : {}),
        }
      }

      players.push(player)
    }

    // A page that added nothing new means we've walked off the end of the list.
    if (players.length === before) break
    await politeDelay()
  }

  return players
}

// --- Draft ------------------------------------------------------------------

export async function scrapeDraft(ctx: ScrapeContext): Promise<DraftPick[]> {
  const { page, leagueId, warn } = ctx
  try {
    await gotoAuthed(page, yahooUrls.draftResults(leagueId))
  } catch {
    warn('Draft results page unavailable.')
    return []
  }

  const tables = await extractTables(page)
  const picks: DraftPick[] = []

  for (const table of tables) {
    const pickIdx = columnIndex(table, ['pick', 'pick no', 'overall'])
    const playerIdx = columnIndex(table, ['player', 'players'])
    if (playerIdx === -1) continue

    // Yahoo renders one table per round, with the round in the caption.
    const roundFromCaption = num(table.caption.match(/round\s*(\d+)/i)?.[1])

    for (const row of table.rows) {
      const parsed = parsePlayerCell(row[playerIdx])
      if (!parsed.name) continue

      const overall = pickIdx === -1 ? picks.length + 1 : numOr(row[pickIdx]?.text, picks.length + 1)
      const teamCell = cell(table, row, ['team', 'drafted by', 'owner'])
      const teamLink = teamCell?.links.find((l) => teamIdFromHref(l.href, leagueId))
      const teamId = teamLink ? teamIdFromHref(teamLink.href, leagueId) ?? '' : ''

      const numTeams = Math.max(1, new Set(picks.map((p) => p.teamId)).size || 1)
      const round = roundFromCaption ?? Math.ceil(overall / numTeams)

      const pick: DraftPick = {
        overall,
        round,
        pickInRound: overall - (round - 1) * numTeams,
        teamId,
        playerName: parsed.name,
        ...(parsed.id ? { playerId: parsed.id } : {}),
        ...(parsed.position ? { position: toPosition(parsed.position) } : {}),
        ...(parsed.nflTeam ? { nflTeam: parsed.nflTeam } : {}),
      }
      const cost = num(cellText(table, row, ['cost', 'salary', 'price', '$']))
      if (cost !== undefined) pick.cost = cost
      picks.push(pick)
    }
  }

  if (picks.length === 0) warn('No draft picks could be read (league may not have drafted yet).')
  return picks.sort((a, b) => a.overall - b.overall)
}
