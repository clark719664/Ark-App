import type { LeagueSnapshot } from '../../shared/types.js'
import { buildForecasts, remainingGames, simulateSeason } from './season.js'
import { RandomBlock, round } from './stats.js'

/**
 * Which games actually matter, and what still has to happen.
 *
 * Standings tell you where you are. They do not tell you that this week's game
 * swings your season by twenty points of playoff probability while next week's
 * barely moves it — which is the difference between a week to burn your waiver
 * budget on and a week to save it.
 *
 * Leverage is measured the only way it can be honestly measured: simulate the
 * season twice, once with the game forced as a win and once as a loss, and take
 * the difference. Both runs share the same random draws, so the gap between
 * them is the game and nothing else.
 */

export interface GameLeverage {
  week: number
  opponentTeamId: string
  /** Playoff odds if this game is won, 0-1. */
  oddsIfWin: number
  /** Playoff odds if it is lost, 0-1. */
  oddsIfLose: number
  /** Percentage points of playoff probability riding on the result. */
  swing: number
  /** True when losing all but ends the season. */
  mustWin: boolean
}

export interface PlayoffPath {
  teamId: string
  playoffOdds: number
  gamesRemaining: number
  /**
   * Wins from here that make the playoffs a near-certainty (95%+), or null when
   * winning out still would not do it.
   */
  winsToClinch: number | null
  /** Wins from here below which it is all but over (5%-), or null. */
  winsToStayAlive: number | null
  /** Already through: winning zero more games still gets there. */
  clinched: boolean
  /** Already out: winning every remaining game still would not. */
  eliminated: boolean
  /** Ordered by how much each swings the season, most first. */
  games: GameLeverage[]
  summary: string
}

const SIMULATIONS = 4000
const CLINCH_THRESHOLD = 0.95
const ELIMINATION_THRESHOLD = 0.05

export function computePlayoffPath(snapshot: LeagueSnapshot, teamId: string): PlayoffPath {
  const forecasts = buildForecasts(snapshot)
  const games = remainingGames(snapshot)
  const gameCount = Math.max(1, games.length)
  const draws = new RandomBlock(SIMULATIONS * gameCount * 2 + 40_000, 0x1e7e4a9e)

  const odds = (forced?: SimulationForce[]): number => {
    const outcome = simulateSeason(snapshot, forecasts, {
      simulations: SIMULATIONS,
      draws,
      ...(forced ? { forcedResults: forced } : {}),
    })
    return outcome.makePlayoffs.get(teamId) ?? 0
  }

  const playoffOdds = odds()

  const mine = games.filter(
    (game) => game.homeTeamId === teamId || game.awayTeamId === teamId,
  )

  const leverage: GameLeverage[] = mine.map((game) => {
    const opponentTeamId = game.homeTeamId === teamId ? game.awayTeamId : game.homeTeamId
    const oddsIfWin = odds([{ week: game.week, winnerTeamId: teamId, loserTeamId: opponentTeamId }])
    const oddsIfLose = odds([{ week: game.week, winnerTeamId: opponentTeamId, loserTeamId: teamId }])

    return {
      week: game.week,
      opponentTeamId,
      oddsIfWin: round(oddsIfWin, 4),
      oddsIfLose: round(oddsIfLose, 4),
      swing: round((oddsIfWin - oddsIfLose) * 100, 1),
      mustWin: oddsIfLose < 0.1 && oddsIfWin > 0.25,
    }
  })

  // Sweeping out and losing out bound what is still possible.
  const winOut = mine.map((game) => ({
    week: game.week,
    winnerTeamId: teamId,
    loserTeamId: game.homeTeamId === teamId ? game.awayTeamId : game.homeTeamId,
  }))
  const loseOut = mine.map((game) => ({
    week: game.week,
    winnerTeamId: game.homeTeamId === teamId ? game.awayTeamId : game.homeTeamId,
    loserTeamId: teamId,
  }))

  const oddsWinningOut = mine.length > 0 ? odds(winOut) : playoffOdds
  const oddsLosingOut = mine.length > 0 ? odds(loseOut) : playoffOdds

  const clinched = oddsLosingOut >= CLINCH_THRESHOLD
  const eliminated = oddsWinningOut <= ELIMINATION_THRESHOLD

  const winsToClinch = findThreshold(
    snapshot, forecasts, draws, teamId, mine, CLINCH_THRESHOLD, true,
  )
  const winsToStayAlive = findThreshold(
    snapshot, forecasts, draws, teamId, mine, ELIMINATION_THRESHOLD, false,
  )

  return {
    teamId,
    playoffOdds: round(playoffOdds, 4),
    gamesRemaining: mine.length,
    winsToClinch,
    winsToStayAlive,
    clinched,
    eliminated,
    games: [...leverage].sort((a, b) => b.swing - a.swing),
    summary: summarise({
      playoffOdds, clinched, eliminated, winsToClinch, remaining: mine.length, leverage,
    }),
  }
}

interface SimulationForce {
  week: number
  winnerTeamId: string
  loserTeamId: string
}

/**
 * The fewest wins from here that pushes the odds past a threshold.
 *
 * Wins are assigned to the earliest games first. Which specific games are won
 * changes the answer slightly — beating a rival helps more than beating a team
 * already eliminated — but "you need three of your last five" is the shape of
 * the answer people actually want, and ordering by week keeps it stable.
 */
function findThreshold(
  snapshot: LeagueSnapshot,
  forecasts: ReturnType<typeof buildForecasts>,
  draws: RandomBlock,
  teamId: string,
  games: ReturnType<typeof remainingGames>,
  threshold: number,
  wantAbove: boolean,
): number | null {
  for (let wins = 0; wins <= games.length; wins += 1) {
    const forced: SimulationForce[] = games.map((game, index) => {
      const opponentTeamId = game.homeTeamId === teamId ? game.awayTeamId : game.homeTeamId
      const won = index < wins
      return {
        week: game.week,
        winnerTeamId: won ? teamId : opponentTeamId,
        loserTeamId: won ? opponentTeamId : teamId,
      }
    })

    const outcome = simulateSeason(snapshot, forecasts, {
      simulations: SIMULATIONS,
      draws,
      forcedResults: forced,
    })
    const odds = outcome.makePlayoffs.get(teamId) ?? 0

    if (wantAbove ? odds >= threshold : odds > threshold) return wins
  }
  return null
}

function summarise(input: {
  playoffOdds: number
  clinched: boolean
  eliminated: boolean
  winsToClinch: number | null
  remaining: number
  leverage: GameLeverage[]
}): string {
  if (input.remaining === 0) {
    return 'The regular season is over.'
  }
  if (input.clinched) {
    return 'You are in the playoffs regardless of how the rest of the regular season goes.'
  }
  if (input.eliminated) {
    return 'Winning every remaining game would still not be enough. This season is done.'
  }

  const biggest = [...input.leverage].sort((a, b) => b.swing - a.swing)[0]
  const games = `${input.remaining} game${input.remaining === 1 ? '' : 's'}`

  const needs =
    input.winsToClinch === null
      ? `Winning all ${games} still would not lock it up, so you need results elsewhere.`
      : input.winsToClinch === 0
        ? 'You are effectively through already.'
        : `Winning ${input.winsToClinch} of your last ${input.remaining} makes it close to certain.`

  const swing = biggest
    ? ` Week ${biggest.week} is the one that matters most: ${biggest.swing.toFixed(0)} points of playoff probability ride on it.`
    : ''

  return `${needs}${swing}`
}
