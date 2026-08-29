import fs from 'node:fs'
import { num, optionalColumn, parseCsv, type CsvTable } from './csv.js'
import { localPath } from './fetch.js'

/**
 * Check that what was downloaded is what the analyses need.
 *
 * A download can succeed and still be useless. The failure that reached a draft
 * board twice was a weekly stats file carrying touchdowns but no yardage: it
 * parses, it has a row per player per week, and every player scores a fraction
 * of what he really did. Nothing about that looks wrong until you notice a
 * starting running back projected at three points a game.
 *
 * So every column any scoring rule reads is checked, and checked two ways:
 * present, and carrying at least one non-zero value. Presence alone is not
 * enough - a column of empty strings resolves fine and scores nothing. Over a
 * completed season every one of these events happens at least once, including
 * the rare ones: the thinnest in a real file is four field goals under twenty
 * yards, and ten blocked punts. Nothing legitimate is ever entirely absent.
 *
 * The season being drafted is exempt, because no games have been played in it.
 */

export interface FileReport {
  file: string
  ok: boolean
  detail: string
}

/** Roughly ten thousand player-weeks a season; a few hundred means a stub. */
const MIN_STATS_ROWS = 2000
const MIN_TEAM_ROWS = 200

/**
 * Every column the scoring reads, with the spellings nflverse has used. Listed
 * here rather than imported so that adding a scoring rule without adding its
 * column to this list is a visible omission rather than a silent one.
 */
const PLAYER_COLUMNS: Record<string, readonly string[]> = {
  completions: ['completions', 'pass_completions'],
  passing_yards: ['passing_yards', 'pass_yards'],
  passing_tds: ['passing_tds', 'pass_touchdowns', 'pass_tds'],
  passing_interceptions: ['passing_interceptions', 'interceptions', 'pass_interceptions'],
  rushing_yards: ['rushing_yards', 'rush_yards'],
  rushing_tds: ['rushing_tds', 'rush_touchdowns', 'rush_tds'],
  receptions: ['receptions', 'rec'],
  receiving_yards: ['receiving_yards', 'rec_yards'],
  receiving_tds: ['receiving_tds', 'rec_touchdowns', 'rec_tds'],
  special_teams_tds: ['special_teams_tds', 'special_teams_touchdowns'],
  passing_2pt_conversions: ['passing_2pt_conversions', 'pass_two_point_conversions'],
  rushing_2pt_conversions: ['rushing_2pt_conversions', 'rush_two_point_conversions'],
  receiving_2pt_conversions: ['receiving_2pt_conversions', 'rec_two_point_conversions'],
  sack_fumbles_lost: ['sack_fumbles_lost'],
  rushing_fumbles_lost: ['rushing_fumbles_lost', 'rush_fumbles_lost'],
  receiving_fumbles_lost: ['receiving_fumbles_lost', 'rec_fumbles_lost'],
  fg_made_0_19: ['fg_made_0_19'],
  fg_made_20_29: ['fg_made_20_29'],
  fg_made_30_39: ['fg_made_30_39'],
  fg_made_40_49: ['fg_made_40_49'],
  fg_made_50_59: ['fg_made_50_59'],
  fg_made_60_: ['fg_made_60_'],
  fg_missed: ['fg_missed'],
  pat_made: ['pat_made'],
  pat_missed: ['pat_missed'],
}

const TEAM_COLUMNS: Record<string, readonly string[]> = {
  def_sacks: ['def_sacks'],
  def_interceptions: ['def_interceptions'],
  def_fumbles: ['def_fumbles'],
  def_tds: ['def_tds'],
  def_safeties: ['def_safeties'],
  def_punt_blocks: ['def_punt_blocks'],
  def_fg_blocks: ['def_fg_blocks'],
  def_pat_blocks: ['def_pat_blocks'],
  passing_tds: ['passing_tds', 'pass_tds'],
  rushing_tds: ['rushing_tds', 'rush_tds'],
  fumble_recovery_tds: ['fumble_recovery_tds'],
  special_teams_tds: ['special_teams_tds'],
  fg_made: ['fg_made'],
  pat_made: ['pat_made'],
  passing_2pt_conversions: ['passing_2pt_conversions'],
  rushing_2pt_conversions: ['rushing_2pt_conversions'],
}

function resolve(table: CsvTable, names: readonly string[]): number | null {
  for (const name of names) {
    const found = optionalColumn(table, name)
    if (found !== null) return found
  }
  return null
}

/** Columns that are absent, and columns that are present but never populated. */
export function auditColumns(
  table: CsvTable,
  columns: Record<string, readonly string[]>,
): { absent: string[]; empty: string[] } {
  const absent: string[] = []
  const empty: string[] = []

  for (const [label, names] of Object.entries(columns)) {
    const index = resolve(table, names)
    if (index === null) {
      absent.push(label)
      continue
    }
    let populated = false
    for (const row of table.rows) {
      const value = num(row, index)
      if (value !== undefined && value !== 0) {
        populated = true
        break
      }
    }
    if (!populated) empty.push(label)
  }

  return { absent, empty }
}

function checkTable(
  label: string,
  path: string,
  columns: Record<string, readonly string[]>,
  minRows: number,
): FileReport {
  if (!fs.existsSync(path)) return { file: label, ok: false, detail: 'missing' }

  const text = fs.readFileSync(path, 'utf8')
  if (text.length < 1000) return { file: label, ok: false, detail: `only ${text.length} bytes` }

  const table = parseCsv(text)
  if (table.rows.length < minRows) {
    return {
      file: label,
      ok: false,
      detail: `only ${table.rows.length} rows, expected at least ${minRows}`,
    }
  }

  const { absent, empty } = auditColumns(table, columns)
  if (absent.length > 0) {
    return { file: label, ok: false, detail: `${absent.length} columns absent: ${absent.join(', ')}` }
  }
  if (empty.length > 0) {
    return {
      file: label,
      ok: false,
      detail: `${empty.length} columns present but never populated: ${empty.join(', ')}`,
    }
  }

  const count = Object.keys(columns).length
  return { file: label, ok: true, detail: `${table.rows.length} rows, all ${count} columns populated` }
}

function checkPresence(label: string, path: string, minBytes: number): FileReport {
  if (!fs.existsSync(path)) return { file: label, ok: false, detail: 'missing' }
  const size = fs.statSync(path).size
  if (size < minBytes) return { file: label, ok: false, detail: `only ${size} bytes` }
  return { file: label, ok: true, detail: `${Math.round(size / 1024)} KB` }
}

/**
 * @param season The season being drafted for. Its own stats do not exist yet -
 *   no games have been played - so only its roster is required. The seasons a
 *   projection is actually built from are the three before it.
 */
export function verifyData(season: number): FileReport[] {
  const played = [season - 1, season - 2, season - 3]
  const reports: FileReport[] = []

  for (const past of played) {
    reports.push(
      checkTable(
        `stats_player/${past}.csv`,
        localPath('stats_player', `${past}.csv`),
        PLAYER_COLUMNS,
        MIN_STATS_ROWS,
      ),
    )
  }
  for (const past of played) {
    reports.push(
      checkTable(
        `stats_team/${past}.csv`,
        localPath('stats_team', `${past}.csv`),
        TEAM_COLUMNS,
        MIN_TEAM_ROWS,
      ),
    )
  }

  // The roster for the season being drafted is the list of who exists at all.
  reports.push(checkPresence(`rosters/${season}.csv`, localPath('rosters', `${season}.csv`), 5000))
  reports.push(checkPresence('games.csv', localPath('games.csv'), 100_000))
  reports.push(checkPresence('draft_picks.csv', localPath('draft_picks.csv'), 100_000))

  return reports
}

/** The player-stats audit, for callers that read the file directly. */
export function auditPlayerStats(table: CsvTable): { absent: string[]; empty: string[] } {
  return auditColumns(table, PLAYER_COLUMNS)
}
