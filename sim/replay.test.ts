import { describe, expect, it } from 'vitest'
import { normName, pickLineup, projectBefore, sum, type Candidate, type WeeklyPoints } from './replay.js'

function candidate(overrides: Partial<Candidate> & { name: string }): Candidate {
  return {
    position: 'RB',
    projection: 0,
    actual: 0,
    available: true,
    started: false,
    ...overrides,
  }
}

const weekly: WeeklyPoints = {
  points: new Map([
    ['1|alpha', 10],
    ['2|alpha', 20],
    ['3|alpha', 300],
  ]),
  position: new Map([['alpha', 'RB']]),
  team: new Map([['alpha', 'SF']]),
}

describe('replay projections', () => {
  it('cannot see the week it is projecting', () => {
    // Week 3 scored 300; a projection for week 3 must not reflect it.
    const beforeWeek3 = projectBefore('alpha', 'RB', 3, weekly, new Map())
    const beforeWeek4 = projectBefore('alpha', 'RB', 4, weekly, new Map())
    expect(beforeWeek3).toBeLessThan(30)
    expect(beforeWeek4).toBeGreaterThan(beforeWeek3)
  })

  it('falls back to the prior season when a player has not played yet', () => {
    const prior = new Map([['alpha', 14]])
    expect(projectBefore('alpha', 'RB', 1, weekly, prior)).toBe(14)
  })

  it('falls back to replacement when there is nothing at all', () => {
    expect(projectBefore('nobody', 'QB', 1, weekly, new Map())).toBe(11)
  })
})

describe('lineup selection', () => {
  const pool = [
    candidate({ name: 'qb1', position: 'QB', projection: 20, actual: 5 }),
    candidate({ name: 'rb1', position: 'RB', projection: 15, actual: 1 }),
    candidate({ name: 'rb2', position: 'RB', projection: 12, actual: 2 }),
    candidate({ name: 'rb3', position: 'RB', projection: 11, actual: 30 }),
    candidate({ name: 'wr1', position: 'WR', projection: 14, actual: 3 }),
    candidate({ name: 'wr2', position: 'WR', projection: 13, actual: 4 }),
    // Buried by projection, best on the day: the whole reason the ceiling is
    // out of reach in advance.
    candidate({ name: 'wr3', position: 'WR', projection: 2, actual: 40 }),
    candidate({ name: 'te1', position: 'TE', projection: 9, actual: 6 }),
  ]

  it('fills every slot once and only once', () => {
    const picked = pickLineup(pool, (c) => c.projection)
    expect(picked).toHaveLength(7)
    expect(new Set(picked.map((c) => c.name)).size).toBe(7)
  })

  it('ranks by whatever it is given, so the ceiling differs from the projection', () => {
    const byProjection = sum(pickLineup(pool, (c) => c.projection))
    const byActual = sum(pickLineup(pool, (c) => c.actual))
    expect(byActual).toBeGreaterThan(byProjection)
  })

  it('never starts a player who was ruled out or on a bye', () => {
    const withOut = pool.map((c) => (c.name === 'qb1' ? { ...c, available: false } : c))
    const picked = pickLineup(withOut, (c) => c.projection)
    expect(picked.some((c) => c.name === 'qb1')).toBe(false)
  })

  it('uses the flex for the best remaining runner, receiver or tight end', () => {
    const picked = pickLineup(pool, (c) => c.projection)
    expect(picked.filter((c) => c.position === 'RB')).toHaveLength(3)
  })
})

describe('name normalisation', () => {
  it('matches the same player across the two sources', () => {
    expect(normName('Marvin Harrison Jr.')).toBe(normName('marvin harrison'))
    expect(normName("Ja'Marr Chase")).toBe('jamarr chase')
  })
})
