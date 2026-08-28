import type { WeeklyStat } from '../load.js'
import { linearFit } from './volatility.js'

/**
 * How much of a hot streak is real?
 *
 * Ark's buy-low and sell-high signals fire when a player's recent form pulls
 * away from his season baseline by more than 35%. That threshold was chosen by
 * eye. What actually matters is a number nobody had measured here: given that a
 * player has just outscored his own baseline by some amount, how much of that
 * gap survives into the following weeks?
 *
 * If the answer is near zero, a hot streak is noise and the right move is to
 * sell into it. If it is near one, the streak is information about a changed
 * role and selling is a mistake. The honest version of the feature needs the
 * real coefficient, because it decides whether the advice is "trade him" or
 * "he is actually this good now".
 */

export interface PersistenceResult {
  position: string
  observations: number
  /**
   * Fraction of a deviation from baseline that persists into the next weeks.
   * 0 means pure noise, 1 means fully real.
   */
  persistence: number
  rSquared: number
  /** How far recent form typically strays from baseline, in points per game. */
  medianAbsoluteDeviation: number
  /** Persistence measured only on the large swings that trigger the signal. */
  persistenceOnBigSwings: number
  bigSwingObservations: number
}

const RECENT_WINDOW = 3
const FUTURE_WINDOW = 3
const MIN_BASELINE_GAMES = 4

interface Observation {
  position: string
  deviation: number
  futureDeviation: number
  baseline: number
}

export function collectObservations(
  stats: WeeklyStat[],
  positions: string[],
): Observation[] {
  // Group each player's season into an ordered list of weekly scores.
  const bySeason = new Map<string, WeeklyStat[]>()
  for (const stat of stats) {
    if (!positions.includes(stat.position)) continue
    const key = `${stat.playerId}:${stat.season}`
    const list = bySeason.get(key)
    if (list) list.push(stat)
    else bySeason.set(key, [stat])
  }

  const observations: Observation[] = []

  for (const games of bySeason.values()) {
    const ordered = [...games].sort((a, b) => a.week - b.week)
    if (ordered.length < MIN_BASELINE_GAMES + RECENT_WINDOW + FUTURE_WINDOW) continue

    for (
      let cut = MIN_BASELINE_GAMES + RECENT_WINDOW;
      cut + FUTURE_WINDOW <= ordered.length;
      cut += 1
    ) {
      const baselineGames = ordered.slice(0, cut - RECENT_WINDOW)
      const recentGames = ordered.slice(cut - RECENT_WINDOW, cut)
      const futureGames = ordered.slice(cut, cut + FUTURE_WINDOW)

      const baseline = average(baselineGames)
      // A baseline near zero makes the deviation ratio meaningless.
      if (baseline < 3) continue

      observations.push({
        position: ordered[0]!.position,
        deviation: average(recentGames) - baseline,
        futureDeviation: average(futureGames) - baseline,
        baseline,
      })
    }
  }

  return observations
}

function average(games: WeeklyStat[]): number {
  if (games.length === 0) return 0
  return games.reduce((sum, game) => sum + game.fantasyPointsPpr, 0) / games.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

export function measurePersistence(
  stats: WeeklyStat[],
  positions = ['QB', 'RB', 'WR', 'TE'],
): PersistenceResult[] {
  const all = collectObservations(stats, positions)

  return positions.map((position) => {
    const group = all.filter((entry) => entry.position === position)
    const fit = linearFit(
      group.map((entry) => ({ x: entry.deviation, y: entry.futureDeviation })),
    )

    // The signal only fires on large swings, so measure those separately —
    // persistence at the extremes need not match persistence on average.
    const big = group.filter((entry) => Math.abs(entry.deviation) > entry.baseline * 0.35)
    const bigFit = linearFit(big.map((entry) => ({ x: entry.deviation, y: entry.futureDeviation })))

    return {
      position,
      observations: group.length,
      persistence: fit.slope,
      rSquared: fit.rSquared,
      medianAbsoluteDeviation: median(group.map((entry) => Math.abs(entry.deviation))),
      persistenceOnBigSwings: bigFit.slope,
      bigSwingObservations: big.length,
    }
  })
}

/**
 * Persistence split by direction.
 *
 * Hot and cold streaks need not behave the same way. A cold stretch can mean a
 * lost role, which persists; a hot stretch is more often a touchdown or two
 * that will not repeat. If they differ, buy-low and sell-high deserve different
 * thresholds rather than one symmetric rule.
 */
export interface DirectionalPersistence {
  direction: 'hot' | 'cold'
  observations: number
  persistence: number
  /** Average of what actually happened next, in points per game vs baseline. */
  averageFollowThrough: number
}

export function measureDirectionalPersistence(
  stats: WeeklyStat[],
  positions = ['QB', 'RB', 'WR', 'TE'],
): DirectionalPersistence[] {
  const all = collectObservations(stats, positions)
  const threshold = 0.35

  const build = (direction: 'hot' | 'cold'): DirectionalPersistence => {
    const group = all.filter((entry) =>
      direction === 'hot'
        ? entry.deviation > entry.baseline * threshold
        : entry.deviation < -entry.baseline * threshold,
    )
    const fit = linearFit(group.map((entry) => ({ x: entry.deviation, y: entry.futureDeviation })))

    return {
      direction,
      observations: group.length,
      persistence: fit.slope,
      averageFollowThrough:
        group.reduce((sum, entry) => sum + entry.futureDeviation, 0) / (group.length || 1),
    }
  }

  return [build('hot'), build('cold')]
}
