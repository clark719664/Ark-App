import { describe, expect, it } from 'vitest'
import type { Player, RosterEntry } from '../../shared/types.js'
import { analyseLineupRisk, lineupDistribution, playerSpread, playerVolatility } from './risk.js'
import { normalCdf, probabilityOfWinning } from './stats.js'

function player(id: string, position: Player['position'], projected: number, extra: Partial<Player> = {}): Player {
  return { id, name: id, position, nflTeam: 'KC', ownerTeamId: 'me', points: { projected }, ...extra }
}
function entry(slot: string, starter: boolean, p: Player): RosterEntry {
  return { slot, starter, player: p }
}

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DEF', 'W/R/T']

/** A normal lineup, with the flex decision left open between two candidates. */
function roster(flexStarter: Player, benchAlternative: Player): RosterEntry[] {
  return [
    entry('QB', true, player('QB1', 'QB', 22)),
    entry('RB', true, player('RB1', 'RB', 16)),
    entry('RB', true, player('RB2', 'RB', 15)),
    entry('WR', true, player('WR1', 'WR', 15)),
    entry('WR', true, player('WR2', 'WR', 12)),
    entry('TE', true, player('TE1', 'TE', 15)),
    entry('K', true, player('K1', 'K', 8)),
    entry('DEF', true, player('DEF1', 'DEF', 8)),
    entry('W/R/T', true, flexStarter),
    entry('BN', false, benchAlternative),
  ]
}

const flexOf = (assignments: Array<{ slot: string; player: Player | null }>) =>
  assignments.find((a) => a.slot === 'W/R/T')?.player?.id

describe('normalCdf', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1)).toBeCloseTo(0.8413, 4)
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 4)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3)
  })

  it('is symmetric about zero', () => {
    for (const z of [0.25, 0.9, 2.4]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6)
    }
  })

  it('saturates without going out of bounds', () => {
    expect(normalCdf(9)).toBeLessThanOrEqual(1)
    expect(normalCdf(-9)).toBeGreaterThanOrEqual(0)
  })
})

describe('probabilityOfWinning', () => {
  it('is a coin flip between identical teams', () => {
    expect(probabilityOfWinning(110, 400, 110, 400)).toBeCloseTo(0.5, 6)
  })

  it('is complementary from both sides', () => {
    const a = probabilityOfWinning(120, 400, 100, 500)
    const b = probabilityOfWinning(100, 500, 120, 400)
    expect(a + b).toBeCloseTo(1, 6)
  })

  it('helps the underdog to add variance', () => {
    // 20 points behind: a wider range of outcomes is the only path to a win.
    const tight = probabilityOfWinning(100, 200, 120, 400)
    const wild = probabilityOfWinning(100, 900, 120, 400)
    expect(wild).toBeGreaterThan(tight)
  })

  it('hurts the favourite to add variance', () => {
    const tight = probabilityOfWinning(120, 200, 100, 400)
    const wild = probabilityOfWinning(120, 900, 100, 400)
    expect(wild).toBeLessThan(tight)
  })

  it('leaves variance irrelevant when the teams are level', () => {
    expect(probabilityOfWinning(110, 100, 110, 400)).toBeCloseTo(0.5, 6)
    expect(probabilityOfWinning(110, 900, 110, 400)).toBeCloseTo(0.5, 6)
  })

  it('handles a zero-variance matchup without dividing by zero', () => {
    expect(probabilityOfWinning(110, 0, 100, 0)).toBe(1)
    expect(probabilityOfWinning(100, 0, 110, 0)).toBe(0)
    expect(probabilityOfWinning(100, 0, 100, 0)).toBe(0.5)
  })
})

describe('player volatility', () => {
  it('ranks positions from steadiest to boomiest', () => {
    expect(playerVolatility('QB')).toBeLessThan(playerVolatility('RB'))
    expect(playerVolatility('RB')).toBeLessThan(playerVolatility('WR'))
    expect(playerVolatility('WR')).toBeLessThan(playerVolatility('TE'))
    expect(playerVolatility('TE')).toBeLessThan(playerVolatility('DEF'))
  })

  it('scales spread with projection but never reports certainty', () => {
    expect(playerSpread(player('a', 'RB', 20), 20)).toBeCloseTo(11, 5)
    expect(playerSpread(player('a', 'RB', 0), 0)).toBeGreaterThan(0)
  })

  it('adds player variances, not standard deviations', () => {
    const distribution = lineupDistribution([
      { player: player('a', 'QB', 20), projection: 20 },
      { player: player('b', 'QB', 20), projection: 20 },
    ])
    const one = playerSpread(player('a', 'QB', 20), 20)
    expect(distribution.mean).toBe(40)
    expect(distribution.variance).toBeCloseTo(2 * one ** 2, 5)
    // Two players are less than twice as volatile as one.
    expect(distribution.spread).toBeLessThan(2 * one)
  })
})

describe('analyseLineupRisk', () => {
  const steady = player('steady', 'RB', 14)
  const volatile = player('volatile', 'TE', 14)

  it('takes the boom-or-bust player when a big underdog and projections are level', () => {
    const analysis = analyseLineupRisk(roster(steady, volatile), SLOTS, { mean: 150, spread: 24 })

    expect(analysis.posture).toBe('underdog')
    expect(flexOf(analysis.byPoints.assignments)).toBe('steady')
    expect(flexOf(analysis.byWinProbability.assignments)).toBe('volatile')
    expect(analysis.differ).toBe(true)
    expect(analysis.winProbabilityGain).toBeGreaterThan(0)
    expect(analysis.moves[0]?.reason).toMatch(/outlier/i)
  })

  it('gives up projected points for a steadier week when heavily favoured', () => {
    // The volatile player projects higher, so points-max starts him.
    const analysis = analyseLineupRisk(
      roster(player('volatile', 'TE', 14.5), player('steady', 'RB', 14)),
      SLOTS,
      { mean: 75, spread: 24 },
    )

    expect(analysis.posture).toBe('favourite')
    expect(flexOf(analysis.byPoints.assignments)).toBe('volatile')
    expect(flexOf(analysis.byWinProbability.assignments)).toBe('steady')
    expect(analysis.pointsGivenUp).toBeGreaterThan(0)
    expect(analysis.moves[0]?.reason).toMatch(/steadier/i)
  })

  it('refuses to trade real points for a marginal variance edge', () => {
    // Two points is too much to give up chasing a slightly wider range.
    const analysis = analyseLineupRisk(
      roster(steady, player('volatile', 'TE', 12)),
      SLOTS,
      { mean: 150, spread: 24 },
    )
    expect(analysis.differ).toBe(false)
    expect(flexOf(analysis.byWinProbability.assignments)).toBe('steady')
  })

  it('leaves an even matchup on the points-optimal lineup', () => {
    const analysis = analyseLineupRisk(roster(steady, volatile), SLOTS, { mean: 121.2, spread: 24 })
    expect(analysis.posture).toBe('even')
    expect(analysis.winProbabilityGain).toBeLessThan(0.5)
  })

  it('never recommends a lineup that is worse than the points-optimal one', () => {
    for (const opponentMean of [60, 80, 100, 115, 130, 160]) {
      const analysis = analyseLineupRisk(roster(steady, volatile), SLOTS, {
        mean: opponentMean,
        spread: 24,
      })
      expect(analysis.byWinProbability.winProbability).toBeGreaterThanOrEqual(
        analysis.byPoints.winProbability - 1e-9,
      )
    }
  })

  it('never starts a player who is on bye or ruled out', () => {
    const injured = player('hurt', 'RB', 30, { injury: { code: 'O', label: 'Out' } })
    const onBye = player('bye', 'TE', 28, { byeWeek: 7 })
    const analysis = analyseLineupRisk(
      [...roster(steady, volatile), entry('BN', false, injured), entry('BN', false, onBye)],
      SLOTS,
      { mean: 150, spread: 24 },
      7,
    )

    const started = analysis.byWinProbability.assignments.map((a) => a.player?.id)
    expect(started).not.toContain('hurt')
    expect(started).not.toContain('bye')
  })

  it('keeps win probability inside [0, 1]', () => {
    for (const opponentMean of [10, 300]) {
      const analysis = analyseLineupRisk(roster(steady, volatile), SLOTS, {
        mean: opponentMean,
        spread: 24,
      })
      expect(analysis.byWinProbability.winProbability).toBeGreaterThanOrEqual(0)
      expect(analysis.byWinProbability.winProbability).toBeLessThanOrEqual(1)
    }
  })

  it('handles a roster too thin to fill the lineup', () => {
    const analysis = analyseLineupRisk(
      [entry('QB', true, player('only', 'QB', 20))],
      SLOTS,
      { mean: 100, spread: 24 },
    )
    expect(analysis.byPoints.mean).toBe(20)
    expect(analysis.byWinProbability.winProbability).toBeGreaterThanOrEqual(0)
  })
})
