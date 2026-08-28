import type { LeagueSnapshot, Player } from '../../shared/types.js'
import {
  buildForecasts, forecastWithRoster, remainingGames, simulateSeason,
  type TeamForecast,
} from './season.js'
import { RandomBlock, round } from './stats.js'

/**
 * What a move is actually worth.
 *
 * "This trade gains you 1.8 points a week" is a true statement that does not
 * answer the question. Points are the input; the output anyone cares about is
 * whether they make the playoffs and whether they win. A 1.8-point gain is
 * decisive for a team on the bubble and completely irrelevant for a team that
 * is 97% in or 2% out — and no points-denominated tool can tell those apart.
 *
 * So every transaction is priced by re-forecasting the roster, re-simulating
 * the rest of the season, and reporting the change in playoff and title
 * probability. Scenarios share one block of random numbers, which is what makes
 * a two-point swing measurable at all: without it the difference between two
 * runs is mostly simulation noise.
 */

export interface OddsSnapshot {
  makePlayoffs: number
  winTitle: number
  projectedWins: number
  projectedSeed: number
}

export interface Impact {
  before: OddsSnapshot
  after: OddsSnapshot
  /** Change in playoff probability, in percentage points. */
  playoffSwing: number
  /** Change in title probability, in percentage points. */
  titleSwing: number
}

/**
 * Fewer seasons than the headline odds run, because paired draws make the
 * *difference* between two scenarios far more stable than either number alone.
 * This is the accuracy that matters when comparing moves.
 */
const IMPACT_SIMULATIONS = 4000

export class ImpactCalculator {
  private readonly draws: RandomBlock
  private readonly baseForecasts: TeamForecast[]
  private readonly baseline: Map<string, OddsSnapshot>

  constructor(private readonly snapshot: LeagueSnapshot, seed = 0x1a9c7f) {
    const gameCount = Math.max(1, remainingGames(snapshot).length)
    // Room for the regular season plus the playoff bracket draws.
    this.draws = new RandomBlock(IMPACT_SIMULATIONS * gameCount * 2 + 40_000, seed)
    this.baseForecasts = buildForecasts(snapshot)
    this.baseline = this.run(this.baseForecasts)
  }

  private run(forecasts: TeamForecast[]): Map<string, OddsSnapshot> {
    const outcome = simulateSeason(this.snapshot, forecasts, {
      simulations: IMPACT_SIMULATIONS,
      draws: this.draws,
    })

    const result = new Map<string, OddsSnapshot>()
    for (const forecast of forecasts) {
      result.set(forecast.teamId, {
        makePlayoffs: outcome.makePlayoffs.get(forecast.teamId) ?? 0,
        winTitle: outcome.winTitle.get(forecast.teamId) ?? 0,
        projectedWins: outcome.projectedWins.get(forecast.teamId) ?? 0,
        projectedSeed: outcome.projectedSeed.get(forecast.teamId) ?? 0,
      })
    }
    return result
  }

  oddsFor(teamId: string): OddsSnapshot {
    return (
      this.baseline.get(teamId) ?? {
        makePlayoffs: 0,
        winTitle: 0,
        projectedWins: 0,
        projectedSeed: 0,
      }
    )
  }

  /**
   * Re-price the season with one or more teams' rosters changed.
   *
   * Multiple teams can move at once, because a trade changes both sides and
   * pricing only your half would overstate it — the player you sent makes your
   * opponent better, and that opponent may be racing you for the same seed.
   */
  impactOf(
    changes: Array<{ teamId: string; players: Player[] }>,
    forTeamId: string,
  ): Impact {
    let forecasts = this.baseForecasts
    for (const change of changes) {
      forecasts = forecastWithRoster(this.snapshot, forecasts, change.teamId, change.players)
    }

    const after = this.run(forecasts)
    const before = this.oddsFor(forTeamId)
    const now = after.get(forTeamId) ?? before

    return {
      before,
      after: now,
      playoffSwing: round((now.makePlayoffs - before.makePlayoffs) * 100, 1),
      titleSwing: round((now.winTitle - before.winTitle) * 100, 1),
    }
  }
}

/** Players on a roster, after sending some away and receiving others. */
export function rosterAfterTrade(
  current: Player[],
  sends: Player[],
  receives: Player[],
): Player[] {
  const outgoing = new Set(sends.map((p) => p.id))
  return [...current.filter((p) => !outgoing.has(p.id)), ...receives]
}

export type Posture = 'contend' | 'push' | 'sell'

export interface PostureAdvice {
  posture: Posture
  playoffOdds: number
  headline: string
  detail: string
}

/**
 * What a manager should be doing, given where they actually stand.
 *
 * The same trade is a good idea for one team and a waste of a roster spot for
 * another. A team at 4% should be selling the players whose value peaks now; a
 * team at 96% should be buying upside for the bracket rather than shaving a
 * point off a regular season it has already won.
 */
export function derivePosture(odds: OddsSnapshot): PostureAdvice {
  const playoffOdds = odds.makePlayoffs

  if (playoffOdds >= 0.9) {
    return {
      posture: 'contend',
      playoffOdds,
      headline: 'You are in. Play for the bracket.',
      detail:
        'Regular-season points barely move your odds now. Value moves by what they do to your ' +
        'title chances instead, and prefer upside over floor — you need to win three games ' +
        'against good teams, not grind out one more win.',
    }
  }

  if (playoffOdds >= 0.25) {
    return {
      posture: 'push',
      playoffOdds,
      headline: 'You are on the bubble. Every point matters.',
      detail:
        'This is the range where small upgrades swing the season most: a two-point weekly gain ' +
        'is worth several points of playoff probability. Spend waiver priority and take the ' +
        'fair trades.',
    }
  }

  return {
    posture: 'sell',
    playoffOdds,
    headline: 'You are on the outside. Sell what peaks now.',
    detail:
      'Marginal upgrades will not save this season. The players worth moving are the ones whose ' +
      'value is highest today, and the teams worth dealing with are the ones close enough to ' +
      'the bubble to overpay for them.',
  }
}
