import type {
  LeagueAnalytics, LeagueSnapshot, LuckRating, Matchup, PlayoffOdds,
  PowerRanking, ScheduleStrength, TeamWeekScore,
} from '../../shared/types.js'
import {
  makeRng, mean, normalSample, round, scaleToPercent, scaleToPercentInverted, stdDev,
} from './stats.js'

/**
 * The analytics engine.
 *
 * Everything here is derived from the snapshot alone — no extra network calls,
 * no external projections. The goal is to answer the questions a league
 * actually argues about: who is genuinely good versus who has been lucky, whose
 * schedule is about to get hard, and what any of it does to the playoff picture.
 */

const DEFAULT_SIMULATIONS = 20_000

// --- Weekly scores ----------------------------------------------------------

/** Flatten matchups into one row per team per completed week. */
export function buildWeeklyScores(snapshot: LeagueSnapshot): TeamWeekScore[] {
  const scores: TeamWeekScore[] = []
  for (const matchup of snapshot.matchups) {
    if (!matchup.final) continue
    scores.push({
      teamId: matchup.home.teamId,
      week: matchup.week,
      points: matchup.home.score,
      opponentId: matchup.away.teamId,
      won: matchup.winnerTeamId === null ? null : matchup.winnerTeamId === matchup.home.teamId,
    })
    scores.push({
      teamId: matchup.away.teamId,
      week: matchup.week,
      points: matchup.away.score,
      opponentId: matchup.home.teamId,
      won: matchup.winnerTeamId === null ? null : matchup.winnerTeamId === matchup.away.teamId,
    })
  }
  return scores.sort((a, b) => a.week - b.week)
}

function scoresByTeam(weekly: TeamWeekScore[]): Map<string, number[]> {
  const map = new Map<string, number[]>()
  for (const row of weekly) {
    const list = map.get(row.teamId)
    if (list) list.push(row.points)
    else map.set(row.teamId, [row.points])
  }
  return map
}

// --- Power rankings ---------------------------------------------------------

const WEIGHTS = { scoring: 0.4, recentForm: 0.25, winRate: 0.2, consistency: 0.15 }
const RECENT_WEEKS = 3

/**
 * A composite ranking that weighs how much a team scores far more heavily than
 * its record, because points predict future wins and a 6-4 record built on
 * narrow escapes does not.
 *
 * Components are each scaled 0-100 across the league so the UI can show why a
 * team sits where it does rather than just asserting a number.
 */
export function computePowerRankings(snapshot: LeagueSnapshot): PowerRanking[] {
  const weekly = buildWeeklyScores(snapshot)
  const byTeam = scoresByTeam(weekly)
  const teams = snapshot.teams

  const avgPoints = teams.map((t) => mean(byTeam.get(t.id) ?? []))
  const volatility = teams.map((t) => stdDev(byTeam.get(t.id) ?? []))
  const recent = teams.map((t) => mean((byTeam.get(t.id) ?? []).slice(-RECENT_WEEKS)))
  const winPct = teams.map((t) => {
    const games = t.record.wins + t.record.losses + t.record.ties
    return games === 0 ? 0 : (t.record.wins + t.record.ties * 0.5) / games
  })

  const scoringScaled = scaleToPercent(avgPoints)
  // Low volatility is good: a consistent team is likelier to clear a given bar.
  const consistencyScaled = scaleToPercentInverted(volatility)
  const recentScaled = scaleToPercent(recent)
  const winScaled = scaleToPercent(winPct)

  const previous = computePreviousPowerScores(snapshot)

  const ranked = teams.map((team, i) => {
    const components = {
      scoring: round(scoringScaled[i] ?? 50, 1),
      consistency: round(consistencyScaled[i] ?? 50, 1),
      recentForm: round(recentScaled[i] ?? 50, 1),
      winRate: round(winScaled[i] ?? 50, 1),
    }
    const score =
      components.scoring * WEIGHTS.scoring +
      components.recentForm * WEIGHTS.recentForm +
      components.winRate * WEIGHTS.winRate +
      components.consistency * WEIGHTS.consistency

    return { teamId: team.id, rank: 0, score: round(score, 1), components, delta: null as number | null }
  })

  ranked.sort((a, b) => b.score - a.score)
  ranked.forEach((entry, i) => {
    entry.rank = i + 1
    const priorRank = previous.get(entry.teamId)
    // Positive delta means the team climbed.
    entry.delta = priorRank === undefined ? null : priorRank - entry.rank
  })

  return ranked
}

/**
 * Re-run the ranking as of last week so the current one can show movement.
 * Cheap enough to just recompute against a truncated snapshot.
 */
function computePreviousPowerScores(snapshot: LeagueSnapshot): Map<string, number> {
  const lastCompleted = Math.max(0, ...snapshot.matchups.filter((m) => m.final).map((m) => m.week))
  if (lastCompleted < 2) return new Map()

  const truncated: LeagueSnapshot = {
    ...snapshot,
    matchups: snapshot.matchups.filter((m) => m.week < lastCompleted),
    teams: snapshot.teams.map((team) => ({ ...team, record: recordThrough(snapshot, team.id, lastCompleted - 1) })),
  }

  const map = new Map<string, number>()
  // Guard against recursing: the truncated snapshot has fewer weeks each time,
  // and this call is made with matchups already filtered, so it terminates.
  for (const entry of computeRankingsWithoutDelta(truncated)) map.set(entry.teamId, entry.rank)
  return map
}

function computeRankingsWithoutDelta(snapshot: LeagueSnapshot): Array<{ teamId: string; rank: number }> {
  const weekly = buildWeeklyScores(snapshot)
  const byTeam = scoresByTeam(weekly)
  const teams = snapshot.teams

  const scoringScaled = scaleToPercent(teams.map((t) => mean(byTeam.get(t.id) ?? [])))
  const consistencyScaled = scaleToPercentInverted(teams.map((t) => stdDev(byTeam.get(t.id) ?? [])))
  const recentScaled = scaleToPercent(teams.map((t) => mean((byTeam.get(t.id) ?? []).slice(-RECENT_WEEKS))))
  const winScaled = scaleToPercent(
    teams.map((t) => {
      const games = t.record.wins + t.record.losses + t.record.ties
      return games === 0 ? 0 : (t.record.wins + t.record.ties * 0.5) / games
    }),
  )

  return teams
    .map((team, i) => ({
      teamId: team.id,
      score:
        (scoringScaled[i] ?? 50) * WEIGHTS.scoring +
        (recentScaled[i] ?? 50) * WEIGHTS.recentForm +
        (winScaled[i] ?? 50) * WEIGHTS.winRate +
        (consistencyScaled[i] ?? 50) * WEIGHTS.consistency,
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry, i) => ({ teamId: entry.teamId, rank: i + 1 }))
}

function recordThrough(snapshot: LeagueSnapshot, teamId: string, week: number) {
  let wins = 0
  let losses = 0
  let ties = 0
  for (const m of snapshot.matchups) {
    if (!m.final || m.week > week) continue
    const isHome = m.home.teamId === teamId
    const isAway = m.away.teamId === teamId
    if (!isHome && !isAway) continue
    if (m.winnerTeamId === null) ties += 1
    else if (m.winnerTeamId === teamId) wins += 1
    else losses += 1
  }
  return { wins, losses, ties }
}

// --- Luck -------------------------------------------------------------------

/**
 * All-play: what every team's record would be if it played the entire league
 * every week. It strips out schedule luck, and the gap between all-play and the
 * real record is the single most useful number in a fantasy league — it tells
 * you which contenders are frauds and which 4-6 team is about to ruin your
 * season.
 */
export function computeLuck(snapshot: LeagueSnapshot): LuckRating[] {
  const weekly = buildWeeklyScores(snapshot)
  const byWeek = new Map<number, TeamWeekScore[]>()
  for (const row of weekly) {
    const list = byWeek.get(row.week)
    if (list) list.push(row)
    else byWeek.set(row.week, [row])
  }

  const allPlay = new Map<string, { wins: number; losses: number; ties: number }>()
  for (const team of snapshot.teams) allPlay.set(team.id, { wins: 0, losses: 0, ties: 0 })

  for (const rows of byWeek.values()) {
    for (const row of rows) {
      const record = allPlay.get(row.teamId)
      if (!record) continue
      for (const other of rows) {
        if (other.teamId === row.teamId) continue
        if (row.points > other.points) record.wins += 1
        else if (row.points < other.points) record.losses += 1
        else record.ties += 1
      }
    }
  }

  return snapshot.teams.map((team) => {
    const record = allPlay.get(team.id) ?? { wins: 0, losses: 0, ties: 0 }
    const allPlayGames = record.wins + record.losses + record.ties
    const expectedWinPct = allPlayGames === 0 ? 0 : (record.wins + record.ties * 0.5) / allPlayGames

    const games = team.record.wins + team.record.losses + team.record.ties
    const actualWinPct = games === 0 ? 0 : (team.record.wins + team.record.ties * 0.5) / games

    return {
      teamId: team.id,
      allPlay: record,
      expectedWinPct: round(expectedWinPct, 4),
      actualWinPct: round(actualWinPct, 4),
      luckWins: round((actualWinPct - expectedWinPct) * games, 2),
    }
  })
}

// --- Schedule strength ------------------------------------------------------

export function computeScheduleStrength(snapshot: LeagueSnapshot): ScheduleStrength[] {
  const weekly = buildWeeklyScores(snapshot)
  const byTeam = scoresByTeam(weekly)
  const seasonAvg = new Map<string, number>()
  for (const team of snapshot.teams) seasonAvg.set(team.id, mean(byTeam.get(team.id) ?? []))

  const results = snapshot.teams.map((team) => {
    const past: number[] = []
    const future: number[] = []

    for (const matchup of snapshot.matchups) {
      const isHome = matchup.home.teamId === team.id
      const isAway = matchup.away.teamId === team.id
      if (!isHome && !isAway) continue
      const opponentId = isHome ? matchup.away.teamId : matchup.home.teamId
      const opponentAvg = seasonAvg.get(opponentId) ?? 0
      if (matchup.final) past.push(opponentAvg)
      else future.push(opponentAvg)
    }

    return {
      teamId: team.id,
      pastOpponentAvg: round(mean(past), 2),
      futureOpponentAvg: round(mean(future), 2),
      futureRank: 0,
    }
  })

  // Rank 1 = toughest remaining slate.
  ;[...results]
    .sort((a, b) => b.futureOpponentAvg - a.futureOpponentAvg)
    .forEach((entry, i) => {
      entry.futureRank = i + 1
    })

  return results
}

// --- Playoff odds -----------------------------------------------------------

interface TeamModel {
  id: string
  mu: number
  sigma: number
  wins: number
  losses: number
  ties: number
  pointsFor: number
}

/**
 * Shrink each team's scoring distribution toward the league average. With only
 * ten games played, a team's raw mean and spread are noisy; pulling them toward
 * the league keeps one 180-point explosion from convincing the simulation that
 * a mediocre team is a juggernaut.
 */
const SHRINK_GAMES = 4

function buildTeamModels(snapshot: LeagueSnapshot): TeamModel[] {
  const weekly = buildWeeklyScores(snapshot)
  const byTeam = scoresByTeam(weekly)

  const allScores = weekly.map((w) => w.points)
  const leagueMean = mean(allScores)
  const leagueSigma = stdDev(allScores) || 20

  return snapshot.teams.map((team) => {
    const scores = byTeam.get(team.id) ?? []
    const n = scores.length
    const weight = n / (n + SHRINK_GAMES)
    const rawMean = n > 0 ? mean(scores) : leagueMean
    const rawSigma = n > 1 ? stdDev(scores) : leagueSigma

    return {
      id: team.id,
      mu: weight * rawMean + (1 - weight) * leagueMean,
      sigma: Math.max(6, weight * rawSigma + (1 - weight) * leagueSigma),
      wins: team.record.wins,
      losses: team.record.losses,
      ties: team.record.ties,
      pointsFor: team.pointsFor,
    }
  })
}

export interface PlayoffOddsOptions {
  simulations?: number
  seed?: number
}

/**
 * Monte Carlo the rest of the season: simulate every remaining matchup from the
 * teams' scoring distributions, sort the final standings, then run a seeded
 * single-elimination bracket. Repeat a few tens of thousands of times.
 */
export function computePlayoffOdds(
  snapshot: LeagueSnapshot,
  opts: PlayoffOddsOptions = {},
): { odds: PlayoffOdds[]; simulations: number } {
  const simulations = opts.simulations ?? DEFAULT_SIMULATIONS
  const rng = makeRng(opts.seed ?? 0x5eed1234)
  const models = buildTeamModels(snapshot)
  const modelById = new Map(models.map((m) => [m.id, m]))

  const remaining = snapshot.matchups.filter(
    (m) => !m.final && m.week <= snapshot.league.regularSeasonWeeks && !m.isConsolation,
  )
  // Guard against a missing or nonsensical setting without overriding a real
  // one: fall back to 6 when it's absent, and never exceed the league size.
  const playoffSpots = Math.min(
    Math.max(snapshot.league.playoffTeams || 6, 1),
    snapshot.teams.length,
  )

  const madePlayoffs = new Map<string, number>()
  const topSeeds = new Map<string, number>()
  const titles = new Map<string, number>()
  const winTotals = new Map<string, number>()
  const seedTotals = new Map<string, number>()
  for (const team of snapshot.teams) {
    madePlayoffs.set(team.id, 0)
    topSeeds.set(team.id, 0)
    titles.set(team.id, 0)
    winTotals.set(team.id, 0)
    seedTotals.set(team.id, 0)
  }

  for (let sim = 0; sim < simulations; sim += 1) {
    const wins = new Map<string, number>()
    const points = new Map<string, number>()
    for (const model of models) {
      wins.set(model.id, model.wins + model.ties * 0.5)
      points.set(model.id, model.pointsFor)
    }

    for (const matchup of remaining) {
      const home = modelById.get(matchup.home.teamId)
      const away = modelById.get(matchup.away.teamId)
      if (!home || !away) continue

      const homeScore = Math.max(0, normalSample(rng, home.mu, home.sigma))
      const awayScore = Math.max(0, normalSample(rng, away.mu, away.sigma))
      points.set(home.id, (points.get(home.id) ?? 0) + homeScore)
      points.set(away.id, (points.get(away.id) ?? 0) + awayScore)

      if (homeScore > awayScore) wins.set(home.id, (wins.get(home.id) ?? 0) + 1)
      else if (awayScore > homeScore) wins.set(away.id, (wins.get(away.id) ?? 0) + 1)
      else {
        wins.set(home.id, (wins.get(home.id) ?? 0) + 0.5)
        wins.set(away.id, (wins.get(away.id) ?? 0) + 0.5)
      }
    }

    // Standings: wins, then points for as the tiebreak — the near-universal
    // fantasy convention.
    const standings = models
      .map((m) => ({ id: m.id, wins: wins.get(m.id) ?? 0, points: points.get(m.id) ?? 0 }))
      .sort((a, b) => b.wins - a.wins || b.points - a.points)

    standings.forEach((entry, i) => {
      winTotals.set(entry.id, (winTotals.get(entry.id) ?? 0) + entry.wins)
      seedTotals.set(entry.id, (seedTotals.get(entry.id) ?? 0) + i + 1)
      if (i < playoffSpots) madePlayoffs.set(entry.id, (madePlayoffs.get(entry.id) ?? 0) + 1)
    })
    const first = standings[0]
    if (first) topSeeds.set(first.id, (topSeeds.get(first.id) ?? 0) + 1)

    const champion = simulateBracket(
      standings.slice(0, playoffSpots).map((s) => s.id),
      modelById,
      rng,
    )
    if (champion) titles.set(champion, (titles.get(champion) ?? 0) + 1)
  }

  const odds: PlayoffOdds[] = snapshot.teams.map((team) => ({
    teamId: team.id,
    makePlayoffs: round((madePlayoffs.get(team.id) ?? 0) / simulations, 4),
    topSeed: round((topSeeds.get(team.id) ?? 0) / simulations, 4),
    winTitle: round((titles.get(team.id) ?? 0) / simulations, 4),
    projectedWins: round((winTotals.get(team.id) ?? 0) / simulations, 2),
    projectedSeed: round((seedTotals.get(team.id) ?? 0) / simulations, 2),
  }))

  return { odds, simulations }
}

/**
 * Seeded single-elimination bracket. When the field isn't a power of two, the
 * top seeds get first-round byes — which is how essentially every fantasy
 * league runs its playoffs.
 */
export function simulateBracket(
  seeds: string[],
  models: Map<string, TeamModel>,
  rng: () => number,
): string | undefined {
  if (seeds.length === 0) return undefined
  if (seeds.length === 1) return seeds[0]

  const bracketSize = 2 ** Math.ceil(Math.log2(seeds.length))
  const byes = bracketSize - seeds.length

  // Seeds 1..byes advance automatically; the rest play, highest vs lowest.
  let alive = seeds.slice(0, byes)
  const playIn = seeds.slice(byes)

  const roundWinners: string[] = []
  for (let i = 0; i < playIn.length / 2; i += 1) {
    const high = playIn[i]
    const low = playIn[playIn.length - 1 - i]
    if (!high || !low) continue
    roundWinners.push(playGame(high, low, models, rng))
  }
  alive = [...alive, ...roundWinners]

  while (alive.length > 1) {
    const next: string[] = []
    for (let i = 0; i < alive.length / 2; i += 1) {
      const high = alive[i]
      const low = alive[alive.length - 1 - i]
      if (!high || !low) continue
      next.push(playGame(high, low, models, rng))
    }
    alive = next
  }

  return alive[0]
}

function playGame(
  a: string,
  b: string,
  models: Map<string, TeamModel>,
  rng: () => number,
): string {
  const modelA = models.get(a)
  const modelB = models.get(b)
  if (!modelA) return b
  if (!modelB) return a
  const scoreA = normalSample(rng, modelA.mu, modelA.sigma)
  const scoreB = normalSample(rng, modelB.mu, modelB.sigma)
  // Ties in a real playoff go to the higher seed, which is `a` by construction.
  return scoreB > scoreA ? b : a
}

// --- Entry point ------------------------------------------------------------

export function computeAnalytics(
  snapshot: LeagueSnapshot,
  opts: PlayoffOddsOptions = {},
): LeagueAnalytics {
  const { odds, simulations } = computePlayoffOdds(snapshot, opts)
  return {
    powerRankings: computePowerRankings(snapshot),
    luck: computeLuck(snapshot),
    scheduleStrength: computeScheduleStrength(snapshot),
    playoffOdds: odds,
    weeklyScores: buildWeeklyScores(snapshot),
    simulations,
  }
}

export type { Matchup }
