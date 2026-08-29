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

  it('carries a bye week for every player', () => {
    const missing = loaded.players.filter((player) => player.byeWeek == null)
    expect(missing).toHaveLength(0)

    // Thirty-two teams share far fewer bye weeks than there are teams, so a
    // one-to-one spread would mean the derivation is reading something else.
    const weeks = new Set(loaded.players.map((player) => player.byeWeek))
    expect(weeks.size).toBeGreaterThan(3)
    expect(weeks.size).toBeLessThan(15)
  })

  it('gives every player on a team the same bye', () => {
    const byTeam = new Map<string, Set<number | null | undefined>>()
    for (const player of loaded.players) {
      const seen = byTeam.get(player.team) ?? new Set()
      seen.add(player.byeWeek)
      byTeam.set(player.team, seen)
    }
    for (const [team, weeks] of byTeam) {
      expect(weeks.size, team).toBe(1)
    }
  })

  it('does not let a defence outrank a first round running back', () => {
    const ranked = rankPool(loaded, DEFAULT_SHAPE)
    const firstDefense = ranked.findIndex((player) => player.position === 'DEF')
    // Defences are worth roughly a late pick. Anything near the top of the
    // board means replacement level is being computed against the wrong set.
    expect(firstDefense).toBeGreaterThan(24)
  })
})

describe('the shipped projections are sane', () => {
  const loaded = pool as DraftPool

  /**
   * A player can legitimately collapse: losing a job is exactly what the depth
   * chart is read for, and James Conner behind a third overall pick should
   * project like a third-string back. What should not happen is a starter
   * collapsing, because nothing in the model does that to a player who still
   * holds his role - so an unexplained one means the inputs are wrong.
   */
  it('does not collapse a player who still holds his job', () => {
    const established = loaded.players.filter(
      (player) =>
        player.basis === 'production' &&
        player.gamesOfData >= 24 &&
        (player.lastSeasonPpg ?? 0) > 8 &&
        // Null covers a board built with no depth chart at all, where every
        // collapse is unexplained by definition.
        (player.depthRank == null || player.depthRank === 1),
    )
    expect(established.length).toBeGreaterThan(30)

    const collapsed = established.filter(
      (player) => player.projectedPpg < 0.5 * (player.lastSeasonPpg ?? 0),
    )
    expect(
      collapsed.map(
        (player) =>
          `${player.name} ${player.lastSeasonPpg} -> ${player.projectedPpg} (rank ${player.depthRank})`,
      ),
    ).toHaveLength(0)
  })
})
