import fs from 'node:fs'
import { column, num, optionalColumn, parseCsv, str } from './csv.js'
import { localPath } from './fetch.js'

/**
 * Typed views over the downloaded data.
 *
 * Only the columns the analyses actually use are lifted out; the files carry
 * well over a hundred each and materialising all of them would cost memory for
 * nothing.
 */

export interface WeeklyStat {
  playerId: string
  name: string
  position: string
  team: string
  season: number
  week: number
  seasonType: string
  fantasyPoints: number
  fantasyPointsPpr: number
  targets: number
  receptions: number
  carries: number
  targetShare: number | undefined
  airYardsShare: number | undefined
  /** Weighted opportunity rating: the best single measure of usage. */
  wopr: number | undefined
  passingAttempts: number
}

export function loadWeeklyStats(opts: { regularSeasonOnly?: boolean } = {}): WeeklyStat[] {
  const table = parseCsv(fs.readFileSync(localPath('player_stats.csv'), 'utf8'))

  const c = {
    playerId: column(table, 'player_id'),
    name: column(table, 'player_display_name'),
    position: column(table, 'position'),
    team: column(table, 'recent_team'),
    season: column(table, 'season'),
    week: column(table, 'week'),
    seasonType: column(table, 'season_type'),
    points: column(table, 'fantasy_points'),
    pointsPpr: column(table, 'fantasy_points_ppr'),
    targets: optionalColumn(table, 'targets'),
    receptions: optionalColumn(table, 'receptions'),
    carries: optionalColumn(table, 'carries'),
    targetShare: optionalColumn(table, 'target_share'),
    airYardsShare: optionalColumn(table, 'air_yards_share'),
    wopr: optionalColumn(table, 'wopr'),
    attempts: optionalColumn(table, 'attempts'),
  }

  const stats: WeeklyStat[] = []
  for (const row of table.rows) {
    const seasonType = str(row, c.seasonType)
    if (opts.regularSeasonOnly !== false && seasonType !== 'REG') continue

    stats.push({
      playerId: str(row, c.playerId),
      name: str(row, c.name),
      position: str(row, c.position),
      team: str(row, c.team),
      season: num(row, c.season) ?? 0,
      week: num(row, c.week) ?? 0,
      seasonType,
      fantasyPoints: num(row, c.points) ?? 0,
      fantasyPointsPpr: num(row, c.pointsPpr) ?? 0,
      targets: num(row, c.targets) ?? 0,
      receptions: num(row, c.receptions) ?? 0,
      carries: num(row, c.carries) ?? 0,
      targetShare: num(row, c.targetShare),
      airYardsShare: num(row, c.airYardsShare),
      wopr: num(row, c.wopr),
      passingAttempts: num(row, c.attempts) ?? 0,
    })
  }

  return stats
}

export interface PlayerBio {
  playerId: string
  name: string
  position: string
  birthDate: string
  draftYear: number | undefined
  draftRound: number | undefined
  draftPick: number | undefined
  rookieYear: number | undefined
}

export function loadPlayers(): Map<string, PlayerBio> {
  const table = parseCsv(fs.readFileSync(localPath('players.csv'), 'utf8'))

  // nflverse has renamed some of these over time, so accept either spelling.
  const idCol =
    optionalColumn(table, 'gsis_id') ??
    optionalColumn(table, 'player_id') ??
    column(table, 'gsis_it_id')

  const c = {
    name: optionalColumn(table, 'display_name') ?? optionalColumn(table, 'full_name'),
    position: optionalColumn(table, 'position'),
    birthDate: optionalColumn(table, 'birth_date'),
    draftYear: optionalColumn(table, 'draft_year') ?? optionalColumn(table, 'entry_year'),
    draftRound: optionalColumn(table, 'draft_round'),
    draftPick: optionalColumn(table, 'draft_number') ?? optionalColumn(table, 'draft_pick'),
    rookieYear: optionalColumn(table, 'rookie_year') ?? optionalColumn(table, 'rookie_season'),
  }

  const players = new Map<string, PlayerBio>()
  for (const row of table.rows) {
    const playerId = str(row, idCol)
    if (!playerId) continue

    players.set(playerId, {
      playerId,
      name: str(row, c.name),
      position: str(row, c.position),
      birthDate: str(row, c.birthDate),
      draftYear: num(row, c.draftYear),
      draftRound: num(row, c.draftRound),
      draftPick: num(row, c.draftPick),
      rookieYear: num(row, c.rookieYear),
    })
  }

  return players
}

export interface InjuryReport {
  season: number
  week: number
  playerId: string
  name: string
  position: string
  team: string
  /** "Out", "Questionable", "Doubtful", or empty. */
  gameStatus: string
  /** The body part, when reported. */
  primaryInjury: string
}

export function loadInjuries(seasons: number[]): InjuryReport[] {
  const reports: InjuryReport[] = []

  for (const season of seasons) {
    const file = localPath('injuries', `${season}.csv`)
    if (!fs.existsSync(file)) continue

    const table = parseCsv(fs.readFileSync(file, 'utf8'))
    const idCol = optionalColumn(table, 'gsis_id') ?? optionalColumn(table, 'player_id')
    const c = {
      week: optionalColumn(table, 'week'),
      name: optionalColumn(table, 'full_name') ?? optionalColumn(table, 'player_name'),
      position: optionalColumn(table, 'position'),
      team: optionalColumn(table, 'team'),
      status: optionalColumn(table, 'report_status') ?? optionalColumn(table, 'game_status'),
      injury: optionalColumn(table, 'report_primary_injury') ?? optionalColumn(table, 'primary_injury'),
    }

    for (const row of table.rows) {
      const playerId = str(row, idCol)
      if (!playerId) continue
      reports.push({
        season,
        week: num(row, c.week) ?? 0,
        playerId,
        name: str(row, c.name),
        position: str(row, c.position),
        team: str(row, c.team),
        gameStatus: str(row, c.status),
        primaryInjury: str(row, c.injury),
      })
    }
  }

  return reports
}

export interface SnapCount {
  season: number
  week: number
  player: string
  position: string
  team: string
  offenseSnaps: number
  offensePct: number
}

export function loadSnapCounts(seasons: number[]): SnapCount[] {
  const counts: SnapCount[] = []

  for (const season of seasons) {
    const file = localPath('snap_counts', `${season}.csv`)
    if (!fs.existsSync(file)) continue

    const table = parseCsv(fs.readFileSync(file, 'utf8'))
    const c = {
      week: optionalColumn(table, 'week'),
      player: optionalColumn(table, 'player'),
      position: optionalColumn(table, 'position'),
      team: optionalColumn(table, 'team'),
      snaps: optionalColumn(table, 'offense_snaps'),
      pct: optionalColumn(table, 'offense_pct'),
    }

    for (const row of table.rows) {
      counts.push({
        season,
        week: num(row, c.week) ?? 0,
        player: str(row, c.player),
        position: str(row, c.position),
        team: str(row, c.team),
        offenseSnaps: num(row, c.snaps) ?? 0,
        offensePct: num(row, c.pct) ?? 0,
      })
    }
  }

  return counts
}
