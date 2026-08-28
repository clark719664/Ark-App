import type { InjuryReport, WeeklyStat } from '../load.js'

/**
 * What a player is worth when he comes back.
 *
 * Ark currently treats a returning player as though the injury never happened:
 * once he is off the report he is valued at his projection like anyone else.
 * That is obviously too generous for someone back from six weeks out, and
 * probably too harsh for someone who missed one. This measures the real gap.
 */

export interface ReturnProfile {
  /** How many games the player missed. */
  weeksMissed: number
  returns: number
  /** Points per game in the three games before the injury. */
  beforePpg: number
  /** Points per game in the first game back. */
  firstGameBackPpg: number
  /** Points per game across the first three games back. */
  firstThreeBackPpg: number
  /** First game back as a fraction of pre-injury form. */
  firstGameRatio: number
  /** First three games back as a fraction of pre-injury form. */
  firstThreeRatio: number
}

export interface InjuryTypeProfile {
  injury: string
  returns: number
  medianWeeksMissed: number
  firstThreeRatio: number
}

const WINDOW = 3

interface Absence {
  playerId: string
  season: number
  position: string
  injury: string
  lastWeekBefore: number
  firstWeekBack: number
  weeksMissed: number
}

/**
 * Find absences from the weekly stats themselves rather than from the injury
 * report. A player who is out does not appear in the stats at all, so a gap in
 * his weeks is the reliable signal; the injury report then names the cause.
 */
export function findAbsences(
  stats: WeeklyStat[],
  reports: InjuryReport[],
  positions: string[],
): Absence[] {
  const bySeason = new Map<string, WeeklyStat[]>()
  for (const stat of stats) {
    if (!positions.includes(stat.position)) continue
    const key = `${stat.playerId}:${stat.season}`
    const list = bySeason.get(key)
    if (list) list.push(stat)
    else bySeason.set(key, [stat])
  }

  // Injury cause, keyed by player-season-week of the report.
  const causes = new Map<string, string>()
  for (const report of reports) {
    if (!report.primaryInjury) continue
    causes.set(`${report.playerId}:${report.season}:${report.week}`, report.primaryInjury)
  }

  const absences: Absence[] = []

  for (const games of bySeason.values()) {
    const ordered = [...games].sort((a, b) => a.week - b.week)

    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!
      const current = ordered[i]!
      const gap = current.week - previous.week - 1
      // One missed week is often a bye rather than an injury; two or more is
      // much more likely to be real. Long gaps get their own bucket anyway.
      if (gap < 2 || gap > 12) continue

      // Need enough games either side to compare.
      if (i - 1 < WINDOW - 1 || ordered.length - i < WINDOW) continue

      let injury = ''
      for (let week = previous.week + 1; week <= current.week; week += 1) {
        const found = causes.get(`${current.playerId}:${current.season}:${week}`)
        if (found) {
          injury = found
          break
        }
      }

      absences.push({
        playerId: current.playerId,
        season: current.season,
        position: current.position,
        injury,
        lastWeekBefore: previous.week,
        firstWeekBack: current.week,
        weeksMissed: gap,
      })
    }
  }

  return absences
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

interface Comparison {
  weeksMissed: number
  injury: string
  before: number
  firstBack: number
  firstThree: number
}

function buildComparisons(
  stats: WeeklyStat[],
  absences: Absence[],
): Comparison[] {
  const bySeason = new Map<string, WeeklyStat[]>()
  for (const stat of stats) {
    const key = `${stat.playerId}:${stat.season}`
    const list = bySeason.get(key)
    if (list) list.push(stat)
    else bySeason.set(key, [stat])
  }

  const comparisons: Comparison[] = []

  for (const absence of absences) {
    const games = bySeason.get(`${absence.playerId}:${absence.season}`)
    if (!games) continue
    const ordered = [...games].sort((a, b) => a.week - b.week)

    const before = ordered
      .filter((game) => game.week <= absence.lastWeekBefore)
      .slice(-WINDOW)
      .map((game) => game.fantasyPointsPpr)
    const after = ordered
      .filter((game) => game.week >= absence.firstWeekBack)
      .slice(0, WINDOW)
      .map((game) => game.fantasyPointsPpr)

    if (before.length < WINDOW || after.length < 1) continue

    const beforePpg = average(before)
    // A player who was not producing before the injury tells us nothing about
    // recovery, only about being marginal.
    if (beforePpg < 5) continue

    comparisons.push({
      weeksMissed: absence.weeksMissed,
      injury: absence.injury.toLowerCase(),
      before: beforePpg,
      firstBack: after[0] ?? 0,
      firstThree: average(after),
    })
  }

  return comparisons
}

export function measureReturns(
  stats: WeeklyStat[],
  reports: InjuryReport[],
  positions = ['RB', 'WR', 'TE', 'QB'],
): ReturnProfile[] {
  const comparisons = buildComparisons(stats, findAbsences(stats, reports, positions))

  const buckets = [
    { weeksMissed: 2, match: (c: Comparison) => c.weeksMissed === 2 },
    { weeksMissed: 3, match: (c: Comparison) => c.weeksMissed === 3 },
    { weeksMissed: 4, match: (c: Comparison) => c.weeksMissed === 4 },
    { weeksMissed: 6, match: (c: Comparison) => c.weeksMissed >= 5 && c.weeksMissed <= 7 },
    { weeksMissed: 10, match: (c: Comparison) => c.weeksMissed >= 8 },
  ]

  return buckets
    .map((bucket) => {
      const group = comparisons.filter(bucket.match)
      const before = average(group.map((c) => c.before))
      const firstBack = average(group.map((c) => c.firstBack))
      const firstThree = average(group.map((c) => c.firstThree))

      return {
        weeksMissed: bucket.weeksMissed,
        returns: group.length,
        beforePpg: before,
        firstGameBackPpg: firstBack,
        firstThreeBackPpg: firstThree,
        firstGameRatio: before === 0 ? 1 : firstBack / before,
        firstThreeRatio: before === 0 ? 1 : firstThree / before,
      }
    })
    .filter((profile) => profile.returns >= 20)
}

export function measureByInjuryType(
  stats: WeeklyStat[],
  reports: InjuryReport[],
  positions = ['RB', 'WR', 'TE', 'QB'],
): InjuryTypeProfile[] {
  const comparisons = buildComparisons(stats, findAbsences(stats, reports, positions))

  const grouped = new Map<string, Comparison[]>()
  for (const comparison of comparisons) {
    if (!comparison.injury) continue
    const list = grouped.get(comparison.injury)
    if (list) list.push(comparison)
    else grouped.set(comparison.injury, [comparison])
  }

  return [...grouped.entries()]
    .filter(([, group]) => group.length >= 20)
    .map(([injury, group]) => {
      const before = average(group.map((c) => c.before))
      return {
        injury,
        returns: group.length,
        medianWeeksMissed: median(group.map((c) => c.weeksMissed)),
        firstThreeRatio: before === 0 ? 1 : average(group.map((c) => c.firstThree)) / before,
      }
    })
    .sort((a, b) => a.firstThreeRatio - b.firstThreeRatio)
}
