import fs from 'node:fs'
import path from 'node:path'
import { num, type CsvTable, optionalColumn } from '../csv.js'

/**
 * What a league pays for each event.
 *
 * The draft pool used to take nflverse's precomputed `fantasy_points_ppr`,
 * which is full PPR. That is the wrong currency for most leagues and it does
 * not fail loudly: every player still gets a number, the board still ranks,
 * and the ranking is quietly wrong in a consistent direction. Half-PPR scored
 * as full PPR overpays volume receivers against the same player's real worth,
 * and a per-completion bonus that nflverse knows nothing about silently
 * underpays quarterbacks.
 *
 * So scoring is an input, read from the league itself, not a constant.
 */
export interface LeagueScoring {
  completions: number
  passingYards: number
  passingTds: number
  interceptions: number
  rushingYards: number
  rushingTds: number
  receptions: number
  receivingYards: number
  receivingTds: number
  returnTds: number
  twoPointConversions: number
  fumblesLost: number
  fieldGoals: { b0: number; b20: number; b30: number; b40: number; b50: number; b60: number }
  fieldGoalMissed: number
  patMade: number
  patMissed: number
}

/** Full PPR with conventional everything else — what nflverse's column means. */
export const PPR_SCORING: LeagueScoring = {
  completions: 0,
  passingYards: 0.04,
  passingTds: 4,
  interceptions: -2,
  rushingYards: 0.1,
  rushingTds: 6,
  receptions: 1,
  receivingYards: 0.1,
  receivingTds: 6,
  returnTds: 6,
  twoPointConversions: 2,
  fumblesLost: -2,
  fieldGoals: { b0: 3, b20: 3, b30: 3, b40: 4, b50: 5, b60: 5 },
  fieldGoalMissed: -1,
  patMade: 1,
  patMissed: -1,
}

const DERIVED = path.resolve(process.cwd(), 'data/derived/league-scoring.json')

/**
 * The league's own scoring if it has been exported, otherwise full PPR.
 * Falling back rather than throwing keeps a fresh clone able to run a draft.
 */
export function loadLeagueScoring(file = DERIVED): { scoring: LeagueScoring; source: string } {
  if (!fs.existsSync(file)) return { scoring: PPR_SCORING, source: 'default full PPR' }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    leagueName?: string
    scoring: LeagueScoring
  }
  return { scoring: parsed.scoring, source: parsed.leagueName ?? 'league export' }
}

export interface OffenseColumns {
  completions: number | null
  passingYards: number | null
  passingTds: number | null
  interceptions: number | null
  rushingYards: number | null
  rushingTds: number | null
  receptions: number | null
  receivingYards: number | null
  receivingTds: number | null
  specialTeamsTds: number | null
  passing2pt: number | null
  rushing2pt: number | null
  receiving2pt: number | null
  sackFumblesLost: number | null
  rushingFumblesLost: number | null
  receivingFumblesLost: number | null
}

/**
 * Column names, with the spellings nflverse has used over time.
 *
 * Every one of these was optional once, which meant a renamed or absent column
 * contributed zero points in silence. That does not fail: every player still
 * gets a number, the board still ranks, and the whole thing is quietly low.
 * It is how a pool projecting a starting back at 3.9 a game reached a draft.
 */
const COLUMN_NAMES = {
  completions: ['completions', 'pass_completions'],
  passingYards: ['passing_yards', 'pass_yards'],
  passingTds: ['passing_tds', 'pass_touchdowns', 'pass_tds'],
  interceptions: ['passing_interceptions', 'interceptions', 'pass_interceptions'],
  rushingYards: ['rushing_yards', 'rush_yards'],
  rushingTds: ['rushing_tds', 'rush_touchdowns', 'rush_tds'],
  receptions: ['receptions', 'rec'],
  receivingYards: ['receiving_yards', 'rec_yards'],
  receivingTds: ['receiving_tds', 'rec_touchdowns', 'rec_tds'],
  specialTeamsTds: ['special_teams_tds', 'special_teams_touchdowns'],
  passing2pt: ['passing_2pt_conversions', 'pass_two_point_conversions'],
  rushing2pt: ['rushing_2pt_conversions', 'rush_two_point_conversions'],
  receiving2pt: ['receiving_2pt_conversions', 'rec_two_point_conversions'],
  sackFumblesLost: ['sack_fumbles_lost'],
  rushingFumblesLost: ['rushing_fumbles_lost', 'rush_fumbles_lost'],
  receivingFumblesLost: ['receiving_fumbles_lost', 'rec_fumbles_lost'],
} as const satisfies Record<keyof OffenseColumns, readonly string[]>

/**
 * Without these the score is not merely incomplete, it is wrong: yardage and
 * receptions are most of every skill player's points, so a file missing them
 * produces a board that looks complete and ranks nobody correctly.
 */
const REQUIRED: Array<keyof OffenseColumns> = [
  'passingYards',
  'passingTds',
  'rushingYards',
  'rushingTds',
  'receptions',
  'receivingYards',
  'receivingTds',
]

function resolve(table: CsvTable, names: readonly string[]): number | null {
  for (const name of names) {
    const found = optionalColumn(table, name)
    if (found !== null) return found
  }
  return null
}

export function offenseColumns(table: CsvTable): OffenseColumns {
  const out = {} as OffenseColumns
  for (const [key, names] of Object.entries(COLUMN_NAMES)) {
    out[key as keyof OffenseColumns] = resolve(table, names)
  }
  return out
}

/** Which scoring columns are missing entirely, by the name they are looked for. */
export function missingOffenseColumns(table: CsvTable): string[] {
  const missing: string[] = []
  for (const key of REQUIRED) {
    if (resolve(table, COLUMN_NAMES[key]) === null) missing.push(COLUMN_NAMES[key][0] ?? key)
  }
  return missing
}

/** One player's score for one week, computed from events rather than read off. */
export function offensePoints(
  row: string[],
  c: OffenseColumns,
  scoring: LeagueScoring,
): number {
  const get = (index: number | null) => num(row, index) ?? 0

  const fumblesLost =
    get(c.sackFumblesLost) + get(c.rushingFumblesLost) + get(c.receivingFumblesLost)
  const twoPoint = get(c.passing2pt) + get(c.rushing2pt) + get(c.receiving2pt)

  return (
    get(c.completions) * scoring.completions +
    get(c.passingYards) * scoring.passingYards +
    get(c.passingTds) * scoring.passingTds +
    get(c.interceptions) * scoring.interceptions +
    get(c.rushingYards) * scoring.rushingYards +
    get(c.rushingTds) * scoring.rushingTds +
    get(c.receptions) * scoring.receptions +
    get(c.receivingYards) * scoring.receivingYards +
    get(c.receivingTds) * scoring.receivingTds +
    get(c.specialTeamsTds) * scoring.returnTds +
    twoPoint * scoring.twoPointConversions +
    fumblesLost * scoring.fumblesLost
  )
}
