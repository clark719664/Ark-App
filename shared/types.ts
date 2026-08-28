/**
 * The domain model for Ark.
 *
 * This is the contract between the data providers (Yahoo scraper, demo
 * fixtures) and everything downstream — the API, the analytics engine and the
 * UI. Nothing above this layer knows that Yahoo exists, which is what keeps a
 * Yahoo redesign from reaching the rest of the app.
 */

export type ProviderId = 'yahoo' | 'demo'

/** A player's actual football position. */
export type PlayerPosition =
  | 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF'
  | 'DL' | 'LB' | 'DB' | 'CB' | 'S' | 'DE' | 'DT'
  | 'UNKNOWN'

/**
 * A lineup slot. Distinct from PlayerPosition: a RB can occupy `RB`, `W/R/T`
 * or `BN`. Yahoo's slot vocabulary is preserved as-is where it is unambiguous.
 */
export type RosterSlot = string

export interface Record_ {
  wins: number
  losses: number
  ties: number
}

export interface InjuryStatus {
  /** Yahoo's short code, e.g. "Q", "O", "IR", "D", "SUSP". */
  code: string
  /** Human label when available, e.g. "Questionable". */
  label?: string
  /** Free text detail, e.g. "Hamstring". */
  detail?: string
}

export interface PlayerOwnership {
  /** Percent of leagues where the player is rostered, 0-100. */
  percentOwned?: number
  /** Percent of leagues where the player is started, 0-100. */
  percentStarted?: number
  /** Change in percent owned over the last week. */
  percentOwnedDelta?: number
}

export interface PlayerPoints {
  /** Fantasy points scored so far this season. */
  season?: number
  /** Average fantasy points per game. */
  average?: number
  /** Points in the most recently completed week. */
  lastWeek?: number
  /** Provider's projection for the current week. */
  projected?: number
}

export interface Player {
  /** Stable id. Yahoo player key when scraped, synthetic id in demo data. */
  id: string
  name: string
  position: PlayerPosition
  /** Secondary eligibility, e.g. a WR who is also RB-eligible. */
  eligiblePositions?: PlayerPosition[]
  /** NFL team abbreviation, e.g. "KC". Empty for free agents without a team. */
  nflTeam: string
  byeWeek?: number
  injury?: InjuryStatus
  ownership?: PlayerOwnership
  points?: PlayerPoints
  /** Fantasy team id that rosters this player, or null if a free agent. */
  ownerTeamId?: string | null
  /** Provider's preseason/overall rank, when exposed. */
  rank?: number
}

export interface RosterEntry {
  slot: RosterSlot
  /** True when the slot counts toward the team's score this week. */
  starter: boolean
  player: Player | null
  points?: number
  projected?: number
}

export interface Team {
  id: string
  name: string
  abbrev?: string
  managerName?: string
  logoUrl?: string
  record: Record_
  pointsFor: number
  pointsAgainst: number
  /** Standings position as reported by the provider (1-indexed). */
  rank?: number
  /** e.g. "W3", "L1". */
  streak?: string
  waiverPriority?: number
  movesMade?: number
  tradesMade?: number
  /** True for the league member running Ark. */
  isMine?: boolean
}

export interface MatchupSide {
  teamId: string
  score: number
  projected?: number
}

export interface Matchup {
  week: number
  home: MatchupSide
  away: MatchupSide
  /** Null while the matchup is still in progress or not yet played. */
  winnerTeamId: string | null
  isPlayoff?: boolean
  isConsolation?: boolean
  /** True once the week's scoring is final. */
  final: boolean
}

export interface DraftPick {
  overall: number
  round: number
  pickInRound: number
  teamId: string
  playerId?: string
  playerName: string
  position?: PlayerPosition
  nflTeam?: string
  /** Auction leagues only. */
  cost?: number
}

export interface RosterSlotConfig {
  slot: RosterSlot
  count: number
}

export interface League {
  id: string
  provider: ProviderId
  name: string
  season: number
  numTeams: number
  /** The week the league is currently playing. */
  currentWeek: number
  /** Last week of the regular season. */
  regularSeasonWeeks: number
  /** Number of teams that make the playoffs. */
  playoffTeams: number
  /** e.g. "Head-to-Head Points", "Head-to-Head Categories". */
  scoringType?: string
  /** "standard" | "ppr" | "half-ppr" when it can be determined. */
  pprType?: 'standard' | 'half-ppr' | 'ppr' | 'unknown'
  isAuction?: boolean
  rosterSlots?: RosterSlotConfig[]
  url?: string
}

/**
 * Where the numbers driving start/sit, waivers and trades came from.
 *
 * Every manager tool ranks players by a projection. When the provider does not
 * expose one, Ark falls back to season form — which is a materially worse basis
 * for a weekly decision, and the user has a right to know it happened rather
 * than being handed confident-looking output built on a guess.
 */
export type ProjectionSource =
  /** The provider gave real per-week projections. */
  | 'provider'
  /** No projections found; ranking by each player's season average instead. */
  | 'season-average'
  /** Neither available — rankings are not meaningful. */
  | 'none'

export interface DataQuality {
  projections: ProjectionSource
  /** How many rostered players carry a usable number. */
  playersWithProjections: number
  totalRosteredPlayers: number
  /** Human-readable explanation when quality is degraded. */
  notes: string[]
}

/**
 * Everything Ark knows about a league at a point in time. This is what gets
 * written to disk by the sync command and served by the API.
 */
export interface LeagueSnapshot {
  league: League
  teams: Team[]
  /** Every matchup for every week the provider exposed. */
  matchups: Matchup[]
  /** Roster entries keyed by team id. */
  rosters: Record<string, RosterEntry[]>
  /** The player pool: rostered players plus available free agents. */
  players: Player[]
  draft: DraftPick[]
  /** ISO timestamp of when this snapshot was produced. */
  fetchedAt: string
  /** Non-fatal problems hit while building the snapshot. */
  warnings: string[]
  /** How much to trust the numbers in this snapshot. */
  dataQuality?: DataQuality
}

// --- Analytics --------------------------------------------------------------

export interface TeamWeekScore {
  teamId: string
  week: number
  points: number
  opponentId: string
  won: boolean | null
}

export interface PowerRanking {
  teamId: string
  rank: number
  /** Composite 0-100 score. */
  score: number
  /** Component parts, each 0-100, so the UI can explain the number. */
  components: {
    scoring: number
    consistency: number
    recentForm: number
    winRate: number
  }
  /** Change vs the previous week's power rank. Positive means improved. */
  delta: number | null
}

export interface LuckRating {
  teamId: string
  /** Record against the entire league every week. */
  allPlay: Record_
  /** Win rate implied by all-play, 0-1. */
  expectedWinPct: number
  /** Actual win rate, 0-1. */
  actualWinPct: number
  /** actual minus expected wins. Positive means lucky. */
  luckWins: number
}

export interface ScheduleStrength {
  teamId: string
  /** Average points scored by opponents faced so far. */
  pastOpponentAvg: number
  /** Average season PPG of opponents still to be played. */
  futureOpponentAvg: number
  /** Rank 1 = hardest remaining schedule. */
  futureRank: number
}

export interface PlayoffOdds {
  teamId: string
  /** Probability of making the playoffs, 0-1. */
  makePlayoffs: number
  /** Probability of the #1 seed, 0-1. */
  topSeed: number
  /** Probability of winning the championship, 0-1. */
  winTitle: number
  /** Mean projected final wins. */
  projectedWins: number
  /** Mean projected final seed. */
  projectedSeed: number
}

export interface LeagueAnalytics {
  powerRankings: PowerRanking[]
  luck: LuckRating[]
  scheduleStrength: ScheduleStrength[]
  playoffOdds: PlayoffOdds[]
  /** Per-team weekly scores, for charts. */
  weeklyScores: TeamWeekScore[]
  /** Number of Monte Carlo seasons simulated for the odds above. */
  simulations: number
}
