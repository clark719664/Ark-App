import fs from 'node:fs'
import path from 'node:path'
import type {
  DataQuality, LeagueSnapshot, Matchup, Player, ProjectionSource, RosterEntry,
} from '../../shared/types.js'
import { config } from '../config.js'
import { openSession, politeDelay } from './browser.js'
import {
  scrapeDraft, scrapeLeagueMeta, scrapePlayers, scrapeRoster, scrapeScoreboard,
  scrapeStandings, type ScrapeContext,
} from './scrape.js'

/**
 * Walks a Yahoo league once and writes a complete snapshot to disk.
 *
 * Sync is deliberately a separate step from serving. The API reads the cached
 * snapshot and never touches Yahoo, so the hub stays fast and keeps working
 * when Yahoo is slow, when the session lapses, or when you're offline on a
 * plane arguing about a waiver claim.
 */

export interface SyncOptions {
  /** Skip the player pool walk; much faster when you only want scores. */
  skipPlayers?: boolean
  /** How many 25-player pages of the free-agent pool to pull. */
  playerPages?: number
  headed?: boolean
  onProgress?: (message: string) => void
}

export async function syncLeague(opts: SyncOptions = {}): Promise<LeagueSnapshot> {
  const log = opts.onProgress ?? (() => {})
  const leagueId = config.yahoo.leagueId
  if (!leagueId) {
    throw new Error('YAHOO_LEAGUE_ID is not set. Add it to .env — see .env.example.')
  }

  const warnings: string[] = []
  const warn = (message: string) => {
    warnings.push(message)
    log(`  ! ${message}`)
  }

  const session = await openSession(opts.headed !== undefined ? { headed: opts.headed } : {})
  const ctx: ScrapeContext = { page: session.page, leagueId, warn }

  try {
    log('Reading league settings…')
    const league = await scrapeLeagueMeta(ctx)
    await politeDelay()

    log('Reading standings…')
    const teams = await scrapeStandings(ctx)
    if (league.numTeams === 0) league.numTeams = teams.length
    await politeDelay()

    // Walk the whole regular season, not just the weeks already played: the
    // remaining schedule is what playoff odds are computed from.
    const lastWeek = Math.max(league.currentWeek, league.regularSeasonWeeks)
    log(`Reading scoreboards for weeks 1–${lastWeek}…`)
    const matchups: Matchup[] = []
    for (let week = 1; week <= lastWeek; week += 1) {
      const weekly = await scrapeScoreboard(ctx, week)
      matchups.push(...weekly)
      log(`  week ${week}: ${weekly.length} matchups`)
      await politeDelay()
    }

    log(`Reading ${teams.length} rosters…`)
    const rosters: Record<string, RosterEntry[]> = {}
    for (const team of teams) {
      rosters[team.id] = await scrapeRoster(ctx, team.id)
      await politeDelay()
    }

    let players: Player[] = []
    if (!opts.skipPlayers) {
      const pageOption = opts.playerPages !== undefined ? { pages: opts.playerPages } : {}

      log('Reading the free-agent pool…')
      const freeAgents = await scrapePlayers(ctx, { status: 'A', ...pageOption })
      log(`  ${freeAgents.length} available players`)
      await politeDelay()

      // Also walk the rostered players. The players page reliably carries the
      // projection and ownership columns that a team page may not, and without
      // this every rostered player can end up with no numbers at all — which
      // makes start/sit, waivers and trades quietly meaningless.
      log('Reading stats for rostered players…')
      const taken = await scrapePlayers(ctx, { status: 'T', pages: opts.playerPages ?? 12 })
      log(`  ${taken.length} rostered players`)
      await politeDelay()

      players = [...freeAgents, ...taken]
    }

    log('Reading draft results…')
    const draft = await scrapeDraft(ctx)
    log(`  ${draft.length} picks`)

    const merged = mergeRosteredPlayers(players, rosters)
    const dataQuality = assessDataQuality(rosters)
    for (const note of dataQuality.notes) warnings.push(note)

    const snapshot: LeagueSnapshot = {
      league,
      teams,
      matchups,
      rosters,
      players: merged,
      draft,
      fetchedAt: new Date().toISOString(),
      warnings,
      dataQuality,
    }

    writeSnapshot(snapshot)
    log(`\nSaved snapshot to ${config.cache.snapshotFile}`)
    return snapshot
  } finally {
    await session.close()
  }
}

/**
 * The player pool from the players page only covers free agents. Fold in every
 * rostered player so a single list can back both player research and the draft
 * board, preferring the richer free-agent record when a player appears twice.
 */
export function mergeRosteredPlayers(
  pool: Player[],
  rosters: Record<string, RosterEntry[]>,
): Player[] {
  const byId = new Map<string, Player>()
  for (const player of pool) byId.set(player.id, player)

  for (const entries of Object.values(rosters)) {
    for (const entry of entries) {
      if (!entry.player) continue
      const existing = byId.get(entry.player.id)
      if (existing) {
        // Keep pool stats, but trust the roster for who actually owns them.
        existing.ownerTeamId = entry.player.ownerTeamId ?? existing.ownerTeamId
        if (existing.injury === undefined && entry.player.injury) existing.injury = entry.player.injury
        if (existing.byeWeek === undefined && entry.player.byeWeek !== undefined) {
          existing.byeWeek = entry.player.byeWeek
        }
        // Push the richer pool numbers back onto the roster entry, so the
        // lineup tools see them even when the team page had no such column.
        entry.player = { ...entry.player, points: mergePoints(existing.points, entry.player.points) }
        if (entry.projected === undefined && existing.points?.projected !== undefined) {
          entry.projected = existing.points.projected
        }
      } else {
        byId.set(entry.player.id, entry.player)
      }
    }
  }

  return Array.from(byId.values())
}

/** Prefer whichever source actually has a value, field by field. */
function mergePoints(
  pool: Player['points'],
  roster: Player['points'],
): Player['points'] {
  return {
    ...(roster ?? {}),
    ...Object.fromEntries(
      Object.entries(pool ?? {}).filter(([, value]) => value !== undefined),
    ),
  }
}

/**
 * Grade the snapshot on the one thing every manager tool depends on: whether
 * rostered players carry a number worth ranking them by.
 */
export function assessDataQuality(rosters: Record<string, RosterEntry[]>): DataQuality {
  const players = Object.values(rosters)
    .flat()
    .map((entry) => entry.player)
    .filter((player): player is Player => player !== null)

  const withProjection = players.filter(
    (player) => (player.points?.projected ?? 0) > 0,
  ).length
  const withAverage = players.filter((player) => (player.points?.average ?? 0) > 0).length

  const total = players.length
  const notes: string[] = []
  let projections: ProjectionSource = 'none'

  // Require most of the league, not just a handful: a few stragglers are normal,
  // but a mostly-empty column means the parser missed it entirely.
  if (total > 0 && withProjection / total >= 0.6) {
    projections = 'provider'
  } else if (total > 0 && withAverage / total >= 0.6) {
    projections = 'season-average'
    notes.push(
      'No weekly projections were found, so start/sit, waiver and trade rankings ' +
        'fall back to each player\'s season average. Those are still useful, but ' +
        'they cannot see this week\'s matchup.',
    )
  } else if (total > 0) {
    notes.push(
      'Rostered players came back with no scoring data at all, so lineup, waiver ' +
        'and trade rankings are not meaningful. Run `npm run yahoo:capture` and ' +
        'check .cache/raw/ to see what the team and player pages actually returned.',
    )
  }

  return {
    projections,
    playersWithProjections: withProjection,
    totalRosteredPlayers: total,
    notes,
  }
}

export function writeSnapshot(snapshot: LeagueSnapshot): void {
  fs.mkdirSync(path.dirname(config.cache.snapshotFile), { recursive: true })
  fs.writeFileSync(config.cache.snapshotFile, JSON.stringify(snapshot, null, 2))
}

export function readSnapshot(): LeagueSnapshot | null {
  try {
    const raw = fs.readFileSync(config.cache.snapshotFile, 'utf8')
    return JSON.parse(raw) as LeagueSnapshot
  } catch {
    return null
  }
}

/** Age of the cached snapshot in seconds, or null when there isn't one. */
export function snapshotAgeSeconds(): number | null {
  try {
    const stat = fs.statSync(config.cache.snapshotFile)
    return Math.round((Date.now() - stat.mtimeMs) / 1000)
  } catch {
    return null
  }
}
