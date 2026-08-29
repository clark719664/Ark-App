import { describe, expect, it } from 'vitest'
import { parseCsv } from '../csv.js'
import {
  loadLeagueScoring,
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
