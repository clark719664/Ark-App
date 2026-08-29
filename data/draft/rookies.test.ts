import { describe, expect, it } from 'vitest'
import { rookieBaseline, rookieKey, type RookieCurve } from './rookies.js'

const curve: RookieCurve = {
  points: {
    RB: [
      { pick: 8, ppg: 15 },
      { pick: 24, ppg: 12 },
      { pick: 48, ppg: 11 },
      { pick: 220, ppg: 4 },
    ],
  },
  sampleSize: 100,
}

describe('rookie keys', () => {
  it('matches the two sources spelling a name differently', () => {
    expect(rookieKey('Marvin Harrison Jr.', 'WR')).toBe(rookieKey('marvin harrison', 'WR'))
    expect(rookieKey("Ja'Marr Chase", 'WR')).toBe(rookieKey('JaMarr Chase', 'WR'))
  })

  it('keeps position in the key, so a shared name is not merged', () => {
    expect(rookieKey('Josh Allen', 'QB')).not.toBe(rookieKey('Josh Allen', 'LB'))
  })
})

describe('rookie baseline', () => {
  it('is worth more at the top of the draft than the bottom', () => {
    const early = rookieBaseline(curve, 'RB', 3) ?? 0
    const late = rookieBaseline(curve, 'RB', 200) ?? 0
    expect(early).toBeGreaterThan(late)
  })

  it('never rises as the pick gets later', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let pick = 1; pick <= 260; pick++) {
      const value = rookieBaseline(curve, 'RB', pick) ?? 0
      expect(value).toBeLessThanOrEqual(previous + 1e-9)
      previous = value
    }
  })

  it('interpolates between measured points rather than stepping', () => {
    const midpoint = rookieBaseline(curve, 'RB', 16) ?? 0
    expect(midpoint).toBeLessThan(15)
    expect(midpoint).toBeGreaterThan(12)
  })

  it('is flat outside the range it measured', () => {
    expect(rookieBaseline(curve, 'RB', 1)).toBe(15)
    expect(rookieBaseline(curve, 'RB', 259)).toBe(4)
  })

  it('returns nothing for a position it has no data for, so the caller falls back', () => {
    expect(rookieBaseline(curve, 'TE', 10)).toBeNull()
  })
})
