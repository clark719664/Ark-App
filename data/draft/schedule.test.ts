import { describe, expect, it } from 'vitest'
import { byeStacks, loadByeWeeks } from './schedule.js'

/**
 * The bye derivation runs against the real schedule file when it has been
 * downloaded, because the failure this guards against is a partial schedule
 * producing plausible-looking wrong byes — which no synthetic fixture would
 * catch, since a fixture is complete by construction.
 */

const byes2026 = loadByeWeeks(2026)

describe('bye stacks', () => {
  it('counts how many share each week, worst first', () => {
    expect(byeStacks([11, 7, 11, 11, 7])).toEqual([
      { week: 11, count: 3 },
      { week: 7, count: 2 },
    ])
  })

  it('ignores players whose bye is unknown', () => {
    expect(byeStacks([null, 9, null])).toEqual([{ week: 9, count: 1 }])
    expect(byeStacks([null, null])).toEqual([])
  })
})

describe('bye weeks', () => {
  it('reports nothing for a season with no schedule rather than guessing', () => {
    expect(loadByeWeeks(2099)).toBeNull()
  })

  it.skipIf(byes2026 === null)('gives all 32 teams exactly one bye', () => {
    const byes = byes2026 as NonNullable<typeof byes2026>
    expect(byes.byTeam.size).toBe(32)
    // Byes have never fallen outside this window in the modern schedule, and a
    // week 1 or week 18 "bye" is the signature of a schedule missing games.
    for (const [team, week] of byes.byTeam) {
      expect(week, team).toBeGreaterThanOrEqual(4)
      expect(week, team).toBeLessThanOrEqual(15)
    }
  })

  it.skipIf(byes2026 === null)('spreads byes across several weeks', () => {
    const byes = byes2026 as NonNullable<typeof byes2026>
    const weeks = new Set(byes.byTeam.values())
    // Every team on bye in one week would mean the schedule only covers part of
    // the season and the derivation has latched onto the missing part.
    expect(weeks.size).toBeGreaterThan(3)
  })
})
