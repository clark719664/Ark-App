import fs from 'node:fs'
import { parseCsv } from './csv.js'
import { localPath } from './fetch.js'
import { missingOffenseColumns } from './draft/scoring.js'

/**
 * Check that what was downloaded is what the analyses need.
 *
 * A download can succeed and still be useless. The failure that reached a draft
 * board twice was a weekly stats file carrying touchdowns but no yardage: it
 * parses, it has a row per player per week, and every player scores a fraction
 * of what he really did. Nothing about that looks wrong until you notice a
 * starting running back projected at three points a game.
 *
 * So this checks the shape of each file rather than its presence, and it runs
 * at the end of a fetch, where the fix is obvious, rather than at build time
 * where the symptom is a plausible-looking board.
 */

export interface FileReport {
  file: string
  ok: boolean
  detail: string
}

const MIN_ROWS_PER_SEASON = 2000

function checkStatsSeason(season: number): FileReport {
  const file = localPath('stats_player', `${season}.csv`)
  if (!fs.existsSync(file)) {
    return { file: `stats_player/${season}.csv`, ok: false, detail: 'missing' }
  }

  const text = fs.readFileSync(file, 'utf8')
  if (text.length < 1000) {
    return { file: `stats_player/${season}.csv`, ok: false, detail: `only ${text.length} bytes` }
  }

  const table = parseCsv(text)
  const missing = missingOffenseColumns(table)
  if (missing.length > 0) {
    return {
      file: `stats_player/${season}.csv`,
      ok: false,
      detail: `missing scoring columns: ${missing.join(', ')}`,
    }
  }
  if (table.rows.length < MIN_ROWS_PER_SEASON) {
    return {
      file: `stats_player/${season}.csv`,
      ok: false,
      // A full season is roughly ten thousand player-weeks; a few hundred means
      // a partial download, which regresses every projection toward nothing.
      detail: `only ${table.rows.length} rows, expected at least ${MIN_ROWS_PER_SEASON}`,
    }
  }

  return { file: `stats_player/${season}.csv`, ok: true, detail: `${table.rows.length} rows` }
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
  const reports: FileReport[] = played.map(checkStatsSeason)

  for (const past of played) {
    reports.push(
      checkPresence(`stats_team/${past}.csv`, localPath('stats_team', `${past}.csv`), 5000),
    )
  }

  // The roster for the season being drafted is the list of who exists at all.
  reports.push(
    checkPresence(`rosters/${season}.csv`, localPath('rosters', `${season}.csv`), 5000),
  )
  reports.push(checkPresence('games.csv', localPath('games.csv'), 100_000))
  reports.push(checkPresence('draft_picks.csv', localPath('draft_picks.csv'), 100_000))

  return reports
}
