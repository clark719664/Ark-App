import { describe, expect, it } from 'vitest'
import type { Player } from '../../shared/types.js'
import { bestLineupByRosterValue, rosterValue } from './lineup.js'

/**
 * Roster decisions are a different question from lineup decisions, and this is
 * the number that keeps them apart. Ranking add/drop candidates on a single
 * week's projection selects for whoever got the luckiest reading — in a
 * 600-season simulation that cost about 13 points of true roster talent per
 * season, and reversed a championship lead into a deficit.
 */

function player(id: string, points: Player['points'], position: Player['position'] = 'RB'): Player {
  return { id, name: id, position, nflTeam: 'KC', ownerTeamId: null, points }
}

describe('rosterValue', () => {
  it('falls back to the projection when there is no season form yet', () => {
    expect(rosterValue(player('a', { projected: 14 }))).toBe(14)
  })

  it('falls back to season form when there is no projection', () => {
    expect(rosterValue(player('a', { average: 11, season: 88 }))).toBe(11)
  })

  it('leans on the projection early, when little has been observed', () => {
    // One game played: the projection should still dominate.
    const value = rosterValue(player('a', { projected: 20, average: 4, season: 4 }))
    expect(value).toBeGreaterThan(12)
  })

  it('leans on season form once there is real evidence', () => {
    // Twelve games of 4 points: one optimistic projection should not undo that.
    const value = rosterValue(player('a', { projected: 20, average: 4, season: 48 }))
    expect(value).toBeLessThan(9)
  })

  it('moves monotonically toward the average as evidence accumulates', () => {
    const early = rosterValue(player('a', { projected: 20, average: 5, season: 10 }))
    const later = rosterValue(player('a', { projected: 20, average: 5, season: 50 }))
    expect(later).toBeLessThan(early)
  })

  it('is not fooled by one hot week', () => {
    // The steady producer is worth more than the one spiking on a single
    // projection, which is the case that used to churn rosters downhill.
    const steady = rosterValue(player('steady', { projected: 12, average: 13, season: 130 }))
    const spike = rosterValue(player('spike', { projected: 19, average: 6, season: 60 }))
    expect(steady).toBeGreaterThan(spike)
  })

  it('treats a missing player as worthless rather than throwing', () => {
    expect(rosterValue(null)).toBe(0)
    expect(rosterValue(player('a', undefined))).toBe(0)
  })
})

describe('bestLineupByRosterValue', () => {
  const slots = ['RB', 'RB', 'W/R/T']

  it('fills every slot it can with the most valuable eligible players', () => {
    const players = [
      player('a', { projected: 10, average: 10, season: 100 }),
      player('b', { projected: 8, average: 8, season: 80 }),
      player('c', { projected: 6, average: 6, season: 60 }),
      player('d', { projected: 4, average: 4, season: 40 }),
    ]
    expect(bestLineupByRosterValue(players, slots)).toBeCloseTo(24, 5)
  })

  it('ignores bye weeks and short-term injuries', () => {
    // A player is not worth less to a roster because he is off this Sunday.
    const healthy = player('a', { projected: 12, average: 12, season: 120 })
    const onBye = { ...player('b', { projected: 0, average: 12, season: 120 }), byeWeek: 7 }
    const injured = {
      ...player('c', { projected: 0, average: 12, season: 120 }),
      injury: { code: 'O', label: 'Out' },
    }

    const value = bestLineupByRosterValue([healthy, onBye, injured], slots)
    // All three still count toward what the roster is worth.
    expect(value).toBeGreaterThan(30)
  })

  it('respects slot eligibility', () => {
    const quarterbacks = [
      player('a', { projected: 25, average: 25, season: 250 }, 'QB'),
      player('b', { projected: 24, average: 24, season: 240 }, 'QB'),
    ]
    // No QB slot here, and a quarterback cannot fill a flex.
    expect(bestLineupByRosterValue(quarterbacks, slots)).toBe(0)
  })

  it('returns zero for an empty roster', () => {
    expect(bestLineupByRosterValue([], slots)).toBe(0)
  })
})
