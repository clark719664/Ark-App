import fs from 'node:fs'
import path from 'node:path'
import type {
  DataQuality, DraftPick, League, LeagueSnapshot, Matchup, Player, ProjectionSource,
  RosterEntry, Team,
} from '../../shared/types.js'
import { config } from '../config.js'
import { archiveSnapshot } from '../history.js'
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
  /**
   * Start over rather than continuing from a partial run. A sync writes its
   * progress as it goes, so an interrupted one resumes by default instead of
   * re-walking pages Yahoo already served.
   */
  fresh?: boolean
}

/**
 * A sync in progress.
 *
 * Walking a league is a few dozen page loads at a deliberate pace, so losing
 * all of it to one failure at week nine is a genuinely annoying outcome. Each
 * stage is written to disk as it completes, and the next run picks up from
 * there unless asked not to.
 */
interface SyncProgress {
  leagueId: string
  season: number
  startedAt: string
  league?: League
  teams?: Team[]
  matchupsByWeek?: Record<string, Matchup[]>
  rosters?: Record<string, RosterEntry[]>
  players?: Player[]
  draft?: DraftPick[]
  warnings?: string[]
}

const progressFile = () => path.join(config.cache.dir, 'sync-progress.json')

/** Exposed for tests: resume rules are worth covering directly. */
export function readSyncProgressForTests(): SyncProgress | null {
  return readProgress()
}

function readProgress(): SyncProgress | null {
  try {
    const raw = JSON.parse(fs.readFileSync(progressFile(), 'utf8')) as SyncProgress
    // Progress from a different league or season is not resumable.
    if (raw.leagueId !== config.yahoo.leagueId || raw.season !== config.yahoo.season) return null
    return raw
  } catch {
    return null
  }
}

function writeProgress(progress: SyncProgress): void {
  try {
    fs.mkdirSync(config.cache.dir, { recursive: true })
    fs.writeFileSync(progressFile(), JSON.stringify(progress))
  } catch {
    // A checkpoint that cannot be written is not worth failing the sync over.
  }
}

function clearProgress(): void {
  try {
    fs.rmSync(progressFile(), { force: true })
  } catch {
    // Nothing to clean up.
  }
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

  const resumed = opts.fresh ? null : readProgress()
  const progress: SyncProgress = resumed ?? {
    leagueId,
    season: config.yahoo.season,
    startedAt: new Date().toISOString(),
  }
  if (resumed) {
    log(`Resuming an interrupted sync from ${resumed.startedAt}.`)
    log('Pass --fresh to start over instead.\n')
    warnings.push(...(resumed.warnings ?? []))
  }

  const checkpoint = () => {
    progress.warnings = warnings
    writeProgress(progress)
  }

  const session = await openSession(opts.headed !== undefined ? { headed: opts.headed } : {})
  const ctx: ScrapeContext = { page: session.page, leagueId, warn }

  try {
    let league = progress.league
    if (league) {
      log('League settings: already read, skipping.')
    } else {
      log('Reading league settings…')
      league = await scrapeLeagueMeta(ctx)
      progress.league = league
      checkpoint()
      await politeDelay()
    }

    let teams = progress.teams
    if (teams) {
      log(`Standings: already read (${teams.length} teams), skipping.`)
    } else {
      log('Reading standings…')
      teams = await scrapeStandings(ctx)
      if (league.numTeams === 0) league.numTeams = teams.length
      progress.teams = teams
      progress.league = league
      checkpoint()
      await politeDelay()
    }

    // Walk the whole regular season, not just the weeks already played: the
    // remaining schedule is what playoff odds are computed from.
    const lastWeek = Math.max(league.currentWeek, league.regularSeasonWeeks)
    const matchupsByWeek = progress.matchupsByWeek ?? {}
    const pendingWeeks = Array.from({ length: lastWeek }, (_, i) => i + 1).filter(
      (week) => matchupsByWeek[String(week)] === undefined,
    )

    if (pendingWeeks.length === 0) {
      log(`Scoreboards: all ${lastWeek} weeks already read, skipping.`)
    } else {
      log(`Reading scoreboards for ${pendingWeeks.length} of ${lastWeek} weeks…`)
      for (const week of pendingWeeks) {
        const weekly = await scrapeScoreboard(ctx, week)
        matchupsByWeek[String(week)] = weekly
        progress.matchupsByWeek = matchupsByWeek
        checkpoint()
        log(`  week ${week}: ${weekly.length} matchups`)
        await politeDelay()
      }
    }
    const matchups: Matchup[] = Object.values(matchupsByWeek).flat()

    const rosters: Record<string, RosterEntry[]> = progress.rosters ?? {}
    const pendingTeams = teams.filter((team) => rosters[team.id] === undefined)
    if (pendingTeams.length === 0) {
      log(`Rosters: all ${teams.length} already read, skipping.`)
    } else {
      log(`Reading ${pendingTeams.length} of ${teams.length} rosters…`)
      for (const team of pendingTeams) {
        rosters[team.id] = await scrapeRoster(ctx, team.id)
        progress.rosters = rosters
        checkpoint()
        await politeDelay()
      }
    }

    let players: Player[] = progress.players ?? []
    if (opts.skipPlayers) {
      players = []
    } else if (progress.players) {
      log(`Player pool: already read (${players.length} players), skipping.`)
    } else {
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
      progress.players = players
      checkpoint()
    }

    let draft = progress.draft
    if (draft) {
      log(`Draft: already read (${draft.length} picks), skipping.`)
    } else {
      log('Reading draft results…')
      draft = await scrapeDraft(ctx)
      progress.draft = draft
      checkpoint()
      log(`  ${draft.length} picks`)
    }

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
    archiveSnapshot(snapshot)
    clearProgress()
    log(`\nSaved snapshot to ${config.cache.snapshotFile}`)
    return snapshot
  } catch (err) {
    // Keep whatever was gathered so the next run picks up where this stopped.
    checkpoint()
    log('\nProgress so far has been saved. Re-run `npm run yahoo:sync` to continue.')
    throw err
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
