import { describe, expect, it } from 'vitest'
import { ArkAgent, ProjectionAgent, RandomAgent, SetAndForgetAgent, StreamerAgent } from './agents.js'
import { runSeason } from './season.js'
import { runSimulation } from './run.js'
import { buildPlayerPool, drawScore, gamma, makeRng } from './world.js'

/**
 * The simulation is a test of the shipped analytics, so it needs testing
 * itself: a rigged world would make any recommendation look good.
 *
 * The season count here is kept low enough to run in CI. The headline numbers
 * quoted in the README come from much longer runs; these assertions are the
 * ones that still hold at this sample size.
 */

describe('world', () => {
  it('generates right-skewed scores with the requested mean', () => {
    const rng = makeRng(11)
    const samples = Array.from({ length: 20_000 }, () => gamma(rng, 4, 3))
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length

    expect(mean).toBeCloseTo(12, 0)
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)

    // Right-skewed: the median sits below the mean.
    const sorted = [...samples].sort((a, b) => a - b)
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(mean)
  })

  it('never produces a negative score', () => {
    const rng = makeRng(3)
    const pool = buildPlayerPool(rng)
    for (const player of pool.slice(0, 60)) {
      for (let i = 0; i < 25; i += 1) expect(drawScore(rng, player)).toBeGreaterThanOrEqual(0)
    }
  })

  it('builds a pool with a real talent curve at every position', () => {
    const pool = buildPlayerPool(makeRng(5))
    for (const position of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
      const group = pool.filter((p) => p.position === position)
      expect(group.length).toBeGreaterThan(20)
      const means = group.map((p) => p.trueMean)
      expect(Math.max(...means)).toBeGreaterThan(Math.min(...means) * 1.5)
    }
  })

  it('gives players volatility that does not match Ark\'s own priors', () => {
    // The point of the harness is that Ark's assumptions are approximately, not
    // exactly, right. If these ever coincide the result proves much less.
    const pool = buildPlayerPool(makeRng(9))
    const averageCv = (position: string) => {
      const group = pool.filter((p) => p.position === position)
      return group.reduce((sum, p) => sum + p.trueCv, 0) / group.length
    }

    // Ark assumes RB 0.55 and TE 0.68; the world does not agree.
    expect(Math.abs(averageCv('RB') - 0.55)).toBeGreaterThan(0.02)
    expect(Math.abs(averageCv('TE') - 0.68)).toBeGreaterThan(0.02)
  })
})

/** Agents hold state across a season, so each run needs its own set. */
function freshAgents() {
  return [
    new ArkAgent(), new ArkAgent(), new ArkAgent(),
    new ProjectionAgent(), new ProjectionAgent(), new ProjectionAgent(),
    new StreamerAgent(), new StreamerAgent(),
    new SetAndForgetAgent(), new SetAndForgetAgent(),
    new RandomAgent(), new RandomAgent(),
  ]
}

describe('a single season', () => {
  const results = runSeason({ seed: 4242, agents: freshAgents() })

  it('plays a complete season for every team', () => {
    expect(results).toHaveLength(12)
    for (const team of results) {
      expect(team.wins + team.losses).toBe(14)
      expect(team.pointsFor).toBeGreaterThan(0)
    }
  })

  it('crowns exactly one champion, from inside the playoff field', () => {
    const champions = results.filter((team) => team.wonTitle)
    expect(champions).toHaveLength(1)
    expect(champions[0]!.madePlayoffs).toBe(true)
  })

  it('sends exactly six teams to the playoffs, seeded 1 to 12', () => {
    expect(results.filter((team) => team.madePlayoffs)).toHaveLength(6)
    expect([...results.map((t) => t.seed)].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
  })

  it('does not systematically favour any draft seat', () => {
    // Any one season varies, because the draft is made on noisy projections
    // and some teams luck into better players than their picks implied. What
    // must hold is that no *seat* is advantaged, since that is what seat
    // rotation across seasons relies on to make the comparison fair.
    const bySeat = new Map<string, number[]>()
    for (let season = 0; season < 40; season += 1) {
      for (const team of runSeason({ seed: 500 + season * 7919, agents: freshAgents() })) {
        const seat = bySeat.get(team.teamId) ?? []
        seat.push(team.draftedTalent)
        bySeat.set(team.teamId, seat)
      }
    }

    const averages = [...bySeat.values()].map(
      (values) => values.reduce((a, b) => a + b, 0) / values.length,
    )
    const spread = (Math.max(...averages) - Math.min(...averages)) / Math.max(...averages)
    expect(spread).toBeLessThan(0.06)
  })

  it('is deterministic for a given seed', () => {
    const repeat = runSeason({ seed: 4242, agents: freshAgents() })
    expect(repeat.map((t) => t.pointsFor)).toEqual(results.map((t) => t.pointsFor))
  })

  it('leaves the fewest points on the bench for the agents that manage', () => {
    const waste = (name: string) => {
      const teams = results.filter((team) => team.agentName === name)
      return teams.reduce((sum, team) => sum + team.pointsLeftOnBench, 0) / teams.length
    }
    expect(waste('Ark')).toBeLessThan(waste('Random'))
    expect(waste('Ark')).toBeLessThan(waste('Set & forget'))
  })
})

describe('across many seasons', () => {
  // Enough to be meaningful, small enough for CI.
  const summary = runSimulation(120, 99)
  const rate = (name: string, field: 'titles' | 'playoffs') => {
    const record = summary.strategies.find((s) => s.name === name)!
    return record[field] / record.seasons
  }
  const talentDrift = (name: string) => {
    const record = summary.strategies.find((s) => s.name === name)!
    return (record.endingTalent - record.draftedTalent) / record.seasons
  }

  it('has every strategy manage the same number of seasons per team', () => {
    for (const strategy of summary.strategies) {
      expect(strategy.seasons % 120).toBe(0)
    }
  })

  it('ranks the strategies in the order their sophistication implies', () => {
    expect(rate('Ark', 'playoffs')).toBeGreaterThan(rate('Projection', 'playoffs'))
    expect(rate('Projection', 'playoffs')).toBeGreaterThan(rate('Random', 'playoffs'))
    expect(rate('Ark', 'titles')).toBeGreaterThan(rate('Random', 'titles'))
  })

  it('beats the 1-in-12 baseline a coin flip would give', () => {
    expect(rate('Ark', 'titles')).toBeGreaterThan(1 / 12)
    expect(rate('Ark', 'playoffs')).toBeGreaterThan(0.5)
  })

  it('does not let the roster decay over the season', () => {
    // The regression this guards: valuing add/drop decisions on a single week's
    // projection selects for lucky noise, and cost about 13 points of true
    // roster talent per season before roster decisions were separated from
    // lineup decisions.
    expect(talentDrift('Ark')).toBeGreaterThan(-3)
  })

  it('keeps the do-nothing strategies where they belong', () => {
    expect(rate('Random', 'titles')).toBeLessThan(rate('Ark', 'titles'))
    expect(rate('Set & forget', 'playoffs')).toBeLessThan(rate('Ark', 'playoffs'))
  })
})
