import { describe, expect, it } from 'vitest'
import {
  buildView,
  matchPlayers,
  normalizeName,
  normalizeTeam,
  positionCliffs,
  remainingNeeds,
  snakePicks,
} from './draftWatch.js'
import type { RankedPlayer } from './draftPool.js'
import type { DraftPick, YahooPlayer } from './yahoo/draftFeed.js'

function player(overrides: Partial<RankedPlayer> & { playerId: string }): RankedPlayer {
  return {
    playerId: overrides.playerId,
    name: overrides.name ?? 'Player',
    position: overrides.position ?? 'RB',
    team: overrides.team ?? 'SF',
    age: null,
    projectedPpg: overrides.projectedPpg ?? 10,
    projectedSeason: 170,
    depthRank: 1,
    seasonsOfData: 3,
    gamesOfData: 40,
    lastSeasonPpg: 10,
    basis: 'production',
    notes: [],
    vorp: overrides.vorp ?? 50,
    positionRank: overrides.positionRank ?? 1,
    overallRank: overrides.overallRank ?? 1,
  } as RankedPlayer
}

describe('name normalisation', () => {
  it('ignores punctuation, case and generational suffixes', () => {
    expect(normalizeName('Marvin Harrison Jr.')).toBe(normalizeName('marvin harrison'))
    expect(normalizeName("Ja'Marr Chase")).toBe(normalizeName('JaMarr Chase'))
    expect(normalizeName('Michael Pittman Jr.')).toBe('michael pittman')
  })

  it('does not collapse genuinely different players', () => {
    expect(normalizeName('Josh Allen')).not.toBe(normalizeName('Keenan Allen'))
  })

  it('reconciles the team codes the two sources disagree on', () => {
    expect(normalizeTeam('Jac')).toBe('JAX')
    expect(normalizeTeam('wsh')).toBe('WAS')
    expect(normalizeTeam('Pit')).toBe('PIT')
  })
})

describe('snake order', () => {
  it('turns back on even rounds', () => {
    expect(snakePicks(10, 4, 4)).toEqual([4, 17, 24, 37])
    expect(snakePicks(10, 1, 3)).toEqual([1, 20, 21])
    expect(snakePicks(10, 10, 3)).toEqual([10, 11, 30])
  })

  it('gives every seat the same number of picks', () => {
    for (let seat = 1; seat <= 12; seat++) {
      expect(snakePicks(12, seat, 15)).toHaveLength(15)
    }
  })
})

describe('matching Yahoo players to the board', () => {
  const board = [
    player({ playerId: 'a', name: 'Marvin Harrison Jr.', position: 'WR', team: 'ARI' }),
    player({ playerId: 'b', name: 'DEN Defense', position: 'DEF', team: 'DEN' }),
    player({ playerId: 'c', name: 'Josh Allen', position: 'QB', team: 'BUF' }),
  ]

  it('matches across suffix and case differences', () => {
    const yahoo: YahooPlayer[] = [
      { playerKey: '470.p.1', name: 'Marvin Harrison Jr', position: 'WR', team: 'Ari' },
    ]
    const { byPlayerKey, unmatched } = matchPlayers(yahoo, board)
    expect(unmatched).toHaveLength(0)
    expect(byPlayerKey.get('470.p.1')?.playerId).toBe('a')
  })

  it('matches a defence by team rather than name', () => {
    const yahoo: YahooPlayer[] = [
      { playerKey: '470.p.2', name: 'Denver', position: 'DEF', team: 'Den' },
    ]
    const { byPlayerKey } = matchPlayers(yahoo, board)
    expect(byPlayerKey.get('470.p.2')?.playerId).toBe('b')
  })

  it('reports a player it cannot place instead of dropping him', () => {
    const yahoo: YahooPlayer[] = [
      { playerKey: '470.p.9', name: 'Nobody At All', position: 'WR', team: 'NYJ' },
    ]
    const { byPlayerKey, unmatched } = matchPlayers(yahoo, board)
    expect(byPlayerKey.size).toBe(0)
    expect(unmatched).toHaveLength(1)
  })
})

describe('draft view', () => {
  const board = [
    player({ playerId: 'a', vorp: 100, overallRank: 1 }),
    player({ playerId: 'b', vorp: 90, overallRank: 2 }),
    player({ playerId: 'c', vorp: 80, overallRank: 3 }),
  ]
  const matched = new Map([
    ['470.p.1', board[0] as RankedPlayer],
    ['470.p.2', board[1] as RankedPlayer],
  ])
  const picks: DraftPick[] = [
    { pick: 1, round: 1, teamKey: '470.l.1.t.1', playerKey: '470.p.1' },
    { pick: 2, round: 1, teamKey: '470.l.1.t.4', playerKey: '470.p.2' },
  ]

  it('removes drafted players and tracks your own roster', () => {
    const view = buildView(picks, matched, board, {
      myTeamKey: '470.l.1.t.4',
      teams: 10,
      position: 4,
      rounds: 15,
    })
    expect(view.available.map((entry) => entry.playerId)).toEqual(['c'])
    expect(view.myRoster.map((entry) => entry.playerId)).toEqual(['b'])
  })

  it('counts the picks until the seat is up again', () => {
    const view = buildView(picks, matched, board, {
      myTeamKey: '470.l.1.t.4',
      teams: 10,
      position: 4,
      rounds: 15,
    })
    expect(view.onTheClock).toBe(3)
    expect(view.nextPick).toBe(4)
    expect(view.picksUntilNext).toBe(1)
  })
})

describe('roster needs', () => {
  it('decrements a slot as it is filled', () => {
    const roster = [player({ playerId: 'a', position: 'RB' })]
    expect(remainingNeeds(roster, { QB: 1, RB: 2, WR: 2 })).toEqual({ QB: 1, RB: 1, WR: 2 })
  })

  it('never goes negative when a position is overfilled', () => {
    const roster = [
      player({ playerId: 'a', position: 'RB' }),
      player({ playerId: 'b', position: 'RB' }),
      player({ playerId: 'c', position: 'RB' }),
    ]
    expect(remainingNeeds(roster, { RB: 2 })['RB']).toBe(0)
  })
})

describe('position cliffs', () => {
  it('ranks a position that empties out above one that does not', () => {
    const available = [
      player({ playerId: 'rb1', position: 'RB', vorp: 100 }),
      player({ playerId: 'wr1', position: 'WR', vorp: 95 }),
      player({ playerId: 'wr2', position: 'WR', vorp: 94 }),
      player({ playerId: 'wr3', position: 'WR', vorp: 93 }),
      player({ playerId: 'rb2', position: 'RB', vorp: 40 }),
    ]
    const cliffs = positionCliffs(available, 3, ['RB', 'WR'])
    expect(cliffs[0]?.position).toBe('RB')
    expect(cliffs[0]?.drop).toBeGreaterThan(cliffs[1]?.drop ?? 0)
  })
})
