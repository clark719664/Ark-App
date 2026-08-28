import { describe, expect, it } from 'vitest'
import type { LeagueSnapshot, Matchup, Team } from '../../shared/types.js'
import { buildDemoSnapshot, roundRobin } from '../providers/demo.js'
import {
  buildWeeklyScores, computeAnalytics, computeLuck, computePlayoffOdds,
  computePowerRankings, computeScheduleStrength, simulateBracket,
} from './index.js'
import { mean, scaleToPercent, scaleToPercentInverted, stdDev } from './stats.js'

function team(id: string, wins: number, losses: number, pf = 0, pa = 0): Team {
  return { id, name: `Team ${id}`, record: { wins, losses, ties: 0 }, pointsFor: pf, pointsAgainst: pa }
}

function matchup(week: number, homeId: string, homeScore: number, awayId: string, awayScore: number): Matchup {
  return {
    week,
    home: { teamId: homeId, score: homeScore },
    away: { teamId: awayId, score: awayScore },
    winnerTeamId: homeScore === awayScore ? null : homeScore > awayScore ? homeId : awayId,
    final: true,
  }
}

function snapshotOf(teams: Team[], matchups: Matchup[], overrides: Partial<LeagueSnapshot['league']> = {}): LeagueSnapshot {
  return {
    league: {
      id: 'test', provider: 'demo', name: 'Test', season: 2026, numTeams: teams.length,
      currentWeek: Math.max(1, ...matchups.map((m) => m.week)),
      regularSeasonWeeks: Math.max(1, ...matchups.map((m) => m.week)),
      playoffTeams: 4, ...overrides,
    },
    teams, matchups, rosters: {}, players: [], draft: [],
    fetchedAt: new Date().toISOString(), warnings: [],
  }
}

describe('stats', () => {
  it('computes mean and sample standard deviation', () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(stdDev([2, 4, 6])).toBeCloseTo(2, 10)
  })

  it('returns 0 standard deviation for fewer than two observations', () => {
    expect(stdDev([5])).toBe(0)
    expect(stdDev([])).toBe(0)
  })

  it('scales to 0-100 and maps a flat league to 50', () => {
    expect(scaleToPercent([10, 20, 30])).toEqual([0, 50, 100])
    expect(scaleToPercent([7, 7, 7])).toEqual([50, 50, 50])
  })

  it('inverts scaling so the lowest value scores highest', () => {
    expect(scaleToPercentInverted([10, 20, 30])).toEqual([100, 50, 0])
  })
})

describe('roundRobin', () => {
  it('pairs every team exactly once per week with no self-matchups', () => {
    const schedule = roundRobin(12, 11)
    expect(schedule).toHaveLength(11)
    for (const week of schedule) {
      expect(week).toHaveLength(6)
      const seen = new Set<number>()
      for (const [home, away] of week) {
        expect(home).not.toBe(away)
        expect(seen.has(home)).toBe(false)
        expect(seen.has(away)).toBe(false)
        seen.add(home)
        seen.add(away)
      }
      expect(seen.size).toBe(12)
    }
  })

  it('gives every team a distinct opponent each week over a full rotation', () => {
    const schedule = roundRobin(12, 11)
    const opponents = new Map<number, Set<number>>()
    for (const week of schedule) {
      for (const [home, away] of week) {
        if (!opponents.has(home)) opponents.set(home, new Set())
        if (!opponents.has(away)) opponents.set(away, new Set())
        opponents.get(home)!.add(away)
        opponents.get(away)!.add(home)
      }
    }
    // 11 weeks, 12 teams: everyone should see all 11 opponents exactly once.
    for (const faced of opponents.values()) expect(faced.size).toBe(11)
  })
})

describe('buildWeeklyScores', () => {
  it('emits one row per team per completed week and ignores unplayed weeks', () => {
    const teams = [team('1', 1, 0), team('2', 0, 1)]
    const played = matchup(1, '1', 100, '2', 90)
    const unplayed: Matchup = {
      week: 2, home: { teamId: '1', score: 0 }, away: { teamId: '2', score: 0 },
      winnerTeamId: null, final: false,
    }
    const rows = buildWeeklyScores(snapshotOf(teams, [played, unplayed]))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.week === 1)).toBe(true)
    expect(rows.find((r) => r.teamId === '1')?.won).toBe(true)
    expect(rows.find((r) => r.teamId === '2')?.won).toBe(false)
  })
})

describe('computeLuck', () => {
  it('flags a team that wins despite scoring near the bottom as lucky', () => {
    // Team 1 scores the 3rd-best of 4 every week but wins every week.
    const teams = [team('1', 2, 0), team('2', 0, 2), team('3', 2, 0), team('4', 0, 2)]
    const matchups = [
      matchup(1, '1', 90, '2', 80), matchup(1, '3', 120, '4', 110),
      matchup(2, '1', 90, '2', 80), matchup(2, '3', 120, '4', 110),
    ]
    const luck = computeLuck(snapshotOf(teams, matchups))
    const t1 = luck.find((l) => l.teamId === '1')!

    // Beats team 2 only: 1 of 3 all-play games each week.
    expect(t1.allPlay).toEqual({ wins: 2, losses: 4, ties: 0 })
    expect(t1.expectedWinPct).toBeCloseTo(1 / 3, 4)
    expect(t1.actualWinPct).toBe(1)
    expect(t1.luckWins).toBeGreaterThan(1)
  })

  it('flags a high scorer with a bad record as unlucky', () => {
    const teams = [team('1', 0, 2), team('2', 2, 0), team('3', 1, 1), team('4', 1, 1)]
    const matchups = [
      matchup(1, '1', 130, '2', 140), matchup(1, '3', 90, '4', 80),
      matchup(2, '1', 130, '2', 140), matchup(2, '3', 90, '4', 80),
    ]
    const t1 = computeLuck(snapshotOf(teams, matchups)).find((l) => l.teamId === '1')!
    expect(t1.expectedWinPct).toBeGreaterThan(t1.actualWinPct)
    expect(t1.luckWins).toBeLessThan(0)
  })

  it('gives every team a zero luck rating in a perfectly matched league', () => {
    // Everyone scores identically, so all-play and actual both sit at .500.
    const teams = [team('1', 1, 1), team('2', 1, 1)]
    const matchups = [matchup(1, '1', 100, '2', 90), matchup(2, '1', 90, '2', 100)]
    const luck = computeLuck(snapshotOf(teams, matchups))
    for (const rating of luck) expect(rating.luckWins).toBeCloseTo(0, 6)
  })
})

describe('computePowerRankings', () => {
  it('assigns each team a unique rank from 1..n ordered by score', () => {
    const snapshot = buildDemoSnapshot()
    const rankings = computePowerRankings(snapshot)
    expect(rankings).toHaveLength(snapshot.teams.length)
    expect(rankings.map((r) => r.rank)).toEqual(
      Array.from({ length: snapshot.teams.length }, (_, i) => i + 1),
    )
    for (let i = 1; i < rankings.length; i += 1) {
      expect(rankings[i - 1]!.score).toBeGreaterThanOrEqual(rankings[i]!.score)
    }
  })

  it('ranks the highest-scoring team first when records are equal', () => {
    const teams = [team('1', 1, 1, 300), team('2', 1, 1, 200)]
    const matchups = [matchup(1, '1', 150, '2', 100), matchup(2, '2', 100, '1', 150)]
    const rankings = computePowerRankings(snapshotOf(teams, matchups))
    expect(rankings[0]!.teamId).toBe('1')
  })

  it('keeps every component within 0-100', () => {
    for (const entry of computePowerRankings(buildDemoSnapshot())) {
      for (const value of Object.values(entry.components)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(100)
      }
      expect(entry.score).toBeGreaterThanOrEqual(0)
      expect(entry.score).toBeLessThanOrEqual(100)
    }
  })
})

describe('computeScheduleStrength', () => {
  it('ranks the team facing the strongest remaining opponents first', () => {
    const teams = [team('1', 0, 0), team('2', 0, 0), team('3', 0, 0), team('4', 0, 0)]
    const played = [
      matchup(1, '1', 100, '2', 100), matchup(1, '3', 150, '4', 50),
    ]
    // Week 2 unplayed: team 1 draws the 150-point team, team 2 draws the 50.
    const upcoming: Matchup[] = [
      { week: 2, home: { teamId: '1', score: 0 }, away: { teamId: '3', score: 0 }, winnerTeamId: null, final: false },
      { week: 2, home: { teamId: '2', score: 0 }, away: { teamId: '4', score: 0 }, winnerTeamId: null, final: false },
    ]
    const strength = computeScheduleStrength(snapshotOf(teams, [...played, ...upcoming]))
    const t1 = strength.find((s) => s.teamId === '1')!
    const t2 = strength.find((s) => s.teamId === '2')!
    expect(t1.futureOpponentAvg).toBe(150)
    expect(t2.futureOpponentAvg).toBe(50)
    expect(t1.futureRank).toBeLessThan(t2.futureRank)
  })
})

describe('computePlayoffOdds', () => {
  const snapshot = buildDemoSnapshot()
  const { odds, simulations } = computePlayoffOdds(snapshot, { simulations: 4000 })

  it('produces probabilities that total the number of playoff spots', () => {
    const total = odds.reduce((sum, o) => sum + o.makePlayoffs, 0)
    expect(total).toBeCloseTo(snapshot.league.playoffTeams, 1)
  })

  it('produces exactly one champion and one top seed per simulation', () => {
    expect(odds.reduce((sum, o) => sum + o.winTitle, 0)).toBeCloseTo(1, 1)
    expect(odds.reduce((sum, o) => sum + o.topSeed, 0)).toBeCloseTo(1, 1)
  })

  it('keeps every probability inside [0, 1]', () => {
    for (const entry of odds) {
      for (const value of [entry.makePlayoffs, entry.topSeed, entry.winTitle]) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
      expect(entry.winTitle).toBeLessThanOrEqual(entry.makePlayoffs + 1e-9)
    }
  })

  it('never projects more wins than there are games', () => {
    const games = snapshot.league.regularSeasonWeeks
    for (const entry of odds) {
      expect(entry.projectedWins).toBeGreaterThanOrEqual(0)
      expect(entry.projectedWins).toBeLessThanOrEqual(games)
    }
  })

  it('gives the best team better odds than the worst', () => {
    const best = [...snapshot.teams].sort((a, b) => b.pointsFor - a.pointsFor)[0]!
    const worst = [...snapshot.teams].sort((a, b) => a.pointsFor - b.pointsFor)[0]!
    const bestOdds = odds.find((o) => o.teamId === best.id)!
    const worstOdds = odds.find((o) => o.teamId === worst.id)!
    expect(bestOdds.makePlayoffs).toBeGreaterThan(worstOdds.makePlayoffs)
  })

  it('is deterministic for a given seed', () => {
    const a = computePlayoffOdds(snapshot, { simulations: 500, seed: 42 }).odds
    const b = computePlayoffOdds(snapshot, { simulations: 500, seed: 42 }).odds
    expect(a).toEqual(b)
    expect(simulations).toBe(4000)
  })

  it('locks in a clinched team at 100% and an eliminated one at 0%', () => {
    // Two teams, one game left, top-1 makes the playoffs, and team 1 is already
    // two wins clear with only one game to play.
    const teams = [team('1', 3, 0, 400), team('2', 0, 3, 100)]
    const matchups: Matchup[] = [
      matchup(1, '1', 130, '2', 30), matchup(2, '1', 140, '2', 40), matchup(3, '1', 130, '2', 30),
      { week: 4, home: { teamId: '1', score: 0 }, away: { teamId: '2', score: 0 }, winnerTeamId: null, final: false },
    ]
    const result = computePlayoffOdds(
      snapshotOf(teams, matchups, { playoffTeams: 1, regularSeasonWeeks: 4 }),
      { simulations: 2000 },
    )
    expect(result.odds.find((o) => o.teamId === '1')!.makePlayoffs).toBe(1)
    expect(result.odds.find((o) => o.teamId === '2')!.makePlayoffs).toBe(0)
  })
})

describe('simulateBracket', () => {
  const models = new Map(
    ['1', '2', '3', '4', '5', '6'].map((id) => [
      id,
      { id, mu: 100, sigma: 10, wins: 0, losses: 0, ties: 0, pointsFor: 0 },
    ]),
  )

  it('returns a champion drawn from the field', () => {
    const rng = () => 0.5
    const champion = simulateBracket(['1', '2', '3', '4', '5', '6'], models, rng)
    expect(['1', '2', '3', '4', '5', '6']).toContain(champion)
  })

  it('handles a single-team field and an empty field', () => {
    expect(simulateBracket(['7'], models, () => 0.5)).toBe('7')
    expect(simulateBracket([], models, () => 0.5)).toBeUndefined()
  })

  it('crowns the only plausible winner when one team dominates', () => {
    const lopsided = new Map(models)
    lopsided.set('1', { id: '1', mu: 500, sigma: 1, wins: 0, losses: 0, ties: 0, pointsFor: 0 })
    const rng = makeCycler([0.1, 0.9, 0.4, 0.6])
    expect(simulateBracket(['1', '2', '3', '4'], lopsided, rng)).toBe('1')
  })
})

function makeCycler(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

describe('computeAnalytics', () => {
  it('returns a complete result for every team in the league', () => {
    const snapshot = buildDemoSnapshot()
    const analytics = computeAnalytics(snapshot, { simulations: 1000 })
    const teamCount = snapshot.teams.length
    expect(analytics.powerRankings).toHaveLength(teamCount)
    expect(analytics.luck).toHaveLength(teamCount)
    expect(analytics.scheduleStrength).toHaveLength(teamCount)
    expect(analytics.playoffOdds).toHaveLength(teamCount)
    expect(analytics.weeklyScores.length).toBeGreaterThan(0)
    expect(analytics.simulations).toBe(1000)
  })

  it('survives a league with no completed games', () => {
    const teams = [team('1', 0, 0), team('2', 0, 0)]
    const upcoming: Matchup = {
      week: 1, home: { teamId: '1', score: 0 }, away: { teamId: '2', score: 0 },
      winnerTeamId: null, final: false,
    }
    const analytics = computeAnalytics(snapshotOf(teams, [upcoming], { playoffTeams: 1 }), {
      simulations: 200,
    })
    expect(analytics.powerRankings).toHaveLength(2)
    expect(analytics.luck.every((l) => l.luckWins === 0)).toBe(true)
    expect(analytics.playoffOdds.reduce((s, o) => s + o.makePlayoffs, 0)).toBeCloseTo(1, 1)
  })
})
