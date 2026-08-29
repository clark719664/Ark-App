import {
  loadLatestDepthChart, loadSeasonProduction, loadSeasonRoster,
  type RosteredPlayer, type SeasonProduction,
} from './pool.js'
import { loadTeamDefense, summariseDefenses } from './defense.js'
import { loadLeagueScoring } from './scoring.js'
import {
  loadDraftClass,
  measureRookieCurve,
  rookieBaseline,
  rookieKey,
  type RookieCurve,
} from './rookies.js'

/**
 * Projecting a season for every player on an NFL roster.
 *
 * The model is deliberately simple and every step is stated, because a draft
 * board that cannot explain a ranking is worse than a printed cheat sheet.
 *
 *   1. Blend the last three seasons of per-game production, weighting recent
 *      seasons more and weighting by games played, so eight good games count
 *      for less than sixteen.
 *   2. Regress toward replacement level by how little evidence there is. A
 *      rookie or a player with four career games should not be projected from
 *      those four games.
 *   3. Apply the measured age curve for the position — the same within-player
 *      year-over-year deltas in data/derived/football.json, which show running
 *      backs declining from 25 and receivers from 27.
 *   4. Adjust for depth chart position, which is the only signal here that can
 *      see a changed role before it shows up in production.
 *
 * What it does not know: target competition, scheme, coaching changes, holdouts,
 * or anything a beat reporter said this week. Treat a large disagreement with
 * consensus as a prompt to look, not as an edge.
 */

export interface ProjectedPlayer {
  playerId: string
  name: string
  position: string
  team: string
  age: number | null
  /** Projected PPR points per game. */
  projectedPpg: number
  /** Projected points across a 17 game season, adjusted for expected availability. */
  projectedSeason: number
  depthRank: number | null
  /** Seasons of real production behind the projection. */
  seasonsOfData: number
  gamesOfData: number
  lastSeasonPpg: number | null
  /** How the projection was arrived at, for display. */
  basis: 'production' | 'thin-history' | 'no-history'
  notes: string[]
}

/** Replacement level per position, in PPR points per game. */
const REPLACEMENT: Record<string, number> = {
  QB: 11,
  RB: 5,
  WR: 5,
  TE: 3.5,
  K: 7,
  DEF: 5,
}

/** Season weights, most recent first. */
const SEASON_WEIGHTS = [1, 0.55, 0.28]

/** Games of evidence at which a player's own production is trusted fully. */
const CONFIDENCE_GAMES = 20

/**
 * Median year-over-year change by position and age, measured within player.
 * Mirrors data/derived/football.json; kept inline so the draft tools work
 * without loading the whole derived file.
 */
const AGE_DELTA: Record<string, Record<number, number>> = {
  RB: { 22: 0.8, 23: 1.2, 24: 0.0, 25: -0.1, 26: -0.5, 27: -0.5, 28: -1.1, 29: -0.9, 30: -1.1, 31: -1.3, 32: -1.6, 33: -1.7 },
  WR: { 22: 2.3, 23: 1.4, 24: 0.1, 25: 0.4, 26: 0.0, 27: -0.7, 28: -1.0, 29: -1.1, 30: -1.2, 31: -1.3, 32: -1.9, 33: -1.6, 34: -1.6 },
  TE: { 22: 2.6, 23: 1.3, 24: 0.5, 25: 0.3, 26: -0.1, 27: -0.2, 28: -0.3, 29: 0.0, 30: -0.5, 31: -1.1, 32: -0.2, 33: -0.4, 34: 0.0 },
  QB: { 22: 8.2, 23: 1.0, 24: 0.0, 25: 1.1, 26: -0.4, 27: -0.4, 28: 1.1, 29: -0.9, 30: 0.1, 31: -0.4, 32: -1.0, 33: -0.3, 34: -0.8 },
}

/**
 * Depth chart multipliers. A back-up's recent production already reflects a
 * back-up's snaps, so these correct for a *changed* role rather than restating
 * the current one — hence they are mild.
 */
const DEPTH_MULTIPLIER: Record<string, number[]> = {
  QB: [1.0, 0.25, 0.08],
  RB: [1.0, 0.62, 0.32],
  WR: [1.0, 0.86, 0.66],
  TE: [1.0, 0.45, 0.22],
}

const FANTASY_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K']

function ageAdjustment(position: string, age: number | null): number {
  if (age === null) return 0
  const curve = AGE_DELTA[position]
  if (!curve) return 0

  const rounded = Math.round(age)
  const ages = Object.keys(curve).map(Number)
  const lowest = Math.min(...ages)
  const highest = Math.max(...ages)

  if (rounded <= lowest) return curve[lowest] ?? 0
  // Beyond the measured range the decline continues rather than stopping.
  if (rounded > highest) return curve[highest] ?? 0
  return curve[rounded] ?? 0
}

function depthMultiplier(position: string, rank: number | null): number {
  if (rank === null) return 1
  const ladder = DEPTH_MULTIPLIER[position]
  if (!ladder) return 1
  return ladder[Math.min(rank, ladder.length) - 1] ?? ladder[ladder.length - 1] ?? 1
}

export interface ProjectionOptions {
  season: number
  /** Seasons of history to draw on, most recent first. */
  history?: number[]
}

/**
 * Project each team's defence.
 *
 * Defences are far less persistent year to year than skill players — a unit
 * carried by a takeaway rate that will not repeat looks elite in hindsight — so
 * this regresses harder toward the league average than the player model does.
 */
export function projectDefenses(opts: ProjectionOptions): ProjectedPlayer[] {
  const history = opts.history ?? [opts.season - 1, opts.season - 2, opts.season - 3]
  const seasons = summariseDefenses(loadTeamDefense(history))
  if (seasons.length === 0) return []

  const leagueAverage =
    seasons.reduce((sum, entry) => sum + entry.pointsPerGame, 0) / seasons.length

  const byTeam = new Map<string, typeof seasons>()
  for (const entry of seasons) {
    const list = byTeam.get(entry.team)
    if (list) list.push(entry)
    else byTeam.set(entry.team, [entry])
  }

  const projections: ProjectedPlayer[] = []

  for (const [team, entries] of byTeam) {
    let weighted = 0
    let weightSum = 0
    let games = 0

    for (const [index, season] of history.entries()) {
      const row = entries.find((entry) => entry.season === season)
      if (!row) continue
      const weight = (SEASON_WEIGHTS[index] ?? 0.1) * Math.min(row.games, 17)
      weighted += row.pointsPerGame * weight
      weightSum += weight
      games += row.games
    }

    const observed = weightSum > 0 ? weighted / weightSum : leagueAverage
    // Defence regresses hard: half of a good season is noise that will not repeat.
    const confidence = Math.min(0.55, games / 34)
    const projected = confidence * observed + (1 - confidence) * leagueAverage

    const latest = entries.find((entry) => entry.season === history[0])
    const notes = [
      'Defences regress hard year to year, so this is pulled well toward the league average',
    ]
    if (latest) {
      notes.push(
        `${latest.sacksPerGame.toFixed(1)} sacks and ${latest.takeawaysPerGame.toFixed(1)} takeaways ` +
          `a game last season, allowing ${latest.pointsAllowedPerGame.toFixed(1)}`,
      )
    }

    projections.push({
      playerId: `DEF-${team}`,
      name: `${team} Defense`,
      position: 'DEF',
      team,
      age: null,
      projectedPpg: round(projected, 2),
      projectedSeason: round(projected * 16, 1),
      depthRank: null,
      seasonsOfData: entries.length,
      gamesOfData: games,
      lastSeasonPpg: latest ? round(latest.pointsPerGame, 2) : null,
      basis: games > 0 ? 'production' : 'no-history',
      notes,
    })
  }

  return projections
}

export function buildProjections(opts: ProjectionOptions): ProjectedPlayer[] {
  const history = opts.history ?? [opts.season - 1, opts.season - 2, opts.season - 3]
  const roster = loadSeasonRoster(opts.season)
  const production = loadSeasonProduction(history)
  const depthChart = loadLatestDepthChart(opts.season)
  const draftClass = loadDraftClass(opts.season)
  const rookieCurve = measureRookieCurve(loadLeagueScoring().scoring, opts.season - 1)

  const byPlayer = new Map<string, SeasonProduction[]>()
  for (const row of production) {
    const list = byPlayer.get(row.playerId)
    if (list) list.push(row)
    else byPlayer.set(row.playerId, [row])
  }

  const projections: ProjectedPlayer[] = []

  for (const player of roster) {
    if (!FANTASY_POSITIONS.includes(player.position)) continue
    if (player.status !== 'ACT') continue

    const pick = draftClass.get(rookieKey(player.name, player.position)) ?? null
    projections.push(
      projectOne(
        player,
        byPlayer.get(player.playerId) ?? [],
        depthChart.get(player.playerId)?.rank ?? null,
        history,
        pick,
        rookieCurve,
      ),
    )
  }

  projections.push(...projectDefenses(opts))

  return projections.sort((a, b) => b.projectedSeason - a.projectedSeason)
}

function projectOne(
  player: RosteredPlayer,
  seasons: SeasonProduction[],
  depthRank: number | null,
  history: number[],
  rookiePick: number | null = null,
  curve: RookieCurve | null = null,
): ProjectedPlayer {
  const notes: string[] = []

  // A player with no snaps is priced at replacement unless the NFL draft says
  // otherwise. Where it does, that is the only forecast of his role available.
  const drafted =
    rookiePick !== null && curve !== null
      ? rookieBaseline(curve, player.position, rookiePick)
      : null
  const replacement = drafted ?? REPLACEMENT[player.position] ?? 5

  // Weighted blend of recent per-game production.
  let weightedPoints = 0
  let weightSum = 0
  let totalGames = 0

  for (const [index, season] of history.entries()) {
    const row = seasons.find((entry) => entry.season === season)
    if (!row || row.games === 0) continue

    // Weight by recency and by how many games back the number.
    const weight = (SEASON_WEIGHTS[index] ?? 0.1) * Math.min(row.games, 17)
    weightedPoints += row.pointsPerGame * weight
    weightSum += weight
    totalGames += row.games
  }

  const observed = weightSum > 0 ? weightedPoints / weightSum : replacement
  const lastSeason = seasons.find((entry) => entry.season === history[0])

  // Regress toward replacement by how thin the evidence is.
  const confidence = Math.min(1, totalGames / CONFIDENCE_GAMES)
  let projected = confidence * observed + (1 - confidence) * replacement

  const basis: ProjectedPlayer['basis'] =
    totalGames === 0 ? 'no-history' : totalGames < 10 ? 'thin-history' : 'production'

  if (basis === 'no-history' && drafted !== null && rookiePick !== null) {
    notes.push(
      `Rookie, no NFL snaps: valued from draft capital (pick ${rookiePick}), where ` +
        `players at this position have averaged ${drafted.toFixed(1)} a game`,
    )
  } else if (basis === 'no-history') {
  } else if (basis === 'thin-history') {
    notes.push(`Only ${totalGames} career games, so heavily regressed toward replacement`)
  }

  // Age curve.
  const adjustment = ageAdjustment(player.position, player.age)
  if (adjustment !== 0 && basis === 'production') {
    projected += adjustment
    if (adjustment <= -0.9) {
      notes.push(
        `Age ${Math.round(player.age ?? 0)}: players at this position typically lose ` +
          `${Math.abs(adjustment).toFixed(1)} points a game year over year from here`,
      )
    } else if (adjustment >= 0.8) {
      notes.push(`Age ${Math.round(player.age ?? 0)}: still on the improving part of the curve`)
    }
  }

  // Depth chart.
  const multiplier = depthMultiplier(player.position, depthRank)
  if (multiplier < 1) {
    projected *= multiplier
    notes.push(`Listed ${ordinal(depthRank ?? 2)} on the depth chart at ${player.position}`)
  }

  projected = Math.max(0, projected)

  // Availability: nobody plays all seventeen, and the deeper a player is on the
  // chart the more his season total depends on someone ahead of him getting hurt.
  const expectedGames = depthRank !== null && depthRank > 1 ? 14 : 15.5

  return {
    playerId: player.playerId,
    name: player.name,
    position: player.position,
    team: player.team,
    age: player.age === null ? null : Math.round(player.age * 10) / 10,
    projectedPpg: round(projected, 2),
    projectedSeason: round(projected * expectedGames, 1),
    depthRank,
    seasonsOfData: seasons.length,
    gamesOfData: totalGames,
    lastSeasonPpg: lastSeason ? round(lastSeason.pointsPerGame, 2) : null,
    basis,
    notes,
  }
}

function ordinal(value: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd']
  const remainder = value % 100
  return `${value}${suffixes[(remainder - 20) % 10] ?? suffixes[remainder] ?? suffixes[0]}`
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
