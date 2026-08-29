import fs from 'node:fs'
import { column, num, optionalColumn, parseCsv, str } from '../csv.js'
import {
  loadLeagueScoring,
  offenseColumns,
  offensePoints,
  type LeagueScoring,
} from './scoring.js'
import { auditPlayerStats } from '../verify.js'
import { localPath } from '../fetch.js'

/**
 * The player pool for a draft.
 *
 * A draft board needs a projection for every player who will be on a roster
 * this season, which is a different problem from everything else in this repo:
 * it cannot come from a league sync, because the league does not exist yet.
 *
 * So it is built from open data — who is actually on an NFL roster for the
 * coming season, where they sit on the depth chart, what they produced
 * recently, and how players of their age and position typically move year to
 * year.
 *
 * Be clear about what this is not. Commercial projections price in target
 * competition, scheme and coaching changes, offseason moves and beat reporting.
 * This uses production, age, depth chart and roster status. It is a defensible
 * baseline and a real ranking, not a substitute for a projection service — and
 * where it disagrees with consensus, consensus is more often right.
 */

export interface RosteredPlayer {
  playerId: string
  name: string
  position: string
  team: string
  status: string
  age: number | null
}

export function loadSeasonRoster(season: number): RosteredPlayer[] {
  const candidates = [localPath('rosters', `${season}.csv`), localPath(`roster_${season}.csv`)]
  const path = candidates.find((candidate) => fs.existsSync(candidate))
  if (!path) return []

  const table = parseCsv(fs.readFileSync(path, 'utf8'))
  const c = {
    id: optionalColumn(table, 'gsis_id') ?? column(table, 'player_id'),
    name: optionalColumn(table, 'full_name') ?? optionalColumn(table, 'player_name'),
    position: column(table, 'position'),
    team: column(table, 'team'),
    status: optionalColumn(table, 'status'),
    birthDate: optionalColumn(table, 'birth_date'),
  }

  const players: RosteredPlayer[] = []
  for (const row of table.rows) {
    const playerId = str(row, c.id)
    if (!playerId) continue

    const birthDate = str(row, c.birthDate)
    const born = birthDate ? new Date(birthDate) : null
    const age =
      born && !Number.isNaN(born.getTime())
        ? (Date.UTC(season, 8, 1) - born.getTime()) / (365.25 * 24 * 3600 * 1000)
        : null

    players.push({
      playerId,
      name: str(row, c.name),
      position: str(row, c.position),
      team: str(row, c.team),
      status: str(row, c.status),
      age,
    })
  }

  return players
}

export interface SeasonProduction {
  playerId: string
  season: number
  games: number
  pointsPerGame: number
  totalPoints: number
}

/**
 * Per-season production. The column layout changed between the two nflverse
 * eras, so both spellings are accepted.
 */
export function loadSeasonProduction(
  seasons: number[],
  scoring: LeagueScoring = loadLeagueScoring().scoring,
): SeasonProduction[] {
  const output: SeasonProduction[] = []

  for (const season of seasons) {
    const path = localPath('stats_player', `${season}.csv`)
    if (!fs.existsSync(path)) continue

    const table = parseCsv(fs.readFileSync(path, 'utf8'))
    // Refuse rather than score what is there. A file without yardage columns
    // still parses, still has a row per player per week, and still produces a
    // full board - one that is wrong in a direction nobody inspects.
    const { absent, empty } = auditPlayerStats(table)
    if (absent.length > 0 || empty.length > 0) {
      const problems = [
        absent.length > 0 ? `absent: ${absent.join(', ')}` : '',
        empty.length > 0 ? `present but never populated: ${empty.join(', ')}` : '',
      ].filter(Boolean)
      throw new Error(
        `${path} cannot be scored (${problems.join('; ')}). ` +
          'Every player would be scored too low and the board would look fine. ' +
          'Re-download the data with: npm run data:fetch -- --force',
      )
    }
    const c = {
      id: column(table, 'player_id'),
      type: optionalColumn(table, 'season_type'),
      position: optionalColumn(table, 'position'),
      // Scored from the underlying events rather than nflverse's precomputed
      // column, which is full PPR and cannot express a league's own rules.
      offense: offenseColumns(table),
      // nflverse reports kicking as raw attempts by distance and leaves
      // fantasy_points at zero for kickers, so their scoring is computed here.
      fg: {
        b0: optionalColumn(table, 'fg_made_0_19'),
        b20: optionalColumn(table, 'fg_made_20_29'),
        b30: optionalColumn(table, 'fg_made_30_39'),
        b40: optionalColumn(table, 'fg_made_40_49'),
        b50: optionalColumn(table, 'fg_made_50_59'),
        b60: optionalColumn(table, 'fg_made_60_'),
        missed: optionalColumn(table, 'fg_missed'),
        pat: optionalColumn(table, 'pat_made'),
        patMissed: optionalColumn(table, 'pat_missed'),
      },
    }

    const totals = new Map<string, { games: number; points: number }>()
    for (const row of table.rows) {
      if (c.type !== null && str(row, c.type) !== 'REG') continue
      const playerId = str(row, c.id)
      if (!playerId) continue

      const isKicker = c.position !== null && str(row, c.position) === 'K'
      const points = isKicker
        ? kickerPoints(row, c.fg, scoring)
        : offensePoints(row, c.offense, scoring)
      const current = totals.get(playerId) ?? { games: 0, points: 0 }
      totals.set(playerId, { games: current.games + 1, points: current.points + points })
    }

    for (const [playerId, total] of totals) {
      output.push({
        playerId,
        season,
        games: total.games,
        totalPoints: total.points,
        pointsPerGame: total.games === 0 ? 0 : total.points / total.games,
      })
    }
  }

  return output
}

/**
 * Standard kicker scoring: three points a field goal with a bonus by distance,
 * one for an extra point, minus one for a miss. Close enough to every common
 * ruleset that a ranking built on it holds.
 */
function kickerPoints(
  row: string[],
  cols: {
    b0: number | null; b20: number | null; b30: number | null; b40: number | null
    b50: number | null; b60: number | null; missed: number | null
    pat: number | null; patMissed: number | null
  },
  scoring: LeagueScoring,
): number {
  const get = (index: number | null) => num(row, index) ?? 0
  const fg = scoring.fieldGoals

  return (
    get(cols.b0) * fg.b0 +
    get(cols.b20) * fg.b20 +
    get(cols.b30) * fg.b30 +
    get(cols.b40) * fg.b40 +
    get(cols.b50) * fg.b50 +
    get(cols.b60) * fg.b60 +
    get(cols.pat) * scoring.patMade +
    get(cols.missed) * scoring.fieldGoalMissed +
    get(cols.patMissed) * scoring.patMissed
  )
}

export interface DepthChartEntry {
  playerId: string
  team: string
  position: string
  /** 1 is the starter at that position. */
  rank: number
}

/**
 * Latest depth chart position per player.
 *
 * The night before a draft this is the strongest signal production cannot see:
 * a back-up who has become the starter has no history that reflects it, and a
 * starter who has been displaced still has last year's numbers.
 */
export function loadLatestDepthChart(season: number): Map<string, DepthChartEntry> {
  const path = localPath(`depth_charts_${season}.csv`)
  if (!fs.existsSync(path)) return new Map()

  const table = parseCsv(fs.readFileSync(path, 'utf8'))
  const c = {
    id: optionalColumn(table, 'gsis_id'),
    team: optionalColumn(table, 'team'),
    position: optionalColumn(table, 'pos_abb') ?? optionalColumn(table, 'pos_name'),
    rank: optionalColumn(table, 'pos_rank'),
    when: optionalColumn(table, 'dt'),
  }
  if (c.id === null || c.rank === null) return new Map()

  // The file carries every snapshot taken through the offseason; only the most
  // recent one describes the roster a draft is actually facing.
  const latest = new Map<string, { when: string; entry: DepthChartEntry }>()
  for (const row of table.rows) {
    const playerId = str(row, c.id)
    if (!playerId) continue

    const rank = num(row, c.rank)
    if (rank === undefined) continue

    const when = str(row, c.when)
    const existing = latest.get(playerId)
    if (existing && existing.when >= when) continue

    latest.set(playerId, {
      when,
      entry: { playerId, team: str(row, c.team), position: str(row, c.position), rank },
    })
  }

  return new Map([...latest].map(([id, value]) => [id, value.entry]))
}
