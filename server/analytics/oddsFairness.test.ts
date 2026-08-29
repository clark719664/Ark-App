import { describe, expect, it } from 'vitest'
import { simulateSeason, type TeamForecast } from './season.js'
import type { LeagueSnapshot, Matchup, Team } from '../../shared/types.js'

/**
 * Playoff odds before anybody has played.
 *
 * Ten identical teams competing for four places is a question with one right
 * answer, and it is forty percent each. Getting a spread instead means the
 * simulation is reading something into the teams that is not there - which is
 * what happened when a snapshot taken in week one carried only week one's
 * fixtures: every team played a single game, the standings fell to the
 * points-for tiebreak, and identical teams came out between 35% and 52%.
 *
 * The odds summing correctly is not enough to catch that. They summed to
 * exactly 400% the whole time.
 *
 * A synthetic one week schedule does not reproduce the spread, so the fixture
 * here does not claim to: what is asserted is the property that must hold, not
 * a re-enactment of the fault. The fault itself was confirmed against the real
 * league, where a full schedule moved the range from 35-52% to 39.5-40.8%.
 */

const TEAMS = 10
const PLAYOFF_SPOTS = 4
const WEEKS = 14

function team(id: number): Team {
  return {
    id: String(id),
    name: `Team ${id}`,
    record: { wins: 0, losses: 0, ties: 0 },
    pointsFor: 0,
    pointsAgainst: 0,
  }
}

/** A round robin, so no team has an easier run than another. */
function schedule(): Matchup[] {
  const matchups: Matchup[] = []
  const ids = Array.from({ length: TEAMS }, (_, index) => index + 1)
  for (let week = 1; week <= WEEKS; week++) {
    const rotated = [ids[0] as number, ...ids.slice(1).map((_, i) => ids[((i + week) % (TEAMS - 1)) + 1] as number)]
    for (let pair = 0; pair < TEAMS / 2; pair++) {
      const home = rotated[pair] as number
      const away = rotated[TEAMS - 1 - pair] as number
      matchups.push({
        week,
        home: { teamId: String(home), score: 0 },
        away: { teamId: String(away), score: 0 },
        winnerTeamId: null,
        final: false,
      })
    }
  }
  return matchups
}

function snapshot(matchups: Matchup[]): LeagueSnapshot {
  return {
    league: {
      id: 'test',
      provider: 'yahoo',
      name: 'Test',
      season: 2026,
      numTeams: TEAMS,
      currentWeek: 1,
      regularSeasonWeeks: WEEKS,
      playoffTeams: PLAYOFF_SPOTS,
    },
    teams: Array.from({ length: TEAMS }, (_, index) => team(index + 1)),
    matchups,
    rosters: {},
    players: [],
    draft: [],
    fetchedAt: new Date(0).toISOString(),
    warnings: [],
  }
}

const forecasts: TeamForecast[] = Array.from({ length: TEAMS }, (_, index) => ({
  teamId: String(index + 1),
  mu: 100,
  sigma: 20,
  wins: 0,
  pointsFor: 0,
  basis: 'season-form',
}))

describe('playoff odds before anyone has played', () => {
  it('gives ten identical teams the same shot at four places', () => {
    const outcome = simulateSeason(snapshot(schedule()), forecasts, { simulations: 4000 })
    const odds = [...outcome.makePlayoffs.values()].map((value) => value * 100)

    const spread = Math.max(...odds) - Math.min(...odds)
    // Sampling error at four thousand runs is well under three points; the
    // failure this guards produced seventeen.
    expect(spread, odds.map((value) => value.toFixed(1)).join(', ')).toBeLessThan(6)
    for (const value of odds) expect(value).toBeGreaterThan(30)
  })

  it('still adds up, which the broken version also did', () => {
    const outcome = simulateSeason(snapshot(schedule()), forecasts, { simulations: 2000 })
    const total = [...outcome.makePlayoffs.values()].reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(PLAYOFF_SPOTS, 1)
  })

})
