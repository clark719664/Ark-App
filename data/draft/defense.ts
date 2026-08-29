import fs from 'node:fs'
import { column, num, optionalColumn, parseCsv, str } from '../csv.js'
import { localPath } from '../fetch.js'

/**
 * Team defence and special teams scoring.
 *
 * nflverse leaves fantasy points blank for defences the same way it does for
 * kickers — the raw events are all there, but nothing adds them up. Points
 * allowed is the one component not in the defensive columns at all, so it is
 * derived: a team's points allowed in a week is what its opponent scored, and
 * what a team scored can be computed from its own touchdowns, field goals and
 * extra points.
 *
 * Scoring follows the near-universal default: a point a sack, two an
 * interception or fumble recovery, six a touchdown, two a safety or blocked
 * kick, and a sliding bonus for points allowed. Leagues differ at the margins,
 * mostly in the points-allowed brackets, but not enough to reorder a ranking.
 */

export interface TeamDefenseWeek {
  season: number
  week: number
  team: string
  opponent: string
  fantasyPoints: number
  pointsAllowed: number
  sacks: number
  takeaways: number
  touchdowns: number
}

/** Points-allowed bonus, the standard sliding scale. */
export function pointsAllowedBonus(pointsAllowed: number): number {
  if (pointsAllowed === 0) return 10
  if (pointsAllowed <= 6) return 7
  if (pointsAllowed <= 13) return 4
  if (pointsAllowed <= 20) return 1
  if (pointsAllowed <= 27) return 0
  if (pointsAllowed <= 34) return -1
  return -4
}

interface Columns {
  season: number
  week: number
  team: number
  opponent: number
  type: number | null
  passingTds: number | null
  rushingTds: number | null
  fumbleRecoveryTds: number | null
  specialTeamsTds: number | null
  defTds: number | null
  fgMade: number | null
  patMade: number | null
  passing2pt: number | null
  rushing2pt: number | null
  sacks: number | null
  interceptions: number | null
  fumbles: number | null
  safeties: number | null
  puntBlocks: number | null
  patBlocks: number | null
  fgBlocks: number | null
}

/**
 * Points a team scored in a week, from its own scoring plays.
 *
 * Receiving touchdowns are deliberately excluded: a passing touchdown and the
 * receiving touchdown on the same play are one score, and counting both would
 * double every passing score in the league.
 */
function pointsScored(row: string[], c: Columns): number {
  const get = (index: number | null) => num(row, index) ?? 0
  return (
    (get(c.passingTds) + get(c.rushingTds) + get(c.fumbleRecoveryTds) + get(c.specialTeamsTds) + get(c.defTds)) * 6 +
    get(c.fgMade) * 3 +
    get(c.patMade) +
    (get(c.passing2pt) + get(c.rushing2pt)) * 2 +
    get(c.safeties) * 2
  )
}

export function loadTeamDefense(seasons: number[]): TeamDefenseWeek[] {
  const output: TeamDefenseWeek[] = []

  for (const season of seasons) {
    const path = localPath('stats_team', `${season}.csv`)
    if (!fs.existsSync(path)) continue

    const table = parseCsv(fs.readFileSync(path, 'utf8'))
    const c: Columns = {
      season: column(table, 'season'),
      week: column(table, 'week'),
      team: column(table, 'team'),
      opponent: column(table, 'opponent_team'),
      type: optionalColumn(table, 'season_type'),
      passingTds: optionalColumn(table, 'passing_tds'),
      rushingTds: optionalColumn(table, 'rushing_tds'),
      fumbleRecoveryTds: optionalColumn(table, 'fumble_recovery_tds'),
      specialTeamsTds: optionalColumn(table, 'special_teams_tds'),
      defTds: optionalColumn(table, 'def_tds'),
      fgMade: optionalColumn(table, 'fg_made'),
      patMade: optionalColumn(table, 'pat_made'),
      passing2pt: optionalColumn(table, 'passing_2pt_conversions'),
      rushing2pt: optionalColumn(table, 'rushing_2pt_conversions'),
      sacks: optionalColumn(table, 'def_sacks'),
      interceptions: optionalColumn(table, 'def_interceptions'),
      fumbles: optionalColumn(table, 'def_fumbles'),
      safeties: optionalColumn(table, 'def_safeties'),
      puntBlocks: optionalColumn(table, 'def_punt_blocks'),
      patBlocks: optionalColumn(table, 'def_pat_blocks'),
      fgBlocks: optionalColumn(table, 'def_fg_blocks'),
    }

    // First pass: what every team scored, so the second pass can look up what
    // each defence allowed.
    const scored = new Map<string, number>()
    const rows: string[][] = []
    for (const row of table.rows) {
      if (c.type !== null && str(row, c.type) !== 'REG') continue
      rows.push(row)
      scored.set(`${str(row, c.week)}:${str(row, c.team)}`, pointsScored(row, c))
    }

    for (const row of rows) {
      const get = (index: number | null) => num(row, index) ?? 0
      const week = num(row, c.week) ?? 0
      const team = str(row, c.team)
      const opponent = str(row, c.opponent)

      const pointsAllowed = scored.get(`${week}:${opponent}`)
      // Without the opponent's row there is no points-allowed component, and a
      // defence's score is mostly points allowed. Skip rather than understate.
      if (pointsAllowed === undefined) continue

      const sacks = get(c.sacks)
      const takeaways = get(c.interceptions) + get(c.fumbles)
      const touchdowns = get(c.defTds) + get(c.specialTeamsTds)
      const blocks = get(c.puntBlocks) + get(c.patBlocks) + get(c.fgBlocks)

      output.push({
        season,
        week,
        team,
        opponent,
        pointsAllowed,
        sacks,
        takeaways,
        touchdowns,
        fantasyPoints:
          sacks +
          get(c.interceptions) * 2 +
          get(c.fumbles) * 2 +
          touchdowns * 6 +
          get(c.safeties) * 2 +
          blocks * 2 +
          pointsAllowedBonus(pointsAllowed),
      })
    }
  }

  return output
}

export interface DefenseSeason {
  team: string
  season: number
  games: number
  pointsPerGame: number
  totalPoints: number
  sacksPerGame: number
  takeawaysPerGame: number
  pointsAllowedPerGame: number
}

export function summariseDefenses(weeks: TeamDefenseWeek[]): DefenseSeason[] {
  const grouped = new Map<string, TeamDefenseWeek[]>()
  for (const week of weeks) {
    const key = `${week.team}:${week.season}`
    const list = grouped.get(key)
    if (list) list.push(week)
    else grouped.set(key, [week])
  }

  const output: DefenseSeason[] = []
  for (const [key, games] of grouped) {
    const [team, season] = key.split(':')
    if (!team || !season) continue

    const total = games.reduce((sum, game) => sum + game.fantasyPoints, 0)
    output.push({
      team,
      season: Number(season),
      games: games.length,
      totalPoints: total,
      pointsPerGame: total / games.length,
      sacksPerGame: games.reduce((s, g) => s + g.sacks, 0) / games.length,
      takeawaysPerGame: games.reduce((s, g) => s + g.takeaways, 0) / games.length,
      pointsAllowedPerGame: games.reduce((s, g) => s + g.pointsAllowed, 0) / games.length,
    })
  }

  return output
}
