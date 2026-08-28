import type { LeagueSnapshot, Player } from '../../shared/types.js'
import { buildTeamModels, type TeamModel } from './index.js'
import { bestLineup, resolveSlots } from './lineup.js'
import { makeRng, normalSample, round } from './stats.js'

/**
 * Win probability for a single head-to-head matchup.
 *
 * The season-long odds model each team by how much it has scored over the year,
 * which is the right basis for a question about the whole season. It is the
 * wrong basis for *this week*: a team with two starters on bye and a third
 * ruled out will not score its season average, and telling someone they are a
 * 60% favourite against that team is simply wrong.
 *
 * So a week's odds start from each side's actual startable lineup, and fall
 * back to the season model only when there is no roster or projection data to
 * work from.
 */

export interface MatchupOdds {
  week: number
  homeTeamId: string
  awayTeamId: string
  homeWinProbability: number
  awayWinProbability: number
  homeProjected: number
  awayProjected: number
  /** Mean absolute margin across the simulations. */
  projectedMargin: number
  favouriteTeamId: string | null
  /** Where the projections came from, so the UI can be honest about it. */
  basis: 'lineup' | 'season-form'
}

const SIMULATIONS = 10_000

/**
 * Stand-in for a team with no usable history and no projections — a league
 * synced before week one, say. The number is arbitrary, but both sides get the
 * same one, so the resulting odds are an honest 50/50 rather than a forecast
 * of zero points, which would not mean anything.
 */
const NEUTRAL_SCORE = 100
const NEUTRAL_SPREAD = 20

interface WeekModel {
  mu: number
  sigma: number
  basis: 'lineup' | 'season-form'
}

/**
 * A team's expected score for one specific week.
 *
 * The mean comes from the projected points of the lineup they can actually
 * field. The spread stays anchored to how variable that team has been all
 * season, because a projection tells you the centre of the distribution and
 * says nothing about its width.
 */
function weekModel(
  snapshot: LeagueSnapshot,
  teamId: string,
  week: number,
  seasonModel: TeamModel | undefined,
): WeekModel {
  const seasonMu = seasonModel?.mu ?? 0
  const fallback: WeekModel = {
    // A season model built from no completed games has a mean of zero, which
    // is an absence of information rather than a prediction of a shutout.
    mu: seasonMu > 0 ? seasonMu : NEUTRAL_SCORE,
    sigma: seasonModel && seasonModel.sigma > 0 ? seasonModel.sigma : NEUTRAL_SPREAD,
    basis: 'season-form',
  }

  const roster = snapshot.rosters[teamId]
  if (!roster || roster.length === 0) return fallback

  const players = roster
    .map((entry) => entry.player)
    .filter((player): player is Player => player !== null)

  const slots = resolveSlots(snapshot.league.rosterSlots, roster)
  const projected = bestLineup(players, slots, week).total

  // No usable projections: the lineup total would be zero, which is not a
  // forecast, it is an absence of one.
  if (projected <= 0) return fallback

  return {
    mu: projected,
    // A projection gives the centre of the distribution and says nothing about
    // its width, so the spread stays anchored to how variable this team has
    // actually been. Teams with no history get a spread scaled to the forecast.
    sigma:
      seasonModel && seasonModel.sigma > 0
        ? seasonModel.sigma
        : Math.max(12, projected * 0.18),
    basis: 'lineup',
  }
}

export function computeMatchupOdds(snapshot: LeagueSnapshot, week: number): MatchupOdds[] {
  const seasonModels = new Map(buildTeamModels(snapshot).map((model) => [model.id, model]))
  const rng = makeRng(0xfa17 + week)

  return snapshot.matchups
    .filter((matchup) => matchup.week === week)
    .map((matchup) => {
      const home = weekModel(snapshot, matchup.home.teamId, week, seasonModels.get(matchup.home.teamId))
      const away = weekModel(snapshot, matchup.away.teamId, week, seasonModels.get(matchup.away.teamId))

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
        // Only claim a lineup basis when both sides actually have one.
        basis: home.basis === 'lineup' && away.basis === 'lineup' ? 'lineup' : 'season-form',
      }
    })
}
