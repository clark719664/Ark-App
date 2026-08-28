import type { Player, PlayerPosition, RosterEntry } from '../../shared/types.js'
import { effectiveProjection, isUnavailable } from './lineup.js'
import { canFill, slotEligibility } from './slots.js'
import { probabilityOfWinning, round } from './stats.js'

/**
 * Risk-aware start/sit.
 *
 * Nearly every fantasy tool answers one question: which lineup scores the most
 * points on average? That is the wrong question in the two situations where the
 * decision is actually hard.
 *
 * Against a much stronger opponent, the average is irrelevant — you are going
 * to lose the average. You need an outcome in the tail, so you want the boom-or
 * bust player even at a cost in expected points. Against a much weaker one the
 * reverse holds: you are winning unless something goes wrong, so you want the
 * steady player and none of the variance.
 *
 * This is not a heuristic bolted on top. It falls directly out of
 *
 *     P(win) = Phi( (muYou - muThem) / sqrt(varYou + varThem) )
 *
 * When the numerator is negative, raising varYou raises P(win). When it is
 * positive, lowering varYou raises P(win). Maximising that expression rather
 * than muYou is the whole feature.
 */

/**
 * Measured weekly spread, from 26 seasons of nflverse data.
 *
 * These replace a set of invented per-position coefficients of variation. They
 * were wrong in two ways, and the second mattered more than the first.
 *
 * The values were too low — the guesses were QB 0.34, RB 0.55, WR 0.62,
 * TE 0.68 against measured medians of 0.51, 0.71, 0.70 and 0.75. But the shape
 * was wrong too. A constant coefficient of variation assumes spread is
 * proportional to a player's average, which forces the fit through the origin.
 * The data says otherwise: every position has a large positive intercept, and
 * for quarterbacks it dominates.
 *
 * The practical consequence is that volatility tracks how much a player scores
 * far more than it tracks what position he plays. A marginal quarterback's
 * coefficient of variation is 1.10 against an elite one's 0.38 — a wider gap
 * than any two positions — and the old model could not represent that at all.
 *
 * Rebuild with `npm run data:fetch && npm run data:analyse`.
 */
interface SpreadModel {
  intercept: number
  slope: number
}

const MEASURED_SPREAD: Record<string, SpreadModel> = {
  QB: { intercept: 5.26, slope: 0.131 },
  RB: { intercept: 2.77, slope: 0.349 },
  WR: { intercept: 2.4, slope: 0.401 },
  TE: { intercept: 1.58, slope: 0.47 },
}

/**
 * Kickers and defenses are not in the fitted sample — nflverse does not carry
 * weekly team-defense scoring in the player table — so they keep a
 * conservative constant, wider than any measured position.
 */
const FALLBACK_SPREAD: SpreadModel = { intercept: 3.0, slope: 0.45 }

/** Even a projected-zero player is not a certainty. */
const MINIMUM_SPREAD = 1.5

export function spreadModelFor(position: PlayerPosition): SpreadModel {
  return MEASURED_SPREAD[position] ?? FALLBACK_SPREAD
}

/**
 * Implied coefficient of variation at a given projection. Kept because it is
 * the intuitive way to talk about volatility, even though the model itself is
 * not a constant ratio.
 */
export function playerVolatility(position: PlayerPosition, projection = 12): number {
  return playerSpread({ position } as Player, projection) / Math.max(projection, 1)
}

/** Standard deviation of a single player's week. */
export function playerSpread(player: Player, projection: number): number {
  const model = spreadModelFor(player.position)
  return Math.max(MINIMUM_SPREAD, model.intercept + model.slope * Math.max(0, projection))
}

export interface LineupDistribution {
  mean: number
  variance: number
  /** Square root of variance, for display. */
  spread: number
}

/**
 * Player weeks are treated as independent. That slightly understates variance
 * for a stacked lineup — a quarterback and his own receiver boom together — so
 * the true spread is a little wider than this. It does not change which lineup
 * wins the comparison unless two candidates differ in stacking, which is a
 * refinement worth making only once real game logs exist.
 */
export function lineupDistribution(
  players: Array<{ player: Player; projection: number }>,
): LineupDistribution {
  let mean = 0
  let variance = 0
  for (const { player, projection } of players) {
    mean += projection
    variance += playerSpread(player, projection) ** 2
  }
  return { mean, variance, spread: Math.sqrt(variance) }
}

export interface RiskLineupSlot {
  slot: string
  player: Player | null
  projection: number
}

export interface RiskLineup {
  assignments: RiskLineupSlot[]
  mean: number
  spread: number
  winProbability: number
}

export interface OpponentModel {
  mean: number
  spread: number
}

export interface RiskAnalysis {
  /** The lineup with the highest expected points. */
  byPoints: RiskLineup
  /** The lineup with the highest chance of winning this week. */
  byWinProbability: RiskLineup
  /** True when chasing points and chasing the win disagree. */
  differ: boolean
  /** Percentage points of win probability gained by the risk-aware lineup. */
  winProbabilityGain: number
  /** Expected points given up to get it. */
  pointsGivenUp: number
  /** "underdog" wants variance, "favourite" wants none, "even" is indifferent. */
  posture: 'underdog' | 'favourite' | 'even'
  /** The swaps that turn the points lineup into the win-probability lineup. */
  moves: Array<{ slot: string; out: Player; in: Player; reason: string }>
  opponent: OpponentModel
}

interface Candidate {
  player: Player
  projection: number
}

/**
 * Search for the lineup that maximises win probability.
 *
 * Starting from the points-optimal lineup, repeatedly take the single
 * substitution that most improves P(win) until none does. Each evaluation is
 * closed form, so this is cheap; it is a local search rather than an exhaustive
 * one, and in practice the two agree because win probability is monotone in
 * each slot given the others.
 */
export function analyseLineupRisk(
  roster: RosterEntry[],
  slots: string[],
  opponent: OpponentModel,
  currentWeek?: number,
): RiskAnalysis {
  const available: Candidate[] = roster
    .filter((entry) => entry.player !== null)
    .map((entry) => ({
      player: entry.player!,
      projection: effectiveProjection(entry.player, entry, currentWeek),
    }))
    .filter((candidate) => !isUnavailable(candidate.player, currentWeek))

  const byPointsAssignments = assignByPoints(available, slots)
  const byPoints = describe(byPointsAssignments, opponent)

  let best = byPointsAssignments
  let bestProbability = byPoints.winProbability

  // Hill climb on single substitutions.
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const startingIds = new Set(
      best.map((a) => a.player?.id).filter((id): id is string => id !== undefined),
    )
    const bench = available.filter((candidate) => !startingIds.has(candidate.player.id))

    let improvement: { assignments: RiskLineupSlot[]; probability: number } | null = null

    for (const [index, assignment] of best.entries()) {
      for (const candidate of bench) {
        if (!canFill(assignment.slot, candidate.player.position, candidate.player.eligiblePositions)) {
          continue
        }
        const trial = [...best]
        trial[index] = {
          slot: assignment.slot,
          player: candidate.player,
          projection: candidate.projection,
        }
        const probability = describe(trial, opponent).winProbability
        if (probability > bestProbability + 1e-9 && (!improvement || probability > improvement.probability)) {
          improvement = { assignments: trial, probability }
        }
      }
    }

    if (!improvement) break
    best = improvement.assignments
    bestProbability = improvement.probability
  }

  const byWinProbability = describe(best, opponent)
  const margin = byPoints.mean - opponent.mean
  const posture: RiskAnalysis['posture'] =
    margin < -5 ? 'underdog' : margin > 5 ? 'favourite' : 'even'

  return {
    byPoints,
    byWinProbability,
    differ: byWinProbability.winProbability > byPoints.winProbability + 1e-6,
    winProbabilityGain: round((byWinProbability.winProbability - byPoints.winProbability) * 100, 1),
    pointsGivenUp: round(byPoints.mean - byWinProbability.mean, 1),
    posture,
    moves: describeMoves(byPointsAssignments, best, posture),
    opponent,
  }
}

/** Most restrictive slot first, exactly as the points-optimal solver does. */
function assignByPoints(available: Candidate[], slots: string[]): RiskLineupSlot[] {
  const ordered = slots
    .map((slot, index) => ({ slot, index, width: slotEligibility(slot)?.length ?? 99 }))
    .sort((a, b) => a.width - b.width || a.index - b.index)

  const used = new Set<string>()
  const assignments = new Map<number, Candidate>()

  for (const { slot, index } of ordered) {
    const best = available
      .filter(
        (candidate) =>
          !used.has(candidate.player.id) &&
          canFill(slot, candidate.player.position, candidate.player.eligiblePositions),
      )
      .sort((a, b) => b.projection - a.projection)[0]
    if (best) {
      used.add(best.player.id)
      assignments.set(index, best)
    }
  }

  return slots.map((slot, index) => {
    const assigned = assignments.get(index)
    return {
      slot,
      player: assigned?.player ?? null,
      projection: assigned?.projection ?? 0,
    }
  })
}

function describe(assignments: RiskLineupSlot[], opponent: OpponentModel): RiskLineup {
  const filled = assignments
    .filter((a): a is RiskLineupSlot & { player: Player } => a.player !== null)
    .map((a) => ({ player: a.player, projection: a.projection }))

  const distribution = lineupDistribution(filled)
  const winProbability = probabilityOfWinning(
    distribution.mean,
    distribution.variance,
    opponent.mean,
    opponent.spread ** 2,
  )

  return {
    assignments,
    mean: round(distribution.mean, 1),
    spread: round(distribution.spread, 1),
    winProbability: round(winProbability, 4),
  }
}

function describeMoves(
  from: RiskLineupSlot[],
  to: RiskLineupSlot[],
  posture: RiskAnalysis['posture'],
): RiskAnalysis['moves'] {
  const moves: RiskAnalysis['moves'] = []

  for (const [index, after] of to.entries()) {
    const before = from[index]
    if (!before || !after.player || !before.player) continue
    if (before.player.id === after.player.id) continue

    const outSpread = playerSpread(before.player, before.projection)
    const inSpread = playerSpread(after.player, after.projection)
    const riskier = inSpread > outSpread

    moves.push({
      slot: after.slot,
      out: before.player,
      in: after.player,
      reason:
        posture === 'underdog'
          ? `You need an outlier to win, and ${after.player.name} has the wider range of outcomes`
          : posture === 'favourite'
            ? `You win this unless something goes wrong, and ${after.player.name} is the steadier week`
            : riskier
              ? `${after.player.name} gives you more upside for a similar projection`
              : `${after.player.name} is the safer week for a similar projection`,
    })
  }

  return moves
}
