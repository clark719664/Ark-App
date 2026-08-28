import { Router, type Request, type Response, type NextFunction } from 'express'
import type { Player, RosterEntry } from '../shared/types.js'
import { config } from './config.js'
import { computeMatchupOdds } from './analytics/matchup.js'
import { optimizeLineup, resolveSlots } from './analytics/lineup.js'
import { findMarketSignals, findTrades } from './analytics/trades.js'
import { buildWaiverReport } from './analytics/waivers.js'
import { getAnalytics, getSnapshot, getStatus, invalidate, NoSnapshotError } from './store.js'
import { YahooAuthError } from './yahoo/browser.js'

/**
 * The HTTP surface. Every route reads from the cached snapshot, so responses
 * are fast and predictable; the one exception is POST /api/sync, which drives
 * the browser and is therefore serialized behind a single in-flight lock.
 */

export const api = Router()

/** Wrap an async handler so rejections reach the error middleware. */
const handle =
  (fn: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next)
  }

api.get('/health', (_req, res) => {
  res.json({ ok: true, ...getStatus() })
})

api.get('/league', handle((_req, res) => {
  const snapshot = getSnapshot()
  res.json({
    league: snapshot.league,
    teams: snapshot.teams,
    fetchedAt: snapshot.fetchedAt,
    warnings: snapshot.warnings,
  })
}))

api.get('/standings', handle((_req, res) => {
  const snapshot = getSnapshot()
  const analytics = getAnalytics()

  // Join the pieces the standings table needs so the client makes one call.
  const rows = snapshot.teams.map((team) => ({
    team,
    power: analytics.powerRankings.find((p) => p.teamId === team.id) ?? null,
    luck: analytics.luck.find((l) => l.teamId === team.id) ?? null,
    schedule: analytics.scheduleStrength.find((s) => s.teamId === team.id) ?? null,
    odds: analytics.playoffOdds.find((o) => o.teamId === team.id) ?? null,
  }))

  rows.sort((a, b) => {
    const aRank = a.team.rank ?? Number.MAX_SAFE_INTEGER
    const bRank = b.team.rank ?? Number.MAX_SAFE_INTEGER
    if (aRank !== bRank) return aRank - bRank
    return b.team.record.wins - a.team.record.wins || b.team.pointsFor - a.team.pointsFor
  })

  res.json({ league: snapshot.league, rows })
}))

api.get('/matchups', handle((req, res) => {
  const snapshot = getSnapshot()
  const requested = Number.parseInt(String(req.query['week'] ?? ''), 10)
  const week = Number.isFinite(requested) ? requested : snapshot.league.currentWeek

  const weeks = [...new Set(snapshot.matchups.map((m) => m.week))].sort((a, b) => a - b)
  const matchups = snapshot.matchups
    .filter((m) => m.week === week)
    .map((m) => ({
      ...m,
      homeTeam: snapshot.teams.find((t) => t.id === m.home.teamId) ?? null,
      awayTeam: snapshot.teams.find((t) => t.id === m.away.teamId) ?? null,
    }))

  res.json({ week, weeks, currentWeek: snapshot.league.currentWeek, matchups })
}))

api.get('/teams/:id', handle((req, res) => {
  const snapshot = getSnapshot()
  const team = snapshot.teams.find((t) => t.id === req.params.id)
  if (!team) {
    res.status(404).json({ error: `No team with id ${req.params.id}` })
    return
  }

  const analytics = getAnalytics()
  const roster = snapshot.rosters[team.id] ?? []

  res.json({
    team,
    roster: sortRoster(roster),
    schedule: snapshot.matchups
      .filter((m) => m.home.teamId === team.id || m.away.teamId === team.id)
      .map((m) => {
        const isHome = m.home.teamId === team.id
        const opponentId = isHome ? m.away.teamId : m.home.teamId
        return {
          week: m.week,
          final: m.final,
          isHome,
          points: isHome ? m.home.score : m.away.score,
          opponentPoints: isHome ? m.away.score : m.home.score,
          opponent: snapshot.teams.find((t) => t.id === opponentId) ?? null,
          result: m.final ? (m.winnerTeamId === null ? 'T' : m.winnerTeamId === team.id ? 'W' : 'L') : null,
        }
      }),
    power: analytics.powerRankings.find((p) => p.teamId === team.id) ?? null,
    luck: analytics.luck.find((l) => l.teamId === team.id) ?? null,
    odds: analytics.playoffOdds.find((o) => o.teamId === team.id) ?? null,
    weeklyScores: analytics.weeklyScores.filter((w) => w.teamId === team.id),
  })
}))

/** Starters first, in lineup order, then the bench. */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'W/R/T', 'W/T', 'R/W/T', 'Q/W/R/T', 'K', 'DEF', 'D/ST', 'BN', 'IR']

function sortRoster(roster: RosterEntry[]): RosterEntry[] {
  return [...roster].sort((a, b) => {
    if (a.starter !== b.starter) return a.starter ? -1 : 1
    const aIdx = SLOT_ORDER.indexOf(a.slot.toUpperCase())
    const bIdx = SLOT_ORDER.indexOf(b.slot.toUpperCase())
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx)
  })
}

api.get('/players', handle((req, res) => {
  const snapshot = getSnapshot()
  const query = String(req.query['q'] ?? '').trim().toLowerCase()
  const position = String(req.query['pos'] ?? '').trim().toUpperCase()
  const status = String(req.query['status'] ?? 'all').trim().toLowerCase()
  const sort = String(req.query['sort'] ?? 'points')
  const limit = clamp(Number.parseInt(String(req.query['limit'] ?? '100'), 10) || 100, 1, 1000)

  let players = snapshot.players

  if (query) {
    players = players.filter(
      (p) => p.name.toLowerCase().includes(query) || p.nflTeam.toLowerCase().includes(query),
    )
  }
  if (position && position !== 'ALL') {
    players = players.filter(
      (p) => p.position === position || p.eligiblePositions?.includes(position as Player['position']),
    )
  }
  if (status === 'available' || status === 'fa') players = players.filter((p) => !p.ownerTeamId)
  else if (status === 'rostered' || status === 'taken') players = players.filter((p) => !!p.ownerTeamId)

  const sorted = [...players].sort(comparePlayers(sort))

  res.json({
    total: sorted.length,
    players: sorted.slice(0, limit),
    teams: snapshot.teams.map((t) => ({ id: t.id, name: t.name })),
  })
}))

function comparePlayers(sort: string): (a: Player, b: Player) => number {
  switch (sort) {
    case 'name':
      return (a, b) => a.name.localeCompare(b.name)
    case 'average':
      return (a, b) => (b.points?.average ?? -1) - (a.points?.average ?? -1)
    case 'projected':
      return (a, b) => (b.points?.projected ?? -1) - (a.points?.projected ?? -1)
    case 'owned':
      return (a, b) => (b.ownership?.percentOwned ?? -1) - (a.ownership?.percentOwned ?? -1)
    case 'rank':
      return (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
    default:
      return (a, b) => (b.points?.season ?? -1) - (a.points?.season ?? -1)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

api.get('/draft', handle((_req, res) => {
  const snapshot = getSnapshot()
  res.json({
    picks: snapshot.draft,
    teams: snapshot.teams.map((t) => ({ id: t.id, name: t.name, isMine: t.isMine ?? false })),
    isAuction: snapshot.league.isAuction ?? false,
  })
}))

api.get('/analytics', handle((_req, res) => {
  const snapshot = getSnapshot()
  res.json({ league: snapshot.league, teams: snapshot.teams, ...getAnalytics() })
}))

// --- Manager tools ----------------------------------------------------------

/**
 * Resolve which team the tools should act for: an explicit ?team=, else the
 * team flagged as the user's own, else the first team in the league so the
 * pages always have something to show.
 */
function resolveTeamId(snapshot: ReturnType<typeof getSnapshot>, requested: unknown): string {
  const asked = typeof requested === 'string' ? requested.trim() : ''
  if (asked && snapshot.teams.some((team) => team.id === asked)) return asked
  return snapshot.teams.find((team) => team.isMine)?.id ?? snapshot.teams[0]?.id ?? ''
}

function slotsFor(snapshot: ReturnType<typeof getSnapshot>, teamId: string): string[] {
  return resolveSlots(snapshot.league.rosterSlots, snapshot.rosters[teamId] ?? [])
}

api.get('/lineup', handle((req, res) => {
  const snapshot = getSnapshot()
  const teamId = resolveTeamId(snapshot, req.query['team'])
  const team = snapshot.teams.find((t) => t.id === teamId)
  if (!team) {
    res.status(404).json({ error: 'No teams in this league yet.' })
    return
  }

  const roster = snapshot.rosters[teamId] ?? []
  const slots = slotsFor(snapshot, teamId)
  const week = snapshot.league.currentWeek

  const matchup = snapshot.matchups.find(
    (m) => m.week === week && (m.home.teamId === teamId || m.away.teamId === teamId),
  )
  const odds = computeMatchupOdds(snapshot, week).find(
    (o) => o.homeTeamId === teamId || o.awayTeamId === teamId,
  )
  const opponentId = matchup
    ? matchup.home.teamId === teamId
      ? matchup.away.teamId
      : matchup.home.teamId
    : null

  res.json({
    team,
    week,
    slots,
    lineup: optimizeLineup(roster, slots, week),
    roster,
    opponent: opponentId ? (snapshot.teams.find((t) => t.id === opponentId) ?? null) : null,
    odds: odds
      ? {
          winProbability: odds.homeTeamId === teamId ? odds.homeWinProbability : odds.awayWinProbability,
          projected: odds.homeTeamId === teamId ? odds.homeProjected : odds.awayProjected,
          opponentProjected: odds.homeTeamId === teamId ? odds.awayProjected : odds.homeProjected,
          margin: odds.projectedMargin,
        }
      : null,
    teams: snapshot.teams.map((t) => ({ id: t.id, name: t.name, isMine: t.isMine ?? false })),
    dataQuality: snapshot.dataQuality ?? null,
  })
}))

api.get('/waivers', handle((req, res) => {
  const snapshot = getSnapshot()
  const teamId = resolveTeamId(snapshot, req.query['team'])
  const limit = clamp(Number.parseInt(String(req.query['limit'] ?? '30'), 10) || 30, 1, 100)

  res.json({
    ...buildWaiverReport(snapshot, teamId, slotsFor(snapshot, teamId), limit),
    week: snapshot.league.currentWeek,
    team: snapshot.teams.find((t) => t.id === teamId) ?? null,
    teams: snapshot.teams.map((t) => ({ id: t.id, name: t.name, isMine: t.isMine ?? false })),
    dataQuality: snapshot.dataQuality ?? null,
  })
}))

api.get('/trades', handle((req, res) => {
  const snapshot = getSnapshot()
  const teamId = resolveTeamId(snapshot, req.query['team'])
  const limit = clamp(Number.parseInt(String(req.query['limit'] ?? '12'), 10) || 12, 1, 40)

  res.json({
    ...findTrades(snapshot, teamId, slotsFor(snapshot, teamId), { limit }),
    signals: findMarketSignals(snapshot, 8, teamId),
    team: snapshot.teams.find((t) => t.id === teamId) ?? null,
    teams: snapshot.teams.map((t) => ({ id: t.id, name: t.name, isMine: t.isMine ?? false })),
    dataQuality: snapshot.dataQuality ?? null,
  })
}))

api.get('/matchup-odds', handle((req, res) => {
  const snapshot = getSnapshot()
  const requested = Number.parseInt(String(req.query['week'] ?? ''), 10)
  const week = Number.isFinite(requested) ? requested : snapshot.league.currentWeek
  res.json({ week, odds: computeMatchupOdds(snapshot, week) })
}))

// --- Sync -------------------------------------------------------------------

let syncInFlight: Promise<unknown> | null = null
let lastSyncLog: string[] = []

api.get('/sync/status', (_req, res) => {
  res.json({ running: syncInFlight !== null, log: lastSyncLog })
})

api.post('/sync', handle(async (_req, res) => {
  if (config.provider !== 'yahoo') {
    res.status(400).json({
      error: 'Sync only applies to the Yahoo provider. Set FF_PROVIDER=yahoo in .env.',
    })
    return
  }
  if (syncInFlight) {
    res.status(409).json({ error: 'A sync is already running.', log: lastSyncLog })
    return
  }

  const log: string[] = []
  lastSyncLog = log

  // Imported lazily so the demo path never has to load Playwright.
  const { syncLeague } = await import('./yahoo/sync.js')
  syncInFlight = syncLeague({ onProgress: (m) => log.push(m) })
    .then(() => {
      invalidate()
      log.push('Sync complete.')
    })
    .catch((err: unknown) => {
      log.push(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => {
      syncInFlight = null
    })

  res.status(202).json({ started: true })
}))

// --- Errors -----------------------------------------------------------------

export function apiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof NoSnapshotError) {
    res.status(503).json({ error: err.message, code: 'NO_SNAPSHOT' })
    return
  }
  if (err instanceof YahooAuthError) {
    res.status(401).json({ error: err.message, code: 'YAHOO_AUTH' })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  console.error('[api]', message)
  res.status(500).json({ error: message, code: 'INTERNAL' })
}
