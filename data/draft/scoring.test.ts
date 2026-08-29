import { describe, expect, it } from 'vitest'
import { parseCsv } from '../csv.js'
import {
  loadLeagueScoring,
  missingOffenseColumns,
  offenseColumns,
  offensePoints,
  PPR_SCORING,
  type LeagueScoring,
} from './scoring.js'

const HALF_PPR: LeagueScoring = { ...PPR_SCORING, receptions: 0.5, completions: 0.1 }

/** One receiving week: 8 catches, 100 yards, 1 TD. */
const RECEIVER = parseCsv(
  'player_id,receptions,receiving_yards,receiving_tds\n' + 'p1,8,100,1\n',
)

/** One passing week: 25 of 35, 300 yards, 2 TD, 1 INT. */
const PASSER = parseCsv(
  'player_id,completions,passing_yards,passing_tds,passing_interceptions\n' + 'p2,25,300,2,1\n',
)

function score(table: ReturnType<typeof parseCsv>, scoring: LeagueScoring): number {
  const row = table.rows[0]
  if (!row) throw new Error('fixture has no rows')
  return offensePoints(row, offenseColumns(table), scoring)
}

describe('offense scoring', () => {
  it('scores a receiving line in full PPR', () => {
    // 8 catches + 100 yards (10) + TD (6)
    expect(score(RECEIVER, PPR_SCORING)).toBeCloseTo(24, 5)
  })

  it('pays half as much for the same catches in half PPR', () => {
    // 4 for catches + 10 yards + 6 TD
    expect(score(RECEIVER, HALF_PPR)).toBeCloseTo(20, 5)
  })

  it('scores a passing line, including a per-completion bonus', () => {
    // 300 * 0.04 = 12, + 8 for two TDs, - 2 for the pick
    expect(score(PASSER, PPR_SCORING)).toBeCloseTo(18, 5)
    // the same line plus 25 completions at 0.1
    expect(score(PASSER, HALF_PPR)).toBeCloseTo(20.5, 5)
  })

  it('treats a missing column as zero rather than failing', () => {
    const sparse = parseCsv('player_id,rushing_yards\np3,50\n')
    expect(score(sparse, HALF_PPR)).toBeCloseTo(5, 5)
  })

  it('falls back to full PPR when no league has been exported', () => {
    const { scoring, source } = loadLeagueScoring('does/not/exist.json')
    expect(scoring.receptions).toBe(1)
    expect(source).toMatch(/PPR/i)
  })
})

describe('required scoring columns', () => {
  it('accepts a file that carries everything', () => {
    const table = parseCsv(
      'player_id,passing_yards,passing_tds,rushing_yards,rushing_tds,receptions,receiving_yards,receiving_tds\n' +
        'p1,0,0,0,0,0,0,0\n',
    )
    expect(missingOffenseColumns(table)).toEqual([])
  })

  it('names the columns a thin file is missing rather than scoring it as zero', () => {
    // The exact shape that produced a board projecting a starting back at 3.9:
    // touchdowns present, every yardage column gone.
    const table = parseCsv('player_id,passing_tds,rushing_tds,receiving_tds\np1,1,1,1\n')
    const missing = missingOffenseColumns(table)
    expect(missing).toContain('passing_yards')
    expect(missing).toContain('rushing_yards')
    expect(missing).toContain('receiving_yards')
    expect(missing).toContain('receptions')
  })

  it('accepts the older nflverse spellings', () => {
    const table = parseCsv(
      'player_id,pass_yards,pass_tds,rush_yards,rush_tds,rec,rec_yards,rec_tds\n' +
        'p1,0,0,0,0,0,0,0\n',
    )
    expect(missingOffenseColumns(table)).toEqual([])
  })

  it('scores the same line whichever spelling the file uses', () => {
    const modern = parseCsv('player_id,receptions,receiving_yards,receiving_tds\np1,8,100,1\n')
    const older = parseCsv('player_id,rec,rec_yards,rec_tds\np1,8,100,1\n')
    const rowA = modern.rows[0]
    const rowB = older.rows[0]
    if (!rowA || !rowB) throw new Error('fixture has no rows')
    expect(offensePoints(rowA, offenseColumns(modern), PPR_SCORING)).toBeCloseTo(
      offensePoints(rowB, offenseColumns(older), PPR_SCORING),
      5,
    )
  })
})
