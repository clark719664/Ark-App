import type { LeagueSnapshot, Player } from '../../shared/types.js'
import { bestLineup, resolveSlots } from './lineup.js'
import { buildTeamModels } from './index.js'
import { mean, RandomBlock, round, stdDev } from './stats.js'

/**
 * The forward-looking season simulator.
 *
 * The season-long odds model each team by how much it has scored *so far*. That
 * is the right basis for judging what has happened and the wrong basis for
 * projecting what is left: it cannot see that a team traded for a starting
 * running back last night, or that its quarterback is out for the year.
 *
 * So remaining games are simulated from the lineup each team can actually field
 * today, with the spread taken from how variable that team has been. That also
 * makes a question like "what would this trade do to my playoff odds" well
 * posed — change the roster, re-solve the lineup, re-run the season.
 *
 * Every scenario draws from a shared block of random numbers, so two runs that
 * differ only by a trade differ in their *results* only because of the trade.
 * Without that, a 2% swing would be indistinguishable from simulation noise.
 */

export interface TeamForecast {
  teamId: string
  /** Expected weekly score from here on. */
  mu: number
  /** Week-to-week spread. */
  sigma: number
  /** Wins banked so far, counting ties as a half. */
  wins: number
  pointsFor: number
  basis: 'lineup' | 'season-form'
}

const NEUTRAL_SCORE = 100
const NEUTRAL_SPREAD = 20

export function buildForecasts(snapshot: LeagueSnapshot): TeamForecast[] {
  const seasonModels = new Map(buildTeamModels(snapshot).map((m) => [m.id, m]))
  const week = snapshot.league.currentWeek

  return snapshot.teams.map((team) => {
    const season = seasonModels.get(team.id)
    const roster = snapshot.rosters[team.id] ?? []
    const players = roster
      .map((entry) => entry.player)
      .filter((player): player is Player => player !== null)

    const slots = resolveSlots(snapshot.league.rosterSlots, roster)
    const projected = players.length > 0 ? bestLineup(players, slots, week).total : 0

    const seasonMu = season?.mu ?? 0
    const sigma = season && season.sigma > 0 ? season.sigma : NEUTRAL_SPREAD

    return {
      teamId: team.id,
      mu: projected > 0 ? projected : seasonMu > 0 ? seasonMu : NEUTRAL_SCORE,
      sigma,
      wins: team.record.wins + team.record.ties * 0.5,
      pointsFor: team.pointsFor,
      basis: projected > 0 ? 'lineup' : 'season-form',
    }
  })
}

export interface RemainingGame {
  week: number
  homeTeamId: string
  awayTeamId: string
}

export function remainingGames(snapshot: LeagueSnapshot): RemainingGame[] {
  return snapshot.matchups
    .filter(
      (m) => !m.final && m.week <= snapshot.league.regularSeasonWeeks && !m.isConsolation,
    )
    .map((m) => ({ week: m.week, homeTeamId: m.home.teamId, awayTeamId: m.away.teamId }))
}

export interface SeasonOutcome {
  /** Probability of reaching the playoffs, by team id. */
  makePlayoffs: Map<string, number>
  topSeed: Map<string, number>
  winTitle: Map<string, number>
  projectedWins: Map<string, number>
  projectedSeed: Map<string, number>
  simulations: number
}

export interface SimulationOptions {
  simulations?: number
  /** Shared draws, so two scenarios can be compared without noise swamping them. */
  draws?: RandomBlock
  /** Force a game's result, for leverage questions like "if I win this week". */
  forcedResults?: Array<{ week: number; winnerTeamId: string; loserTeamId: string }>
}

const DEFAULT_SIMULATIONS = 20_000

/**
 * Draws are indexed rather than consumed in sequence.
 *
 * If two scenarios pulled from a stream, an extra draw in one would shift every
 * later value and destroy the pairing that makes them comparable. Indexing by
 * (simulation, game, side) keeps each team's draw in each game of each season
 * identical across scenarios.
 */
function drawIndex(sim: number, game: number, side: number, gameCount: number): number {
  return (sim * gameCount + game) * 2 + side
}

export function simulateSeason(
  snapshot: LeagueSnapshot,
  forecasts: TeamForecast[],
  opts: SimulationOptions = {},
): SeasonOutcome {
  const simulations = opts.simulations ?? DEFAULT_SIMULATIONS
  const games = remainingGames(snapshot)
  const byId = new Map(forecasts.map((f) => [f.teamId, f]))

  const draws =
    opts.draws ?? new RandomBlock(Math.max(1, simulations * Math.max(1, games.length) * 2), 0x5eed1234)

  const playoffSpots = Math.min(
    Math.max(snapshot.league.playoffTeams || 6, 1),
    snapshot.teams.length,
  )

  const forced = new Map<string, string>()
  for (const result of opts.forcedResults ?? []) {
    forced.set(`${result.week}:${result.winnerTeamId}:${result.loserTeamId}`, result.winnerTeamId)
    forced.set(`${result.week}:${result.loserTeamId}:${result.winnerTeamId}`, result.winnerTeamId)
  }

  const makePlayoffs = new Map<string, number>()
  const topSeed = new Map<string, number>()
  const winTitle = new Map<string, number>()
  const winTotals = new Map<string, number>()
  const seedTotals = new Map<string, number>()
  for (const forecast of forecasts) {
    makePlayoffs.set(forecast.teamId, 0)
    topSeed.set(forecast.teamId, 0)
    winTitle.set(forecast.teamId, 0)
    winTotals.set(forecast.teamId, 0)
    seedTotals.set(forecast.teamId, 0)
  }

  const wins = new Map<string, number>()
  const points = new Map<string, number>()

  for (let sim = 0; sim < simulations; sim += 1) {
    for (const forecast of forecasts) {
      wins.set(forecast.teamId, forecast.wins)
      points.set(forecast.teamId, forecast.pointsFor)
    }

    for (const [gameIndex, game] of games.entries()) {
      const home = byId.get(game.homeTeamId)
      const away = byId.get(game.awayTeamId)
      if (!home || !away) continue

      const homeScore = Math.max(
        0,
        home.mu + home.sigma * draws.at(drawIndex(sim, gameIndex, 0, games.length)),
      )
      const awayScore = Math.max(
        0,
        away.mu + away.sigma * draws.at(drawIndex(sim, gameIndex, 1, games.length)),
      )

      points.set(home.teamId, (points.get(home.teamId) ?? 0) + homeScore)
      points.set(away.teamId, (points.get(away.teamId) ?? 0) + awayScore)

      const override = forced.get(`${game.week}:${home.teamId}:${away.teamId}`)
      const homeWon = override ? override === home.teamId : homeScore > awayScore
      const tied = !override && homeScore === awayScore

      if (tied) {
        wins.set(home.teamId, (wins.get(home.teamId) ?? 0) + 0.5)
        wins.set(away.teamId, (wins.get(away.teamId) ?? 0) + 0.5)
      } else if (homeWon) {
        wins.set(home.teamId, (wins.get(home.teamId) ?? 0) + 1)
      } else {
        wins.set(away.teamId, (wins.get(away.teamId) ?? 0) + 1)
      }
    }

    const standings = forecasts
      .map((f) => ({ id: f.teamId, wins: wins.get(f.teamId) ?? 0, points: points.get(f.teamId) ?? 0 }))
      .sort((a, b) => b.wins - a.wins || b.points - a.points)

    standings.forEach((entry, i) => {
      winTotals.set(entry.id, (winTotals.get(entry.id) ?? 0) + entry.wins)
      seedTotals.set(entry.id, (seedTotals.get(entry.id) ?? 0) + i + 1)
      if (i < playoffSpots) makePlayoffs.set(entry.id, (makePlayoffs.get(entry.id) ?? 0) + 1)
    })

    const first = standings[0]
    if (first) topSeed.set(first.id, (topSeed.get(first.id) ?? 0) + 1)

    const champion = simulateBracket(
      standings.slice(0, playoffSpots).map((s) => s.id),
      byId,
      draws,
      sim,
      games.length,
    )
    if (champion) winTitle.set(champion, (winTitle.get(champion) ?? 0) + 1)
  }

  const toRate = (counts: Map<string, number>) =>
    new Map([...counts].map(([id, count]) => [id, count / simulations]))
  const toMean = (totals: Map<string, number>) =>
    new Map([...totals].map(([id, total]) => [id, total / simulations]))

  return {
    makePlayoffs: toRate(makePlayoffs),
    topSeed: toRate(topSeed),
    winTitle: toRate(winTitle),
    projectedWins: toMean(winTotals),
    projectedSeed: toMean(seedTotals),
    simulations,
  }
}

/**
 * Seeded single elimination, byes to the top seeds. Bracket draws are indexed
 * past the regular season block so they stay paired across scenarios too.
 */
function simulateBracket(
  seeds: string[],
  models: Map<string, TeamForecast>,
  draws: RandomBlock,
  sim: number,
  gameCount: number,
): string | undefined {
  if (seeds.length === 0) return undefined
  if (seeds.length === 1) return seeds[0]

  const bracketSize = 2 ** Math.ceil(Math.log2(seeds.length))
  const byes = bracketSize - seeds.length
  let round = 0
  let offset = 0

  const play = (a: string, b: string): string => {
    const modelA = models.get(a)
    const modelB = models.get(b)
    if (!modelA) return b
    if (!modelB) return a
    // Offset well past the regular-season draws for this simulation.
    const base = (sim * gameCount + gameCount + round * 8 + offset) * 2
    offset += 1
    const scoreA = modelA.mu + modelA.sigma * draws.at(base)
    const scoreB = modelB.mu + modelB.sigma * draws.at(base + 1)
    // A tie in a real playoff goes to the higher seed, which is `a`.
    return scoreB > scoreA ? b : a
  }

  let alive = seeds.slice(0, byes)
  const playIn = seeds.slice(byes)
  const firstRound: string[] = []
  for (let i = 0; i < playIn.length / 2; i += 1) {
    const high = playIn[i]
    const low = playIn[playIn.length - 1 - i]
    if (high && low) firstRound.push(play(high, low))
  }
  alive = [...alive, ...firstRound]

  while (alive.length > 1) {
    round += 1
    offset = 0
    const next: string[] = []
    for (let i = 0; i < alive.length / 2; i += 1) {
      const high = alive[i]
      const low = alive[alive.length - 1 - i]
      if (high && low) next.push(play(high, low))
    }
    alive = next
  }

  return alive[0]
}

/** Apply a roster change and re-forecast just the affected team. */
export function forecastWithRoster(
  snapshot: LeagueSnapshot,
  base: TeamForecast[],
  teamId: string,
  players: Player[],
): TeamForecast[] {
  const slots = resolveSlots(snapshot.league.rosterSlots, snapshot.rosters[teamId] ?? [])
  const projected = bestLineup(players, slots, snapshot.league.currentWeek).total

  return base.map((forecast) =>
    forecast.teamId === teamId && projected > 0
      ? { ...forecast, mu: projected, basis: 'lineup' as const }
      : forecast,
  )
}

/** Summary statistics for a league's remaining scoring, for display. */
export function forecastSummary(forecasts: TeamForecast[]): { mean: number; spread: number } {
  return {
    mean: round(mean(forecasts.map((f) => f.mu)), 1),
    spread: round(stdDev(forecasts.map((f) => f.mu)), 1),
  }
}
