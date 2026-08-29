import fs from 'node:fs'
import { parseCsv, column, optionalColumn, num, str } from '../data/csv.js'
import { offenseColumns, offensePoints, loadLeagueScoring } from '../data/draft/scoring.js'
import { localPath } from '../data/fetch.js'

/**
 * Replay a season that actually happened, changing only who was started.
 *
 * The synthetic simulation answers whether the strategy is sound. This answers
 * a narrower and more useful question: given the exact roster this manager had,
 * in the exact weeks, against the exact opponents and the scores those
 * opponents actually put up, how many more games does he win by starting the
 * right players?
 *
 * Nothing here may look forward. Projections are built only from prior weeks
 * and the season before; availability comes from that week's injury report and
 * the bye schedule, both of which were on the table before kickoff. Where the
 * information is missing the replay is left worse off rather than better, so
 * the result is a floor.
 */

const PRIOR_WEIGHT = Number.parseInt(process.env['PRIOR_WEIGHT'] ?? '', 10) || 4
const REPLACEMENT: Record<string, number> = { QB: 11, RB: 5, WR: 5, TE: 3.5 }

export const normName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[.'`-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => !['jr', 'sr', 'ii', 'iii', 'iv'].includes(word))
    .join(' ')

export interface WeeklyPoints {
  /** `${week}|${normalised name}` to points scored. */
  points: Map<string, number>
  /** Normalised name to the position the stats file gives. */
  position: Map<string, string>
  /** Normalised name to NFL team, for bye weeks. */
  team: Map<string, string>
}

export function loadWeekly(season: number): WeeklyPoints {
  const { scoring } = loadLeagueScoring()
  const file = localPath('stats_player', `${season}.csv`)
  const points = new Map<string, number>()
  const position = new Map<string, string>()
  const team = new Map<string, string>()
  if (!fs.existsSync(file)) return { points, position, team }

  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const cName = optionalColumn(table, 'player_display_name') ?? column(table, 'player_name')
  const cWeek = column(table, 'week')
  const cType = optionalColumn(table, 'season_type')
  const cPos = optionalColumn(table, 'position')
  const cTeam = optionalColumn(table, 'team')
  const offense = offenseColumns(table)

  for (const row of table.rows) {
    if (cType !== null && str(row, cType) !== 'REG') continue
    const key = normName(str(row, cName))
    if (!key) continue
    const week = num(row, cWeek) ?? 0
    points.set(`${week}|${key}`, (points.get(`${week}|${key}`) ?? 0) + offensePoints(row, offense, scoring))
    if (cPos !== null) position.set(key, str(row, cPos))
    if (cTeam !== null) team.set(key, str(row, cTeam))
  }
  return { points, position, team }
}

/** Season-long per-game average, used as the prior a week-one lineup has. */
export function loadPriorSeason(season: number): Map<string, number> {
  const { scoring } = loadLeagueScoring()
  const file = localPath('stats_player', `${season}.csv`)
  const out = new Map<string, number>()
  if (!fs.existsSync(file)) return out
  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const cName = optionalColumn(table, 'player_display_name') ?? column(table, 'player_name')
  const cType = optionalColumn(table, 'season_type')
  const offense = offenseColumns(table)
  const totals = new Map<string, { games: number; points: number }>()
  for (const row of table.rows) {
    if (cType !== null && str(row, cType) !== 'REG') continue
    const key = normName(str(row, cName))
    if (!key) continue
    const current = totals.get(key) ?? { games: 0, points: 0 }
    current.games += 1
    current.points += offensePoints(row, offense, scoring)
    totals.set(key, current)
  }
  for (const [key, value] of totals) {
    if (value.games >= 4) out.set(key, value.points / value.games)
  }
  return out
}

/** Players the injury report ruled out before a given week. */
export function loadRuledOut(season: number): Set<string> {
  const file = localPath('injuries', `${season}.csv`)
  const out = new Set<string>()
  if (!fs.existsSync(file)) return out
  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const cName = column(table, 'full_name')
  const cWeek = column(table, 'week')
  const cStatus = optionalColumn(table, 'report_status')
  for (const row of table.rows) {
    const status = cStatus === null ? '' : str(row, cStatus)
    if (status !== 'Out' && status !== 'Doubtful') continue
    out.add(`${num(row, cWeek)}|${normName(str(row, cName))}`)
  }
  return out
}

/** Weeks in which each NFL team did not play, so nobody is started on a bye. */
export function loadByes(season: number): Set<string> {
  const file = localPath('stats_team', `${season}.csv`)
  const played = new Set<string>()
  const teams = new Set<string>()
  const weeks = new Set<number>()
  const byes = new Set<string>()
  if (!fs.existsSync(file)) return byes
  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const cTeam = column(table, 'team')
  const cWeek = column(table, 'week')
  const cType = optionalColumn(table, 'season_type')
  for (const row of table.rows) {
    if (cType !== null && str(row, cType) !== 'REG') continue
    const team = str(row, cTeam)
    const week = num(row, cWeek) ?? 0
    played.add(`${week}|${team}`)
    teams.add(team)
    weeks.add(week)
  }
  for (const team of teams) {
    for (const week of weeks) {
      if (!played.has(`${week}|${team}`)) byes.add(`${week}|${team}`)
    }
  }
  return byes
}

export interface Candidate {
  name: string
  position: string
  projection: number
  actual: number
  available: boolean
  started: boolean
}

/**
 * What this player was worth before the week, from his own prior weeks blended
 * with last season. No part of it can see the week being projected.
 */
export function projectBefore(
  name: string,
  position: string,
  week: number,
  weekly: WeeklyPoints,
  prior: Map<string, number>,
): number {
  let games = 0
  let total = 0
  for (let past = 1; past < week; past++) {
    const value = weekly.points.get(`${past}|${name}`)
    if (value === undefined) continue
    games += 1
    total += value
  }
  const base = prior.get(name) ?? REPLACEMENT[position] ?? 4
  if (games === 0) return base
  return (total + PRIOR_WEIGHT * base) / (games + PRIOR_WEIGHT)
}

/** Best legal skill lineup by whatever value is passed in. */
export function pickLineup(
  candidates: Candidate[],
  by: (c: Candidate) => number,
): Candidate[] {
  const ranked = [...candidates].filter((c) => c.available).sort((a, b) => by(b) - by(a))
  const used = new Set<string>()
  const chosen: Candidate[] = []
  const take = (allowed: string[]) => {
    const hit = ranked.find((c) => !used.has(c.name) && allowed.includes(c.position))
    if (hit) {
      used.add(hit.name)
      chosen.push(hit)
    }
  }
  take(['QB'])
  take(['RB'])
  take(['RB'])
  take(['WR'])
  take(['WR'])
  take(['TE'])
  take(['RB', 'WR', 'TE'])
  return chosen
}

export const sum = (rows: Candidate[]): number => rows.reduce((total, row) => total + row.actual, 0)
