import { describe, expect, it } from 'vitest'
import type { LeagueSnapshot, Player, RosterEntry } from '../../shared/types.js'
import { buildDemoSnapshot } from '../providers/demo.js'
import { optimizeLineup, projectionOf, resolveSlots } from './lineup.js'
import { canFill, isBenchSlot, slotEligibility, startingSlots } from './slots.js'
import { buildWaiverReport } from './waivers.js'
import { findMarketSignals, findTrades, lineupStrength } from './trades.js'
import { computeMatchupOdds } from './matchup.js'

function player(id: string, position: Player['position'], projected: number, extra: Partial<Player> = {}): Player {
  return {
    id, name: `Player ${id}`, position, nflTeam: 'KC', ownerTeamId: null,
    points: { projected }, ...extra,
  }
}

function entry(slot: string, starter: boolean, p: Player | null): RosterEntry {
  return { slot, starter, player: p }
}

describe('slot eligibility', () => {
  it('recognizes bench and reserve slots', () => {
    for (const slot of ['BN', 'bn', 'IR', 'Bench', 'NA']) expect(isBenchSlot(slot)).toBe(true)
    for (const slot of ['QB', 'W/R/T', 'DEF']) expect(isBenchSlot(slot)).toBe(false)
  })

  it('reads composite flex slots from their own name', () => {
    expect(slotEligibility('W/R/T')?.sort()).toEqual(['RB', 'TE', 'WR'])
    expect(slotEligibility('Q/W/R/T')?.sort()).toEqual(['QB', 'RB', 'TE', 'WR'])
    expect(slotEligibility('W/R')?.sort()).toEqual(['RB', 'WR'])
  })

  it('treats FLEX and W/R/T as the same slot', () => {
    expect(slotEligibility('FLEX')?.sort()).toEqual(slotEligibility('W/R/T')?.sort())
  })

  it('returns null for slots that do not start', () => {
    expect(slotEligibility('BN')).toBeNull()
    expect(slotEligibility('IR')).toBeNull()
  })

  it('enforces position eligibility', () => {
    expect(canFill('QB', 'QB')).toBe(true)
    expect(canFill('QB', 'RB')).toBe(false)
    expect(canFill('W/R/T', 'RB')).toBe(true)
    expect(canFill('W/R/T', 'QB')).toBe(false)
    expect(canFill('BN', 'RB')).toBe(false)
  })

  it('honours secondary eligibility', () => {
    expect(canFill('RB', 'WR', ['WR', 'RB'])).toBe(true)
    expect(canFill('RB', 'WR', ['WR'])).toBe(false)
  })

  it('expands a roster configuration into individual slots', () => {
    expect(startingSlots([{ slot: 'RB', count: 2 }, { slot: 'BN', count: 6 }])).toEqual(['RB', 'RB'])
  })
})

describe('optimizeLineup', () => {
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T']

  it('finds points left on the bench', () => {
    const roster: RosterEntry[] = [
      entry('QB', true, player('qb1', 'QB', 20)),
      entry('RB', true, player('rb1', 'RB', 15)),
      entry('RB', true, player('rb2', 'RB', 5)),
      entry('WR', true, player('wr1', 'WR', 14)),
      entry('WR', true, player('wr2', 'WR', 12)),
      entry('TE', true, player('te1', 'TE', 8)),
      entry('W/R/T', true, player('wr3', 'WR', 9)),
      // A far better running back sitting on the bench.
      entry('BN', false, player('rb3', 'RB', 18)),
    ]
    const result = optimizeLineup(roster, slots)
    expect(result.pointsLeftOnBench).toBeCloseTo(13, 1)
    expect(result.swaps[0]?.in.id).toBe('rb3')
    expect(result.swaps[0]?.out.id).toBe('rb2')
  })

  it('reports nothing to change when the lineup is already optimal', () => {
    const roster: RosterEntry[] = [
      entry('QB', true, player('qb1', 'QB', 20)),
      entry('RB', true, player('rb1', 'RB', 15)),
      entry('RB', true, player('rb2', 'RB', 14)),
      entry('WR', true, player('wr1', 'WR', 13)),
      entry('WR', true, player('wr2', 'WR', 12)),
      entry('TE', true, player('te1', 'TE', 11)),
      entry('W/R/T', true, player('wr3', 'WR', 10)),
      entry('BN', false, player('rb3', 'RB', 3)),
    ]
    const result = optimizeLineup(roster, slots)
    expect(result.pointsLeftOnBench).toBe(0)
    expect(result.swaps).toHaveLength(0)
  })

  it('never starts a player who is on bye', () => {
    const roster: RosterEntry[] = [
      entry('QB', true, player('qb1', 'QB', 30, { byeWeek: 7 })),
      entry('BN', false, player('qb2', 'QB', 12)),
    ]
    const result = optimizeLineup(roster, ['QB'], 7)
    expect(result.optimal[0]?.player?.id).toBe('qb2')
    expect(result.alerts.some((a) => a.reason.includes('bye'))).toBe(true)
  })

  it('never starts a player ruled out', () => {
    const roster: RosterEntry[] = [
      entry('RB', true, player('rb1', 'RB', 25, { injury: { code: 'O', label: 'Out' } })),
      entry('BN', false, player('rb2', 'RB', 9)),
    ]
    const result = optimizeLineup(roster, ['RB'])
    expect(result.optimal[0]?.player?.id).toBe('rb2')
    expect(result.alerts[0]?.severity).toBe('high')
  })

  it('flags questionable starters without benching them', () => {
    const roster: RosterEntry[] = [
      entry('RB', true, player('rb1', 'RB', 25, { injury: { code: 'Q', label: 'Questionable' } })),
      entry('BN', false, player('rb2', 'RB', 9)),
    ]
    const result = optimizeLineup(roster, ['RB'])
    expect(result.optimal[0]?.player?.id).toBe('rb1')
    expect(result.alerts[0]?.severity).toBe('medium')
  })

  it('does not credit a bye-week starter with points he cannot score', () => {
    // The starting RB is on bye, so the lineup as set scores nothing at RB and
    // the bench replacement is a genuine 9-point gain, not a 16-point loss.
    const roster: RosterEntry[] = [
      entry('RB', true, player('rb1', 'RB', 25, { byeWeek: 4 })),
      entry('BN', false, player('rb2', 'RB', 9)),
    ]
    const result = optimizeLineup(roster, ['RB'], 4)
    expect(result.currentProjected).toBe(0)
    expect(result.optimalProjected).toBe(9)
    expect(result.pointsLeftOnBench).toBe(9)
    expect(result.swaps[0]?.gain).toBe(9)
  })

  it('only ever swaps a starter for someone eligible for the same slot', () => {
    // The defense is on bye and must be replaced, but by a defense — never by
    // the wide receiver who happens to be the next name on the bench.
    const roster: RosterEntry[] = [
      entry('WR', true, player('wr1', 'WR', 4)),
      entry('DEF', true, player('def1', 'DEF', 12, { byeWeek: 3 })),
      entry('BN', false, player('def2', 'DEF', 7)),
      entry('BN', false, player('wr2', 'WR', 15)),
    ]
    const result = optimizeLineup(roster, ['WR', 'DEF'], 3)
    for (const swap of result.swaps) {
      expect(canFill(swap.slot, swap.out.position, swap.out.eligiblePositions)).toBe(true)
      expect(canFill(swap.slot, swap.in.position, swap.in.eligiblePositions)).toBe(true)
    }
    expect(result.swaps.find((s) => s.slot === 'DEF')?.in.id).toBe('def2')
    expect(result.swaps.find((s) => s.slot === 'WR')?.in.id).toBe('wr2')
  })

  it('reports every change it makes, not just the biggest one', () => {
    // Two starters are on bye. Both need replacing, and the flex promotion must
    // not consume the wide receiver that the WR promotion needs to displace.
    const roster: RosterEntry[] = [
      entry('WR', true, player('wrOut', 'WR', 20, { byeWeek: 5 })),
      entry('W/R/T', true, player('flexOld', 'RB', 6)),
      entry('BN', false, player('wrIn', 'WR', 9)),
      entry('BN', false, player('flexIn', 'RB', 12)),
    ]
    const result = optimizeLineup(roster, ['WR', 'W/R/T'], 5)

    expect(result.swaps).toHaveLength(2)
    expect(result.swaps.find((s) => s.slot === 'WR')?.in.id).toBe('wrIn')
    expect(result.swaps.find((s) => s.slot === 'W/R/T')?.in.id).toBe('flexIn')

    // Every highlighted change is accounted for by a reported swap.
    const changed = result.optimal.filter((a) => a.changed).length
    expect(result.swaps).toHaveLength(changed)

    // And the gains add up to the headline number.
    const totalGain = result.swaps.reduce((sum, s) => sum + s.gain, 0)
    expect(totalGain).toBeCloseTo(result.pointsLeftOnBench, 5)
  })

  it('fills the flex with the best leftover skill player', () => {
    const roster: RosterEntry[] = [
      entry('RB', false, player('rb1', 'RB', 10)),
      entry('WR', false, player('wr1', 'WR', 20)),
      entry('WR', false, player('wr2', 'WR', 18)),
    ]
    const result = optimizeLineup(roster, ['RB', 'W/R/T'])
    expect(result.optimal.find((a) => a.slot === 'RB')?.player?.id).toBe('rb1')
    expect(result.optimal.find((a) => a.slot === 'W/R/T')?.player?.id).toBe('wr1')
  })

  it('leaves a slot empty rather than starting an ineligible player', () => {
    const roster: RosterEntry[] = [entry('BN', false, player('wr1', 'WR', 20))]
    const result = optimizeLineup(roster, ['QB'])
    expect(result.optimal[0]?.player).toBeNull()
    expect(result.optimalProjected).toBe(0)
  })

  it('returns the lineup in the league\'s slot order', () => {
    const slotOrder = ['QB', 'RB', 'WR', 'TE', 'W/R/T']
    const roster: RosterEntry[] = [
      entry('BN', false, player('qb1', 'QB', 20)),
      entry('BN', false, player('rb1', 'RB', 15)),
      entry('BN', false, player('wr1', 'WR', 14)),
      entry('BN', false, player('te1', 'TE', 8)),
      entry('BN', false, player('wr2', 'WR', 12)),
    ]
    const result = optimizeLineup(roster, slotOrder)
    expect(result.optimal.map((a) => a.slot)).toEqual(slotOrder)
  })

  it('does not leak assignment state between calls', () => {
    const roster: RosterEntry[] = [entry('BN', false, player('qb1', 'QB', 20))]
    const first = optimizeLineup(roster, ['QB'])
    const second = optimizeLineup(roster, ['QB'])
    expect(second.optimal).toEqual(first.optimal)
    expect(second.optimalProjected).toBe(20)
  })

  it('prefers an explicit entry projection over the player-level one', () => {
    const p = player('rb1', 'RB', 5)
    expect(projectionOf(p, { slot: 'RB', starter: true, player: p, projected: 17 })).toBe(17)
    expect(projectionOf(p)).toBe(5)
  })

  it('falls back to the roster\'s own slots when the league reports none', () => {
    const roster = [entry('QB', true, player('qb1', 'QB', 1)), entry('BN', false, null)]
    expect(resolveSlots(undefined, roster)).toEqual(['QB'])
    expect(resolveSlots([{ slot: 'RB', count: 1 }], roster)).toEqual(['RB'])
  })
})

describe('waiver report', () => {
  const snapshot = buildDemoSnapshot()
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF']
  const teamId = snapshot.teams[0]!.id
  const report = buildWaiverReport(snapshot, teamId, slots)

  it('ranks targets by how much they upgrade the lineup', () => {
    expect(report.targets.length).toBeGreaterThan(0)
    for (let i = 1; i < report.targets.length; i += 1) {
      expect(report.targets[i - 1]!.upgrade).toBeGreaterThanOrEqual(report.targets[i]!.upgrade)
      expect(report.targets[i]!.rank).toBe(i + 1)
    }
  })

  it('never suggests a player who is already rostered', () => {
    const rostered = new Set(
      Object.values(snapshot.rosters).flatMap((entries) =>
        entries.map((e) => e.player?.id).filter(Boolean),
      ),
    )
    for (const target of report.targets) expect(rostered.has(target.player.id)).toBe(false)
  })

  it('gives every target at least one stated reason', () => {
    for (const target of report.targets) expect(target.reasons.length).toBeGreaterThan(0)
  })

  it('surfaces the position where the wire helps most, first', () => {
    expect(report.outlook.length).toBeGreaterThan(0)
    for (let i = 1; i < report.outlook.length; i += 1) {
      expect(report.outlook[i - 1]!.bestUpgrade).toBeGreaterThanOrEqual(
        report.outlook[i]!.bestUpgrade,
      )
    }
  })

  it('does not let one position crowd out the whole list', () => {
    const counts = new Map<string, number>()
    for (const target of report.targets) {
      counts.set(target.player.position, (counts.get(target.player.position) ?? 0) + 1)
    }
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(3)
  })

  it('only ever names a displaced player who is actually on the roster', () => {
    // A pickup can also fill a slot left empty by a bye, displacing nobody.
    const rosterIds = new Set(
      (snapshot.rosters[teamId] ?? []).map((e) => e.player?.id).filter(Boolean),
    )
    for (const target of report.targets) {
      if (target.replaces === null) continue
      expect(rosterIds.has(target.replaces.id)).toBe(true)
      expect(target.upgrade).toBeGreaterThan(0)
    }
  })

  it('reports a vacancy fill as an upgrade with nobody displaced', () => {
    // The only defense is on bye, so the slot scores nothing and any healthy
    // defense is a pure gain rather than a swap.
    const custom: LeagueSnapshot = {
      ...snapshot,
      league: { ...snapshot.league, currentWeek: 2 },
      teams: [{ id: 'x', name: 'X', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 }],
      rosters: { x: [entry('DEF', true, player('d1', 'DEF', 9, { byeWeek: 2 }))] },
      players: [player('d2', 'DEF', 7)],
      matchups: [],
    }
    const result = buildWaiverReport(custom, 'x', ['DEF'])
    expect(result.targets[0]?.upgrade).toBe(7)
    expect(result.targets[0]?.replaces).toBeNull()
  })

  it('measures a target against what the starter scores this week, not in general', () => {
    // The rostered tight end is excellent but on bye, so an ordinary free agent
    // is a real upgrade for this week and should be ranked as one.
    const custom: LeagueSnapshot = {
      ...snapshot,
      league: { ...snapshot.league, currentWeek: 6 },
      teams: [{ id: 'x', name: 'X', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 }],
      rosters: { x: [entry('TE', true, player('star', 'TE', 18, { byeWeek: 6 }))] },
      players: [
        player('healthy', 'TE', 8),
        player('alsoBye', 'TE', 14, { byeWeek: 6 }),
      ],
      matchups: [],
    }
    const result = buildWaiverReport(custom, 'x', ['TE'])
    expect(result.targets[0]?.player.id).toBe('healthy')
    expect(result.targets[0]?.upgrade).toBe(8)
    // The higher-projected player is useless this week and must rank below.
    const stash = result.targets.find((t) => t.player.id === 'alsoBye')
    expect(stash?.upgrade).toBe(0)
  })

  it('values a free agent by what he adds to the best lineup, flex included', () => {
    // One tight end slot and one flex. A second good tight end still helps,
    // because he takes the flex spot from a much worse receiver.
    const custom: LeagueSnapshot = {
      ...snapshot,
      league: { ...snapshot.league, currentWeek: 1 },
      teams: [{ id: 'x', name: 'X', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 }],
      rosters: {
        x: [
          entry('TE', true, player('te1', 'TE', 14)),
          entry('W/R/T', true, player('wr1', 'WR', 4)),
        ],
      },
      players: [player('te2', 'TE', 10)],
      matchups: [],
    }
    const result = buildWaiverReport(custom, 'x', ['TE', 'W/R/T'])
    expect(result.targets[0]?.upgrade).toBe(6)
    expect(result.targets[0]?.replaces?.id).toBe('wr1')
  })

  it('flags a bye-week hole as a gap and prioritizes the fix', () => {
    const custom: LeagueSnapshot = {
      ...snapshot,
      league: { ...snapshot.league, currentWeek: 9 },
      teams: [{ id: 'x', name: 'X', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 }],
      rosters: { x: [entry('TE', true, player('mine', 'TE', 9, { byeWeek: 9 }))] },
      players: [player('fa', 'TE', 11)],
      matchups: [],
    }
    const result = buildWaiverReport(custom, 'x', ['TE'])
    expect(result.gaps.some((gap) => gap.position === 'TE')).toBe(true)
    expect(result.targets[0]?.priority).toBe('high')
    expect(result.targets[0]?.reasons.some((r) => r.includes('hole at TE'))).toBe(true)
  })
})

describe('trade finder', () => {
  const slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'W/R/T']

  it('values a lineup by its best legal starters only', () => {
    const players = [player('a', 'RB', 20), player('b', 'RB', 18), player('c', 'RB', 16)]
    // Two RB slots plus a flex means all three start here.
    expect(lineupStrength(players, ['RB', 'RB', 'W/R/T'])).toBe(54)
    // With one RB slot and no flex, only the best counts.
    expect(lineupStrength(players, ['RB'])).toBe(20)
  })

  it('only proposes trades where both sides gain', () => {
    const snapshot = buildDemoSnapshot()
    const report = findTrades(snapshot, snapshot.teams[0]!.id, slots, { limit: 20 })
    for (const idea of report.ideas) {
      expect(idea.you.gain).toBeGreaterThan(0)
      expect(idea.them.gain).toBeGreaterThan(0)
      expect(idea.totalGain).toBeCloseTo(idea.you.gain + idea.them.gain, 1)
    }
  })

  it('finds the obvious swap between two lopsided rosters', () => {
    // I have two good RBs and no tight end; they have the mirror image.
    const snapshot: LeagueSnapshot = {
      league: {
        id: 't', provider: 'demo', name: 'T', season: 2026, numTeams: 2,
        currentWeek: 1, regularSeasonWeeks: 1, playoffTeams: 1,
      },
      teams: [
        { id: 'me', name: 'Me', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 },
        { id: 'them', name: 'Them', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 },
      ],
      rosters: {
        me: [
          entry('RB', true, player('rb-a', 'RB', 20)),
          entry('BN', false, player('rb-b', 'RB', 19)),
          entry('TE', true, player('te-bad', 'TE', 2)),
        ],
        them: [
          entry('TE', true, player('te-a', 'TE', 18)),
          entry('BN', false, player('te-b', 'TE', 17)),
          entry('RB', true, player('rb-bad', 'RB', 2)),
        ],
      },
      matchups: [], players: [], draft: [], fetchedAt: '', warnings: [],
    }

    const report = findTrades(snapshot, 'me', ['RB', 'TE'], { limit: 5 })
    expect(report.ideas.length).toBeGreaterThan(0)
    const best = report.ideas[0]!
    expect(best.you.sends[0]?.position).toBe('RB')
    expect(best.you.receives[0]?.position).toBe('TE')
    expect(best.fairness).toBeGreaterThan(0)
    expect(best.fairness).toBeLessThanOrEqual(1)
  })

  it('finds no trade when neither roster can be improved', () => {
    const snapshot: LeagueSnapshot = {
      league: {
        id: 't', provider: 'demo', name: 'T', season: 2026, numTeams: 2,
        currentWeek: 1, regularSeasonWeeks: 1, playoffTeams: 1,
      },
      teams: [
        { id: 'me', name: 'Me', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 },
        { id: 'them', name: 'Them', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 },
      ],
      rosters: {
        me: [entry('RB', true, player('a', 'RB', 10)), entry('TE', true, player('b', 'TE', 10))],
        them: [entry('RB', true, player('c', 'RB', 10)), entry('TE', true, player('d', 'TE', 10))],
      },
      matchups: [], players: [], draft: [], fetchedAt: '', warnings: [],
    }
    expect(findTrades(snapshot, 'me', ['RB', 'TE']).ideas).toHaveLength(0)
  })

  it('scores a perfectly balanced trade as maximally fair', () => {
    const snapshot: LeagueSnapshot = {
      league: {
        id: 't', provider: 'demo', name: 'T', season: 2026, numTeams: 2,
        currentWeek: 1, regularSeasonWeeks: 1, playoffTeams: 1,
      },
      teams: [
        { id: 'me', name: 'Me', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 },
        { id: 'them', name: 'Them', record: { wins: 0, losses: 0, ties: 0 }, pointsFor: 0, pointsAgainst: 0 },
      ],
      // Each side has a spare starter-quality player at the position the other
      // is missing, so the swap is worth exactly the same to both of them.
      rosters: {
        me: [
          entry('RB', true, player('a', 'RB', 20)),
          entry('BN', false, player('a2', 'RB', 20)),
          entry('TE', true, player('b', 'TE', 5)),
        ],
        them: [
          entry('TE', true, player('d', 'TE', 20)),
          entry('BN', false, player('d2', 'TE', 20)),
          entry('RB', true, player('c', 'RB', 5)),
        ],
      },
      matchups: [], players: [], draft: [], fetchedAt: '', warnings: [],
    }
    const best = findTrades(snapshot, 'me', ['RB', 'TE']).ideas[0]!
    expect(best.you.gain).toBeCloseTo(best.them.gain, 5)
    expect(best.fairness).toBeCloseTo(1, 5)
  })
})

describe('market signals', () => {
  it('splits divergent players into buy-low and sell-high', () => {
    const snapshot: LeagueSnapshot = {
      ...buildDemoSnapshot(),
      players: [
        player('hot', 'RB', 0, { points: { average: 10, lastWeek: 25 } }),
        player('cold', 'WR', 0, { points: { average: 14, lastWeek: 3 } }),
        player('steady', 'TE', 0, { points: { average: 10, lastWeek: 10 } }),
        player('scrub', 'K', 0, { points: { average: 2, lastWeek: 9 } }),
      ],
    }
    const signals = findMarketSignals(snapshot)
    expect(signals.find((s) => s.player.id === 'hot')?.kind).toBe('sell-high')
    expect(signals.find((s) => s.player.id === 'cold')?.kind).toBe('buy-low')
    // Steady form and marginal players are not trade conversations.
    expect(signals.find((s) => s.player.id === 'steady')).toBeUndefined()
    expect(signals.find((s) => s.player.id === 'scrub')).toBeUndefined()
  })
})

describe('matchup odds', () => {
  const snapshot = buildDemoSnapshot()
  const odds = computeMatchupOdds(snapshot, snapshot.league.currentWeek)

  it('returns complementary probabilities for every matchup', () => {
    expect(odds.length).toBeGreaterThan(0)
    for (const entry of odds) {
      expect(entry.homeWinProbability + entry.awayWinProbability).toBeCloseTo(1, 3)
      expect(entry.favouriteTeamId).not.toBeNull()
    }
  })

  it('makes a far stronger team an overwhelming favourite', () => {
    const strong = [...snapshot.teams].sort((a, b) => b.pointsFor - a.pointsFor)[0]!
    const weak = [...snapshot.teams].sort((a, b) => a.pointsFor - b.pointsFor)[0]!
    const custom: LeagueSnapshot = {
      ...snapshot,
      matchups: [
        ...snapshot.matchups,
        {
          week: 99,
          home: { teamId: strong.id, score: 0 },
          away: { teamId: weak.id, score: 0 },
          winnerTeamId: null,
          final: false,
        },
      ],
    }
    const result = computeMatchupOdds(custom, 99)[0]!
    expect(result.homeWinProbability).toBeGreaterThan(0.6)
  })
})
