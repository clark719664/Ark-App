import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DraftPick, League, LeagueAnalytics, LuckRating, Matchup, Player, PlayerPosition,
  PlayoffOdds, PowerRanking, RosterEntry, ScheduleStrength, Team, TeamWeekScore,
} from '@shared/types'

/** Typed client for the Ark API, plus a small hook for loading state. */

export interface ApiError extends Error {
  status: number
  code?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    let code: string | undefined
    try {
      const body = (await response.json()) as { error?: string; code?: string }
      if (body.error) message = body.error
      code = body.code
    } catch {
      // Non-JSON error body; the status-based message is the best we have.
    }
    const error = new Error(message) as ApiError
    error.status = response.status
    if (code) error.code = code
    throw error
  }

  return (await response.json()) as T
}

// --- Response shapes --------------------------------------------------------

export interface HealthResponse {
  ok: boolean
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
}

export interface StandingsRow {
  team: Team
  power: PowerRanking | null
  luck: LuckRating | null
  schedule: ScheduleStrength | null
  odds: PlayoffOdds | null
}

export interface StandingsResponse {
  league: League
  rows: StandingsRow[]
}

export interface MatchupWithTeams extends Matchup {
  homeTeam: Team | null
  awayTeam: Team | null
}

export interface MatchupsResponse {
  week: number
  weeks: number[]
  currentWeek: number
  matchups: MatchupWithTeams[]
}

export interface ScheduleGame {
  week: number
  final: boolean
  isHome: boolean
  points: number
  opponentPoints: number
  opponent: Team | null
  result: 'W' | 'L' | 'T' | null
}

export interface TeamResponse {
  team: Team
  roster: RosterEntry[]
  schedule: ScheduleGame[]
  power: PowerRanking | null
  luck: LuckRating | null
  odds: PlayoffOdds | null
  weeklyScores: TeamWeekScore[]
}

export interface PlayersResponse {
  total: number
  players: Player[]
  teams: Array<{ id: string; name: string }>
}

export interface DraftResponse {
  picks: DraftPick[]
  teams: Array<{ id: string; name: string; isMine: boolean }>
  isAuction: boolean
}

export interface AnalyticsResponse extends LeagueAnalytics {
  league: League
  teams: Team[]
}


export interface TeamOption {
  id: string
  name: string
  isMine: boolean
}

export interface LineupAssignment {
  slot: string
  player: Player | null
  projected: number
  changed: boolean
}

export interface LineupSwap {
  slot: string
  out: Player
  in: Player
  gain: number
}

export interface LineupAlert {
  player: Player
  reason: string
  severity: 'high' | 'medium'
}

export interface LineupResponse {
  team: Team
  week: number
  slots: string[]
  roster: RosterEntry[]
  opponent: Team | null
  odds: {
    winProbability: number
    projected: number
    opponentProjected: number
    margin: number
  } | null
  lineup: {
    optimal: LineupAssignment[]
    currentProjected: number
    optimalProjected: number
    pointsLeftOnBench: number
    swaps: LineupSwap[]
    alerts: LineupAlert[]
  }
  teams: TeamOption[]
}

export interface WaiverTarget {
  player: Player
  upgrade: number
  replaces: Player | null
  rank: number
  reasons: string[]
  priority: 'high' | 'medium' | 'low'
}

export interface PositionOutlook {
  position: PlayerPosition
  bestUpgrade: number
  bestPlayer: Player | null
}

export interface WaiversResponse {
  teamId: string
  week: number
  team: Team | null
  targets: WaiverTarget[]
  outlook: PositionOutlook[]
  gaps: Array<{ position: PlayerPosition; reason: string }>
  teams: TeamOption[]
}

export interface TradeIdea {
  id: string
  you: { teamId: string; teamName: string; sends: Player[]; receives: Player[]; gain: number }
  them: { teamId: string; teamName: string; sends: Player[]; receives: Player[]; gain: number }
  totalGain: number
  fairness: number
  rationale: string
}

export interface MarketSignal {
  player: Player
  teamId: string | null
  teamName: string | null
  seasonAverage: number
  recentAverage: number
  swing: number
  kind: 'buy-low' | 'sell-high'
  note: string
}

export interface TradesResponse {
  teamId: string
  team: Team | null
  ideas: TradeIdea[]
  signals: MarketSignal[]
  surplus: Array<{ position: PlayerPosition; depth: number; spare: Player[] }>
  needs: Array<{ position: PlayerPosition; starterProjection: number }>
  teams: TeamOption[]
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  league: () => request<{ league: League; teams: Team[]; fetchedAt: string; warnings: string[] }>('/league'),
  standings: () => request<StandingsResponse>('/standings'),
  matchups: (week?: number) =>
    request<MatchupsResponse>(week === undefined ? '/matchups' : `/matchups?week=${week}`),
  team: (id: string) => request<TeamResponse>(`/teams/${encodeURIComponent(id)}`),
  players: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value))
    }
    return request<PlayersResponse>(`/players?${query.toString()}`)
  },
  draft: () => request<DraftResponse>('/draft'),
  analytics: () => request<AnalyticsResponse>('/analytics'),
  lineup: (teamId?: string) =>
    request<LineupResponse>(teamId ? `/lineup?team=${encodeURIComponent(teamId)}` : '/lineup'),
  waivers: (teamId?: string) =>
    request<WaiversResponse>(teamId ? `/waivers?team=${encodeURIComponent(teamId)}` : '/waivers'),
  trades: (teamId?: string) =>
    request<TradesResponse>(teamId ? `/trades?team=${encodeURIComponent(teamId)}` : '/trades'),
  startSync: () => request<{ started: boolean }>('/sync', { method: 'POST' }),
  syncStatus: () => request<{ running: boolean; log: string[] }>('/sync/status'),
}

// --- Hook -------------------------------------------------------------------

export interface AsyncState<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
  reload: () => void
}

/**
 * Load data on mount and whenever `deps` change. Results from a superseded
 * request are dropped, so a fast filter change can't be overwritten by a slow
 * earlier response.
 */
export function useApi<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const requestId = useRef(0)

  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    loaderRef
      .current()
      .then((result) => {
        if (id !== requestId.current) return
        setData(result)
        setError(null)
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return
        setError(err as ApiError)
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return { data, error, loading, reload }
}
