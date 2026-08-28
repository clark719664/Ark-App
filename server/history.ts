import fs from 'node:fs'
import path from 'node:path'
import type { LeagueSnapshot } from '../shared/types.js'
import { config } from './config.js'

/**
 * An archive of past syncs.
 *
 * Without it, "how has this team moved since last week" has to be answered by
 * recomputing from a truncated version of today's data — which quietly assumes
 * nothing about the roster changed, when trades and waiver claims are exactly
 * what you want to see the effect of.
 *
 * Archives are small, kept per league and season, and pruned so the directory
 * cannot grow without bound.
 */

const MAX_ARCHIVES = 40

function historyDir(): string {
  return path.join(config.cache.dir, 'history')
}

function fileNameFor(snapshot: LeagueSnapshot): string {
  // Sortable by name, and scoped so two leagues never interleave.
  const stamp = snapshot.fetchedAt.replace(/[:.]/g, '-')
  return `${snapshot.league.id}_${snapshot.league.season}_w${String(snapshot.league.currentWeek).padStart(2, '0')}_${stamp}.json`
}

export function archiveSnapshot(snapshot: LeagueSnapshot): void {
  try {
    const dir = historyDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, fileNameFor(snapshot)), JSON.stringify(snapshot))
    prune(snapshot.league.id, snapshot.league.season)
  } catch {
    // History is a convenience. Failing to write it must never fail a sync.
  }
}

function listArchives(leagueId: string, season: number): string[] {
  try {
    const prefix = `${leagueId}_${season}_`
    return fs
      .readdirSync(historyDir())
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
  } catch {
    return []
  }
}

function prune(leagueId: string, season: number): void {
  const archives = listArchives(leagueId, season)
  for (const name of archives.slice(0, Math.max(0, archives.length - MAX_ARCHIVES))) {
    try {
      fs.rmSync(path.join(historyDir(), name), { force: true })
    } catch {
      // Leaving an extra file behind is harmless.
    }
  }
}

function read(name: string): LeagueSnapshot | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(historyDir(), name), 'utf8')) as LeagueSnapshot
  } catch {
    return null
  }
}

/**
 * The most recent archived snapshot from a week *before* the current one.
 *
 * Comparing against an earlier sync of the same week would show noise from a
 * partial scrape rather than a week of football, so same-week archives are
 * skipped.
 */
export function previousWeekSnapshot(current: LeagueSnapshot): LeagueSnapshot | null {
  const archives = listArchives(current.league.id, current.league.season)

  for (const name of [...archives].reverse()) {
    const snapshot = read(name)
    if (!snapshot) continue
    if (snapshot.league.currentWeek < current.league.currentWeek) return snapshot
  }
  return null
}

export interface ArchiveSummary {
  week: number
  fetchedAt: string
}

export function listHistory(leagueId: string, season: number): ArchiveSummary[] {
  return listArchives(leagueId, season)
    .map((name) => read(name))
    .filter((snapshot): snapshot is LeagueSnapshot => snapshot !== null)
    .map((snapshot) => ({ week: snapshot.league.currentWeek, fetchedAt: snapshot.fetchedAt }))
}
