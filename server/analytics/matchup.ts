import type { LeagueSnapshot } from '../../shared/types.js'
import { buildTeamModels } from './index.js'
import { makeRng, normalSample, round } from './stats.js'

/**
 * Win probability for a single head-to-head matchup.
 *
 * Simulated from the same scoring distributions the playoff odds use, so a
 * week's preview and the season outlook never disagree with each other.
 */

export interface MatchupOdds {
  week: number
  homeTeamId: string
  awayTeamId: string
  homeWinProbability: number
  awayWinProbability: number
  homeProjected: number
  awayProjected: number
  /** Median winning margin for the favourite. */
  projectedMargin: number
  favouriteTeamId: string | null
}

const SIMULATIONS = 10_000

export function computeMatchupOdds(snapshot: LeagueSnapshot, week: number): MatchupOdds[] {
  const models = new Map(buildTeamModels(snapshot).map((model) => [model.id, model]))
  const rng = makeRng(0xfa17 + week)

  return snapshot.matchups
    .filter((matchup) => matchup.week === week)
    .map((matchup) => {
      const home = models.get(matchup.home.teamId)
      const away = models.get(matchup.away.teamId)

      if (!home || !away) {
        return {
          week,
          homeTeamId: matchup.home.teamId,
          awayTeamId: matchup.away.teamId,
          homeWinProbability: 0.5,
          awayWinProbability: 0.5,
          homeProjected: 0,
          awayProjected: 0,
          projectedMargin: 0,
          favouriteTeamId: null,
        }
      }

      let homeWins = 0
      let margin = 0
      for (let i = 0; i < SIMULATIONS; i += 1) {
        const homeScore = Math.max(0, normalSample(rng, home.mu, home.sigma))
        const awayScore = Math.max(0, normalSample(rng, away.mu, away.sigma))
        if (homeScore > awayScore) homeWins += 1
        margin += Math.abs(homeScore - awayScore)
      }

      const homeProbability = homeWins / SIMULATIONS

      return {
        week,
        homeTeamId: matchup.home.teamId,
        awayTeamId: matchup.away.teamId,
        homeWinProbability: round(homeProbability, 4),
        awayWinProbability: round(1 - homeProbability, 4),
        homeProjected: round(home.mu, 1),
        awayProjected: round(away.mu, 1),
        projectedMargin: round(margin / SIMULATIONS, 1),
        favouriteTeamId: homeProbability >= 0.5 ? matchup.home.teamId : matchup.away.teamId,
      }
    })
}
