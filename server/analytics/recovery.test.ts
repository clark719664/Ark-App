import { describe, expect, it } from 'vitest'
import { recoveryFor } from './recovery.js'

/**
 * These multipliers come from 16 seasons of injury reports joined to weekly
 * scoring, not from intuition. The tests pin the behaviour that follows from
 * them: long absences and structural injuries cost real production, short ones
 * and soft-tissue knocks largely do not, and the effect fades.
 */

describe('recoveryFor', () => {
  it('applies no discount to a player who missed nothing', () => {
    expect(recoveryFor({ weeksMissed: 0, gamesSinceReturn: 0 }).multiplier).toBe(1)
    expect(recoveryFor({ weeksMissed: 1, gamesSinceReturn: 0 }).multiplier).toBe(1)
  })

  it('discounts the first game back hardest after a long absence', () => {
    const firstGame = recoveryFor({ weeksMissed: 6, gamesSinceReturn: 0 })
    const thirdGame = recoveryFor({ weeksMissed: 6, gamesSinceReturn: 2 })

    expect(firstGame.multiplier).toBeLessThan(thirdGame.multiplier)
    expect(firstGame.multiplier).toBeCloseTo(0.66, 2)
    expect(firstGame.reason).toMatch(/missed 6 weeks/i)
  })

  it('lets the effect fade once a player has a few games back', () => {
    expect(recoveryFor({ weeksMissed: 6, gamesSinceReturn: 4 }).multiplier).toBe(1)
  })

  it('treats a knee far more cautiously than an ankle', () => {
    const knee = recoveryFor({ weeksMissed: 3, gamesSinceReturn: 1, injury: 'Knee' })
    const ankle = recoveryFor({ weeksMissed: 3, gamesSinceReturn: 1, injury: 'Ankle' })

    expect(knee.multiplier).toBeLessThan(ankle.multiplier)
    expect(knee.reason).toMatch(/knee/i)
    // The ankle itself costs almost nothing, so what remains is the cost of
    // having missed three weeks at all — which applies whatever the injury was.
    expect(ankle.multiplier).toBeCloseTo(0.89, 2)
    expect(knee.multiplier).toBeCloseTo(0.8, 2)
  })

  it('reads the body part out of a longer description', () => {
    const result = recoveryFor({
      weeksMissed: 3,
      gamesSinceReturn: 1,
      injury: 'Left hamstring strain',
    })
    expect(result.reason).toMatch(/hamstring/i)
  })

  it('never compounds the two measurements into an absurd discount', () => {
    // Weeks missed and injury type describe the same absences, so the estimate
    // takes the more cautious rather than multiplying them together.
    const result = recoveryFor({ weeksMissed: 6, gamesSinceReturn: 0, injury: 'knee' })
    expect(result.multiplier).toBeGreaterThan(0.6)
    expect(result.multiplier).toBeLessThan(1)
  })

  it('applies no discount when the injury is unrecognised and the absence short', () => {
    expect(
      recoveryFor({ weeksMissed: 2, gamesSinceReturn: 2, injury: 'illness' }).multiplier,
    ).toBeGreaterThan(0.85)
  })
})
