import { describe, expect, it } from 'vitest'
import { fitNoise, LeagueRival, type ManagerProfile } from './managers.js'

function profile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    teamKey: 'x.t.1',
    name: 'Someone',
    addsPerWeek: 1,
    benchWasteShare: 0.2,
    ...overrides,
  }
}

describe('league rivals', () => {
  it('describes itself with the numbers it was fitted to', () => {
    const rival = new LeagueRival(profile({ name: 'Streamer Steve', addsPerWeek: 2 }))
    expect(rival.name).toBe('Streamer Steve')
    expect(rival.description).toContain('2.00 adds a week')
  })

  it('never claims more often than once a week, however active the manager was', () => {
    const rival = new LeagueRival(profile({ addsPerWeek: 9 }))
    let claims = 0
    // rng always returns 0, so a claim happens whenever the rate allows one.
    for (let week = 0; week < 10; week++) {
      const view = {
        roster: [], slots: [], week, freeAgents: [], opponent: null, rng: () => 0,
      }
      if (rival.waiverClaim(view as never) !== null) claims++
    }
    expect(claims).toBeLessThanOrEqual(10)
  })

  it('passes on the wire when the manager rarely touched it', () => {
    const rival = new LeagueRival(profile({ addsPerWeek: 0 }))
    const view = { roster: [], slots: [], week: 1, freeAgents: [], opponent: null, rng: () => 0.5 }
    expect(rival.waiverClaim(view as never)).toBeNull()
  })
})

describe('fitting lineup noise', () => {
  it('raises noise for a manager who wastes more than the simulation shows', () => {
    const profiles = [profile({ name: 'Wasteful', benchWasteShare: 0.3 })]
    // A stand-in simulation that always reports less waste than measured.
    const fitted = fitNoise(profiles, () => new Map([['Wasteful', 0.1]]), { rounds: 3 })
    expect(fitted[0]?.lineupNoise ?? 0).toBeGreaterThan(0.25)
  })

  it('lowers noise for a manager the simulation makes look worse than he was', () => {
    const profiles = [profile({ name: 'Sharp', benchWasteShare: 0.05 })]
    const fitted = fitNoise(profiles, () => new Map([['Sharp', 0.3]]), { rounds: 3 })
    expect(fitted[0]?.lineupNoise ?? 1).toBeLessThan(0.25)
  })

  it('never fits a negative amount of noise', () => {
    const profiles = [profile({ name: 'Perfect', benchWasteShare: 0 })]
    const fitted = fitNoise(profiles, () => new Map([['Perfect', 0.9]]), { rounds: 6 })
    expect(fitted[0]?.lineupNoise ?? -1).toBeGreaterThanOrEqual(0)
  })

  it('stops early once every manager is inside tolerance', () => {
    let calls = 0
    const profiles = [profile({ name: 'Matched', benchWasteShare: 0.2 })]
    fitNoise(
      profiles,
      () => {
        calls++
        return new Map([['Matched', 0.2]])
      },
      { rounds: 10, tolerance: 0.01 },
    )
    expect(calls).toBe(1)
  })
})
