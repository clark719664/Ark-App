import type { WeeklyStat } from '../load.js'

/**
 * How variable is a player's week, really?
 *
 * Ark's start/sit model needs a spread for every player, and until now it used
 * invented per-position constants — QB 0.34, RB 0.55, and so on — which were
 * plausible but unmeasured. Those numbers decide when the risk-aware lineup
 * fires, so guessing at them was the weakest link in the feature.
 *
 * This measures them from 26 seasons of weekly scoring. It also tests the
 * assumption underneath them: that spread is a fixed *fraction* of a player's
 * projection. If the relationship between a player's average and his standard
 * deviation is not proportional, a constant coefficient of variation is the
 * wrong model regardless of what value it is given.
 */

export interface PositionVolatility {
  position: string
  playerSeasons: number
  /** Median coefficient of variation across qualifying player-seasons. */
  medianCv: number
  meanCv: number
  /**
   * Linear fit of weekly standard deviation on weekly mean:
   *   sd ≈ intercept + slope × mean
   * A near-zero intercept would mean a constant CV is a fair model.
   */
  slope: number
  intercept: number
  /** How much of the variation in sd the fit explains. */
  rSquared: number
  /** Average weekly mean across the sample, for context. */
  averageMean: number
}

const MIN_GAMES = 8

interface PlayerSeason {
  position: string
  mean: number
  sd: number
  cv: number
  games: number
}

export function collectPlayerSeasons(stats: WeeklyStat[], positions: string[]): PlayerSeason[] {
  const grouped = new Map<string, number[]>()
  const positionOf = new Map<string, string>()

  for (const stat of stats) {
    if (!positions.includes(stat.position)) continue
    const key = `${stat.playerId}:${stat.season}`
    const scores = grouped.get(key)
    if (scores) scores.push(stat.fantasyPointsPpr)
    else grouped.set(key, [stat.fantasyPointsPpr])
    positionOf.set(key, stat.position)
  }

  const seasons: PlayerSeason[] = []
  for (const [key, scores] of grouped) {
    if (scores.length < MIN_GAMES) continue

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    // A player averaging under a point a game is noise, not a fantasy asset.
    if (mean < 1) continue

    const variance =
      scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (scores.length - 1)
    const sd = Math.sqrt(variance)

    seasons.push({
      position: positionOf.get(key) ?? 'UNKNOWN',
      mean,
      sd,
      cv: sd / mean,
      games: scores.length,
    })
  }

  return seasons
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

/** Ordinary least squares of y on x, with the fit quality. */
export function linearFit(
  points: Array<{ x: number; y: number }>,
): { slope: number; intercept: number; rSquared: number } {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0 }

  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n

  let covariance = 0
  let varianceX = 0
  for (const point of points) {
    covariance += (point.x - meanX) * (point.y - meanY)
    varianceX += (point.x - meanX) ** 2
  }

  const slope = varianceX === 0 ? 0 : covariance / varianceX
  const intercept = meanY - slope * meanX

  let residual = 0
  let total = 0
  for (const point of points) {
    const predicted = intercept + slope * point.x
    residual += (point.y - predicted) ** 2
    total += (point.y - meanY) ** 2
  }

  return { slope, intercept, rSquared: total === 0 ? 0 : 1 - residual / total }
}

export function measureVolatility(
  stats: WeeklyStat[],
  positions = ['QB', 'RB', 'WR', 'TE'],
): PositionVolatility[] {
  const seasons = collectPlayerSeasons(stats, positions)

  return positions.map((position) => {
    const group = seasons.filter((entry) => entry.position === position)
    const fit = linearFit(group.map((entry) => ({ x: entry.mean, y: entry.sd })))

    return {
      position,
      playerSeasons: group.length,
      medianCv: median(group.map((entry) => entry.cv)),
      meanCv: group.reduce((sum, entry) => sum + entry.cv, 0) / (group.length || 1),
      slope: fit.slope,
      intercept: fit.intercept,
      rSquared: fit.rSquared,
      averageMean: group.reduce((sum, entry) => sum + entry.mean, 0) / (group.length || 1),
    }
  })
}

/**
 * Volatility split by how much a player scores.
 *
 * If coefficient of variation falls as scoring rises, then a constant CV
 * overstates the spread of stars and understates the spread of marginal
 * starters — which is exactly backwards for a start/sit decision, since those
 * marginal players are the ones actually being compared.
 */
export interface VolatilityByTier {
  position: string
  tier: string
  lowerBound: number
  playerSeasons: number
  medianCv: number
}

export function measureVolatilityByTier(
  stats: WeeklyStat[],
  positions = ['QB', 'RB', 'WR', 'TE'],
): VolatilityByTier[] {
  const seasons = collectPlayerSeasons(stats, positions)
  const tiers = [
    { tier: 'elite (18+ ppg)', lowerBound: 18 },
    { tier: 'strong (12-18)', lowerBound: 12 },
    { tier: 'startable (7-12)', lowerBound: 7 },
    { tier: 'marginal (<7)', lowerBound: 0 },
  ]

  const rows: VolatilityByTier[] = []
  for (const position of positions) {
    const group = seasons.filter((entry) => entry.position === position)

    for (const [index, tier] of tiers.entries()) {
      const upper = index === 0 ? Infinity : (tiers[index - 1]?.lowerBound ?? Infinity)
      const bucket = group.filter(
        (entry) => entry.mean >= tier.lowerBound && entry.mean < upper,
      )
      if (bucket.length < 25) continue

      rows.push({
        position,
        tier: tier.tier,
        lowerBound: tier.lowerBound,
        playerSeasons: bucket.length,
        medianCv: median(bucket.map((entry) => entry.cv)),
      })
    }
  }

  return rows
}
