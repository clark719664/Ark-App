import { describe, expect, it } from 'vitest'
import type { Player, RosterEntry } from '../../shared/types.js'
import { assessDataQuality, mergeRosteredPlayers } from './sync.js'

function player(id: string, points?: Player['points']): Player {
  return {
    id,
    name: `Player ${id}`,
    position: 'RB',
    nflTeam: 'KC',
    ownerTeamId: null,
    ...(points ? { points } : {}),
  }
}

function entry(p: Player | null, extra: Partial<RosterEntry> = {}): RosterEntry {
  return { slot: 'RB', starter: true, player: p, ...extra }
}

function rosterOf(players: Player[]): Record<string, RosterEntry[]> {
  return { '1': players.map((p) => entry(p)) }
}

describe('assessDataQuality', () => {
  it('reports healthy data when most rostered players have projections', () => {
    const quality = assessDataQuality(
      rosterOf([
        player('a', { projected: 12 }),
        player('b', { projected: 9 }),
        player('c', { projected: 4 }),
      ]),
    )
    expect(quality.projections).toBe('provider')
    expect(quality.playersWithProjections).toBe(3)
    expect(quality.notes).toHaveLength(0)
  })

  it('falls back to season average and says so when projections are missing', () => {
    const quality = assessDataQuality(
      rosterOf([
        player('a', { average: 12 }),
        player('b', { average: 9 }),
        player('c', { average: 4 }),
      ]),
    )
    expect(quality.projections).toBe('season-average')
    expect(quality.playersWithProjections).toBe(0)
    expect(quality.notes.join(' ')).toMatch(/season average/i)
  })

  it('flags the case that used to fail silently: no scoring data at all', () => {
    // This is exactly what a team page with an unrecognized column layout
    // produced before — every player projecting zero, with nothing to warn on.
    const quality = assessDataQuality(rosterOf([player('a'), player('b'), player('c')]))
    expect(quality.projections).toBe('none')
    expect(quality.notes.join(' ')).toMatch(/not meaningful/i)
    expect(quality.notes.join(' ')).toMatch(/yahoo:capture/)
  })

  it('does not call a mostly-empty column healthy', () => {
    // One player in five carrying a number means the parser missed the column,
    // not that four players are genuinely unprojected.
    const quality = assessDataQuality(
      rosterOf([
        player('a', { projected: 12 }),
        player('b'),
        player('c'),
        player('d'),
        player('e'),
      ]),
    )
    expect(quality.projections).not.toBe('provider')
  })

  it('ignores empty roster slots rather than counting them against quality', () => {
    const rosters = { '1': [entry(player('a', { projected: 10 })), entry(null)] }
    const quality = assessDataQuality(rosters)
    expect(quality.totalRosteredPlayers).toBe(1)
    expect(quality.projections).toBe('provider')
  })

  it('handles an empty league without dividing by zero', () => {
    const quality = assessDataQuality({})
    expect(quality.totalRosteredPlayers).toBe(0)
    expect(quality.projections).toBe('none')
    expect(quality.notes).toHaveLength(0)
  })
})

describe('mergeRosteredPlayers', () => {
  it('pushes pool projections back onto roster entries that lack them', () => {
    // The team page gave no projection column; the players page did.
    const rosters = { '1': [entry(player('a'))] }
    mergeRosteredPlayers([player('a', { projected: 15, average: 11 })], rosters)

    expect(rosters['1']![0]!.player!.points?.projected).toBe(15)
    expect(rosters['1']![0]!.projected).toBe(15)
  })

  it('keeps a roster projection that is already there', () => {
    const rosters = { '1': [entry(player('a', { projected: 20 }), { projected: 20 })] }
    mergeRosteredPlayers([player('a', { projected: 15 })], rosters)
    // The pool value wins for the player record, but an explicit entry
    // projection is not overwritten once set.
    expect(rosters['1']![0]!.projected).toBe(20)
  })

  it('carries ownership and bye week across from the roster', () => {
    const rostered = player('a', { projected: 8 })
    rostered.ownerTeamId = '1'
    rostered.byeWeek = 9
    const pool = player('a', { projected: 8 })

    const merged = mergeRosteredPlayers([pool], { '1': [entry(rostered)] })
    const found = merged.find((p) => p.id === 'a')!
    expect(found.ownerTeamId).toBe('1')
    expect(found.byeWeek).toBe(9)
  })

  it('includes rostered players the pool never returned', () => {
    const merged = mergeRosteredPlayers([], { '1': [entry(player('only-on-roster'))] })
    expect(merged.map((p) => p.id)).toEqual(['only-on-roster'])
  })

  it('does not duplicate a player who appears in both', () => {
    const merged = mergeRosteredPlayers(
      [player('a', { projected: 5 })],
      { '1': [entry(player('a'))] },
    )
    expect(merged.filter((p) => p.id === 'a')).toHaveLength(1)
  })
})
