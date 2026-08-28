import type { DataQuality, LeagueAnalytics, LeagueSnapshot } from '../shared/types.js'
import { computeAnalytics } from './analytics/index.js'
import { ImpactCalculator } from './analytics/impact.js'
import { computePlayoffPath, type PlayoffPath } from './analytics/leverage.js'
import { config } from './config.js'
import { previousWeekSnapshot } from './history.js'
import { buildDemoSnapshot } from './providers/demo.js'
import { readSnapshot, snapshotAgeSeconds, writeSnapshot } from './yahoo/sync.js'

/**
 * The read model behind the API.
 *
 * Serving never touches Yahoo. The Yahoo path reads a snapshot produced by
 * `npm run yahoo:sync`; the demo path generates one in memory. Analytics are
 * expensive enough (tens of thousands of simulated seasons) to be worth
 * memoizing, keyed on the snapshot's timestamp.
 */

export class NoSnapshotError extends Error {
  constructor() {
    super(
      'No league data yet. Pull your league from Yahoo first:\n\n' +
        '    npm run yahoo:login   # once, to sign in\n' +
        '    npm run yahoo:sync    # to pull the league\n',
    )
    this.name = 'NoSnapshotError'
  }
}

let demoSnapshot: LeagueSnapshot | null = null
let analyticsCache: { key: string; value: LeagueAnalytics } | null = null
// A season simulation per scenario is not free, so both of these are built once
// per snapshot and reused across requests.
let impactCache: { key: string; value: ImpactCalculator } | null = null
const pathCache = new Map<string, PlayoffPath>()

export function getSnapshot(): LeagueSnapshot {
  if (config.provider === 'demo') {
    // Built once per process: it's deterministic, so rebuilding is wasted work.
    demoSnapshot ??= buildDemoSnapshot()
    return demoSnapshot
  }

  const snapshot = readSnapshot()
  if (!snapshot) throw new NoSnapshotError()
  return snapshot
}

export function getAnalytics(): LeagueAnalytics {
  const snapshot = getSnapshot()
  const key = `${snapshot.league.id}:${snapshot.fetchedAt}`
  if (analyticsCache?.key === key) return analyticsCache.value

  // Demo data has no history on disk, and none is wanted: it is regenerated
  // identically every run.
  const previous = config.provider === 'demo' ? null : previousWeekSnapshot(snapshot)
  const value = computeAnalytics(snapshot, { previous })
  analyticsCache = { key, value }
  return value
}

function snapshotKey(snapshot: LeagueSnapshot): string {
  return `${snapshot.league.id}:${snapshot.fetchedAt}`
}

/** The season simulator, warmed once per snapshot. */
export function getImpactCalculator(): ImpactCalculator {
  const snapshot = getSnapshot()
  const key = snapshotKey(snapshot)
  if (impactCache?.key === key) return impactCache.value

  const value = new ImpactCalculator(snapshot)
  impactCache = { key, value }
  return value
}

export function getPlayoffPath(teamId: string): PlayoffPath {
  const snapshot = getSnapshot()
  const key = `${snapshotKey(snapshot)}:${teamId}`
  const cached = pathCache.get(key)
  if (cached) return cached

  const value = computePlayoffPath(snapshot, teamId)
  // Bounded: one entry per team per snapshot, cleared on invalidate.
  pathCache.set(key, value)
  return value
}

/** Drop memoized state so the next read picks up a freshly synced snapshot. */
export function invalidate(): void {
  analyticsCache = null
  impactCache = null
  pathCache.clear()
  demoSnapshot = null
}

export interface StatusReport {
  provider: string
  hasData: boolean
  leagueId: string
  leagueName: string | null
  season: number | null
  currentWeek: number | null
  fetchedAt: string | null
  ageSeconds: number | null
  stale: boolean
  warnings: string[]
  dataQuality: DataQuality | null
}

export function getStatus(): StatusReport {
  const base: StatusReport = {
    provider: config.provider,
    hasData: false,
    leagueId: config.provider === 'demo' ? 'demo' : config.yahoo.leagueId,
    leagueName: null,
    season: null,
    currentWeek: null,
    fetchedAt: null,
    ageSeconds: null,
    stale: true,
    warnings: [],
    dataQuality: null,
  }

  try {
    const snapshot = getSnapshot()
    const age = config.provider === 'demo' ? 0 : snapshotAgeSeconds()
    return {
      ...base,
      hasData: true,
      leagueName: snapshot.league.name,
      season: snapshot.league.season,
      currentWeek: snapshot.league.currentWeek,
      fetchedAt: snapshot.fetchedAt,
      ageSeconds: age,
      stale: age !== null && age > config.cache.ttlSeconds,
      warnings: snapshot.warnings,
      dataQuality: snapshot.dataQuality ?? null,
    }
  } catch {
    return base
  }
}

export { writeSnapshot }
