import { describe, expect, it } from 'vitest'
import { DEFAULT_SHAPE, loadDraftPool, rankPool, type DraftPool } from './draftPool.js'
import { pointsAllowedBonus } from '../data/draft/defense.js'

/**
 * The draft board is the one screen that has to work before a league exists, so
 * these run against the committed pool rather than a fixture: if the shipped
 * file is wrong, the board is wrong on draft night and no synthetic test would
 * have said so.
 */

const pool = loadDraftPool()

describe('points allowed bonus', () => {
  it('rewards a shutout and punishes a blowout', () => {
    expect(pointsAllowedBonus(0)).toBeGreaterThan(pointsAllowedBonus(6))
    expect(pointsAllowedBonus(6)).toBeGreaterThan(pointsAllowedBonus(20))
    expect(pointsAllowedBonus(35)).toBeLessThan(0)
  })

  it('never rises as more points are allowed', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let allowed = 0; allowed <= 60; allowed++) {
      const bonus = pointsAllowedBonus(allowed)
      expect(bonus).toBeLessThanOrEqual(previous)
      previous = bonus
    }
  })
})

describe.skipIf(pool === null)('the committed draft pool', () => {
  const loaded = pool as DraftPool

  it('carries a defence for every NFL team', () => {
    const defenses = loaded.players.filter((player) => player.position === 'DEF')
    expect(defenses).toHaveLength(32)
    // The bug this guards is the one kickers had: events present, total zero.
    expect(defenses.every((defense) => defense.projectedPpg > 0)).toBe(true)
  })

  it('separates good defences from bad ones', () => {
    const defenses = loaded.players
      .filter((player) => player.position === 'DEF')
      .sort((a, b) => b.projectedSeason - a.projectedSeason)

    const best = defenses[0]?.projectedPpg ?? 0
    const worst = defenses[defenses.length - 1]?.projectedPpg ?? 0
    // A flat ranking would mean the scoring never ran; an enormous spread would
    // mean defences are not being regressed at all.
    expect(best - worst).toBeGreaterThan(1)
    expect(best - worst).toBeLessThan(8)
  })

  it('does not let a defence outrank a first round running back', () => {
    const ranked = rankPool(loaded, DEFAULT_SHAPE)
    const firstDefense = ranked.findIndex((player) => player.position === 'DEF')
    // Defences are worth roughly a late pick. Anything near the top of the
    // board means replacement level is being computed against the wrong set.
    expect(firstDefense).toBeGreaterThan(24)
  })
})
