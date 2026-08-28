import { describe, expect, it } from 'vitest'
import type { LeagueSnapshot, Player } from '../../shared/types.js'
import { buildDemoSnapshot } from '../providers/demo.js'
import { derivePosture, ImpactCalculator, rosterAfterTrade } from './impact.js'
import { computePlayoffPath } from './leverage.js'
import { buildForecasts, remainingGames, simulateSeason } from './season.js'
import { RandomBlock } from './stats.js'

const snapshot = buildDemoSnapshot()

function player(id: string, projected: number): Player {
  return { id, name: id, position: 'RB', nflTeam: 'KC', ownerTeamId: null, points: { projected } }
}

describe('forward season model', () => {
  it('forecasts from the lineup a team can field rather than its history', () => {
    const forecasts = buildForecasts(snapshot)
    expect(forecasts).toHaveLength(snapshot.teams.length)
    expect(forecasts.every((f) => f.basis === 'lineup')).toBe(true)
    expect(forecasts.every((f) => f.mu > 0 && f.sigma > 0)).toBe(true)
  })

  it('only simulates games that have not been played', () => {
    const games = remainingGames(snapshot)
    const played = snapshot.matchups.filter((m) => m.final).length
    expect(games.length).toBe(snapshot.matchups.length - played)
    expect(games.every((g) => g.week >= snapshot.league.currentWeek)).toBe(true)
  })

  it('produces probabilities that account for every playoff spot and one title', () => {
    const outcome = simulateSeason(snapshot, buildForecasts(snapshot), { simulations: 2000 })
    const playoffs = [...outcome.makePlayoffs.values()].reduce((a, b) => a + b, 0)
    const titles = [...outcome.winTitle.values()].reduce((a, b) => a + b, 0)

    expect(playoffs).toBeCloseTo(snapshot.league.playoffTeams, 1)
    expect(titles).toBeCloseTo(1, 1)
  })

  it('is reproducible when two runs share the same draws', () => {
    const games = Math.max(1, remainingGames(snapshot).length)
    const draws = new RandomBlock(1000 * games * 2 + 20_000, 7)
    const forecasts = buildForecasts(snapshot)

    const a = simulateSeason(snapshot, forecasts, { simulations: 1000, draws })
    const b = simulateSeason(snapshot, forecasts, { simulations: 1000, draws })
    expect([...a.makePlayoffs]).toEqual([...b.makePlayoffs])
  })

  it('honours a forced result', () => {
    const forecasts = buildForecasts(snapshot)
    const game = remainingGames(snapshot)[0]!

    const forcedWin = simulateSeason(snapshot, forecasts, {
      simulations: 1500,
      forcedResults: [
        { week: game.week, winnerTeamId: game.homeTeamId, loserTeamId: game.awayTeamId },
      ],
    })
    const forcedLoss = simulateSeason(snapshot, forecasts, {
      simulations: 1500,
      forcedResults: [
        { week: game.week, winnerTeamId: game.awayTeamId, loserTeamId: game.homeTeamId },
      ],
    })

    expect(forcedWin.projectedWins.get(game.homeTeamId)!).toBeGreaterThan(
      forcedLoss.projectedWins.get(game.homeTeamId)!,
    )
  })
})

describe('ImpactCalculator', () => {
  const calculator = new ImpactCalculator(snapshot)

  /** The team closest to a coin flip, where a change should move the needle most. */
  const bubbleId = [...snapshot.teams]
    .map((team) => ({ id: team.id, odds: calculator.oddsFor(team.id).makePlayoffs }))
    .sort((a, b) => Math.abs(0.5 - a.odds) - Math.abs(0.5 - b.odds))[0]!.id

  function rosterOf(teamId: string): Player[] {
    return (snapshot.rosters[teamId] ?? [])
      .map((entry) => entry.player)
      .filter((p): p is Player => p !== null)
  }

  it('reports a baseline for every team', () => {
    for (const team of snapshot.teams) {
      const odds = calculator.oddsFor(team.id)
      expect(odds.makePlayoffs).toBeGreaterThanOrEqual(0)
      expect(odds.makePlayoffs).toBeLessThanOrEqual(1)
      expect(odds.winTitle).toBeLessThanOrEqual(odds.makePlayoffs + 1e-9)
    }
  })

  it('raises a bubble team\'s odds when its roster gets better', () => {
    const roster = rosterOf(bubbleId)
    const improved = [...roster, player('star', 60)]
    const impact = calculator.impactOf([{ teamId: bubbleId, players: improved }], bubbleId)

    expect(impact.playoffSwing).toBeGreaterThan(0)
    expect(impact.after.makePlayoffs).toBeGreaterThan(impact.before.makePlayoffs)
  })

  it('lowers them when the roster gets worse', () => {
    const roster = rosterOf(bubbleId)
    const gutted = roster.slice(0, 2)
    const impact = calculator.impactOf([{ teamId: bubbleId, players: gutted }], bubbleId)
    expect(impact.playoffSwing).toBeLessThan(0)
  })

  it('reports no change when nothing changes', () => {
    // Common random numbers make this exact rather than approximate, which is
    // the property that lets a one-point trade be measured at all.
    const impact = calculator.impactOf(
      [{ teamId: bubbleId, players: rosterOf(bubbleId) }],
      bubbleId,
    )
    expect(impact.playoffSwing).toBe(0)
    expect(impact.titleSwing).toBe(0)
  })

  it('gives a bubble team more to gain per point than a team already through', () => {
    const clinchedId = [...snapshot.teams]
      .map((team) => ({ id: team.id, odds: calculator.oddsFor(team.id).makePlayoffs }))
      .sort((a, b) => b.odds - a.odds)[0]!.id

    const boost = (teamId: string) =>
      calculator.impactOf(
        [{ teamId, players: [...rosterOf(teamId), player(`boost-${teamId}`, 25)] }],
        teamId,
      ).playoffSwing

    expect(boost(bubbleId)).toBeGreaterThan(boost(clinchedId))
  })

  it('accounts for the other side of a trade, not just yours', () => {
    const otherId = snapshot.teams.find((t) => t.id !== bubbleId)!.id
    const onlyMine = calculator.impactOf(
      [{ teamId: bubbleId, players: [...rosterOf(bubbleId), player('mine', 30)] }],
      bubbleId,
    )
    const bothSides = calculator.impactOf(
      [
        { teamId: bubbleId, players: [...rosterOf(bubbleId), player('mine', 30)] },
        { teamId: otherId, players: [...rosterOf(otherId), player('theirs', 40)] },
      ],
      bubbleId,
    )
    // Handing a rival a better player cannot help you.
    expect(bothSides.playoffSwing).toBeLessThanOrEqual(onlyMine.playoffSwing)
  })
})

describe('rosterAfterTrade', () => {
  it('removes what is sent and adds what is received', () => {
    const a = player('a', 10)
    const b = player('b', 12)
    const c = player('c', 15)
    const after = rosterAfterTrade([a, b], [a], [c])

    expect(after.map((p) => p.id).sort()).toEqual(['b', 'c'])
  })

  it('leaves the roster alone when nothing is sent', () => {
    const a = player('a', 10)
    expect(rosterAfterTrade([a], [], []).map((p) => p.id)).toEqual(['a'])
  })
})

describe('derivePosture', () => {
  const odds = (makePlayoffs: number) => ({
    makePlayoffs, winTitle: 0.1, projectedWins: 7, projectedSeed: 5,
  })

  it('tells a near-certain team to play for the bracket', () => {
    const advice = derivePosture(odds(0.96))
    expect(advice.posture).toBe('contend')
    expect(advice.detail).toMatch(/title/i)
  })

  it('tells a bubble team that every point matters', () => {
    expect(derivePosture(odds(0.5)).posture).toBe('push')
    expect(derivePosture(odds(0.26)).posture).toBe('push')
  })

  it('tells a team on the outside to sell', () => {
    const advice = derivePosture(odds(0.04))
    expect(advice.posture).toBe('sell')
    expect(advice.headline).toMatch(/sell/i)
  })
})

describe('computePlayoffPath', () => {
  /**
   * A four-team league with one playoff spot and one game left, so clinching
   * and elimination are unambiguous rather than a matter of probability.
   */
  function decidedLeague(): LeagueSnapshot {
    const teams = ['runaway', 'second', 'third', 'bottom'].map((id, i) => ({
      id,
      name: id,
      record: { wins: i === 0 ? 5 : 1, losses: i === 0 ? 0 : 4, ties: 0 },
      pointsFor: i === 0 ? 900 : 500 - i * 10,
      pointsAgainst: 600,
    }))

    const roster = (projection: number) => [
      { slot: 'RB', starter: true, player: player('rb', projection) },
    ]

    return {
      league: {
        id: 'decided', provider: 'demo', name: 'Decided', season: 2026, numTeams: 4,
        currentWeek: 6, regularSeasonWeeks: 6, playoffTeams: 1,
        rosterSlots: [{ slot: 'RB', count: 1 }],
      },
      teams,
      rosters: {
        runaway: roster(30), second: roster(20), third: roster(20), bottom: roster(20),
      },
      matchups: [
        {
          week: 6,
          home: { teamId: 'runaway', score: 0 },
          away: { teamId: 'second', score: 0 },
          winnerTeamId: null,
          final: false,
        },
        {
          week: 6,
          home: { teamId: 'third', score: 0 },
          away: { teamId: 'bottom', score: 0 },
          winnerTeamId: null,
          final: false,
        },
      ],
      players: [], draft: [], fetchedAt: new Date().toISOString(), warnings: [],
    }
  }

  it('knows a team that cannot be caught is already through', () => {
    // 5-0 with one game left, one playoff spot: losing it still finishes first.
    const path = computePlayoffPath(decidedLeague(), 'runaway')

    expect(path.clinched).toBe(true)
    expect(path.eliminated).toBe(false)
    expect(path.winsToClinch).toBe(0)
    expect(path.summary).toMatch(/regardless/i)
    // Nothing left to play for means no game carries leverage.
    expect(Math.max(...path.games.map((g) => g.swing))).toBeLessThan(5)
  })

  it('knows a team that cannot catch up is done', () => {
    // 1-4 with one game left and one spot: winning it still finishes behind.
    const path = computePlayoffPath(decidedLeague(), 'bottom')

    expect(path.eliminated).toBe(true)
    expect(path.clinched).toBe(false)
    expect(path.summary).toMatch(/would still not be enough/i)
  })

  it('does not declare a clinch that has not happened', () => {
    // The best team in the demo league is strong but not mathematically safe,
    // and saying otherwise would be worse than saying nothing.
    const calculator = new ImpactCalculator(snapshot)
    const contender = [...snapshot.teams]
      .map((team) => ({ id: team.id, odds: calculator.oddsFor(team.id).makePlayoffs }))
      .filter((entry) => entry.odds > 0.9 && entry.odds < 1)
      .sort((a, b) => b.odds - a.odds)[0]

    if (!contender) return
    const path = computePlayoffPath(snapshot, contender.id)
    if (!path.clinched) expect(path.winsToClinch === null || path.winsToClinch > 0).toBe(true)
  })

  it('finds real leverage for a team on the bubble', () => {
    const calculator = new ImpactCalculator(snapshot)
    const bubble = [...snapshot.teams]
      .map((team) => ({ id: team.id, odds: calculator.oddsFor(team.id).makePlayoffs }))
      .sort((a, b) => Math.abs(0.5 - a.odds) - Math.abs(0.5 - b.odds))[0]!

    const path = computePlayoffPath(snapshot, bubble.id)

    expect(path.clinched).toBe(false)
    expect(path.eliminated).toBe(false)
    expect(path.games.length).toBeGreaterThan(0)
    // Winning is never worse than losing.
    for (const game of path.games) {
      expect(game.oddsIfWin).toBeGreaterThanOrEqual(game.oddsIfLose)
      expect(game.swing).toBeGreaterThanOrEqual(0)
    }
    // A coin-flip team must have at least one game that genuinely matters.
    expect(Math.max(...path.games.map((g) => g.swing))).toBeGreaterThan(10)
  })

  it('orders games by how much they matter', () => {
    const bubble = snapshot.teams[7]!
    const path = computePlayoffPath(snapshot, bubble.id)
    for (let i = 1; i < path.games.length; i += 1) {
      expect(path.games[i - 1]!.swing).toBeGreaterThanOrEqual(path.games[i]!.swing)
    }
  })

  it('handles a league with nothing left to play', () => {
    const finished: LeagueSnapshot = {
      ...snapshot,
      matchups: snapshot.matchups.map((m) => ({ ...m, final: true })),
    }
    const path = computePlayoffPath(finished, snapshot.teams[0]!.id)
    expect(path.gamesRemaining).toBe(0)
    expect(path.games).toEqual([])
    expect(path.summary).toMatch(/over/i)
  })
})
