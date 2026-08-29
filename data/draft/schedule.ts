import fs from 'node:fs'
import { column, num, optionalColumn, parseCsv, str } from '../csv.js'
import { localPath } from '../fetch.js'

/**
 * Bye weeks.
 *
 * A bye is not a field in any of this data. It is the absence of one: the week
 * a team appears in no game. So it has to be derived from a complete regular
 * season schedule, and a schedule that is missing games would invent byes that
 * do not exist — a team missing from two weeks of a partial file looks like it
 * has two byes.
 *
 * That is why this validates before it answers. Every team must be missing
 * exactly one week, or nothing is returned at all. A board that says nothing
 * about byes is fine; a board that tells you your two receivers are free in
 * different weeks when they are not is worse than silent.
 */

/** Regular season weeks in the modern schedule. Byes fall inside this range. */
const REGULAR_SEASON_TYPE = 'REG'

export interface ByeWeeks {
  /** NFL team abbreviation to the week it is off. */
  byTeam: Map<string, number>
  season: number
}

export function loadByeWeeks(season: number): ByeWeeks | null {
  const path = localPath('games.csv')
  if (!fs.existsSync(path)) return null

  const table = parseCsv(fs.readFileSync(path, 'utf8'))
  const c = {
    season: column(table, 'season'),
    week: column(table, 'week'),
    type: optionalColumn(table, 'game_type'),
    home: column(table, 'home_team'),
    away: column(table, 'away_team'),
  }

  const weeks = new Set<number>()
  const played = new Map<string, Set<number>>()

  for (const row of table.rows) {
    if (num(row, c.season) !== season) continue
    if (c.type !== null && str(row, c.type) !== REGULAR_SEASON_TYPE) continue

    const week = num(row, c.week)
    if (week === undefined) continue
    weeks.add(week)

    for (const team of [str(row, c.home), str(row, c.away)]) {
      if (!team) continue
      const seen = played.get(team)
      if (seen) seen.add(week)
      else played.set(team, new Set([week]))
    }
  }

  // A schedule for a season that has not been published yet, or a partial one.
  if (played.size < 32 || weeks.size < 17) return null

  const byTeam = new Map<string, number>()
  for (const [team, seen] of played) {
    const off = [...weeks].filter((week) => !seen.has(week))
    // Exactly one missing week is a bye. Two would mean the file is incomplete,
    // and none would mean the week count is wrong; either way, do not guess.
    if (off.length !== 1) return null
    byTeam.set(team, off[0] as number)
  }

  return { byTeam, season }
}

/**
 * Weeks in which a set of players are all unavailable together.
 *
 * Stacking byes is the one draft mistake that is invisible while you are making
 * it: each pick looks fine on its own, and the hole only appears in October
 * when three of your starters are off in the same week.
 */
export function byeStacks(
  byeWeeks: Array<number | null>,
): Array<{ week: number; count: number }> {
  const counts = new Map<number, number>()
  for (const week of byeWeeks) {
    if (week === null) continue
    counts.set(week, (counts.get(week) ?? 0) + 1)
  }
  return [...counts]
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => b.count - a.count || a.week - b.week)
}
