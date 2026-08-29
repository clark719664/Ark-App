import fs from 'node:fs'
import path from 'node:path'
import type { Player } from '../shared/types.js'
import { currentNflSeason } from './config.js'

/**
 * The draft pool: every NFL player worth drafting, with a projection.
 *
 * A draft happens before a league has any data to sync, so the board cannot
 * depend on the Yahoo path being calibrated or even configured. This reads a
 * committed file built from open data, so a fresh clone can run a live draft
 * with nothing but `npm run dev`.
 */

export interface DraftPoolPlayer {
  playerId: string
  name: string
  position: string
  team: string
  age: number | null
  projectedPpg: number
  projectedSeason: number
  depthRank: number | null
  seasonsOfData: number
  gamesOfData: number
  lastSeasonPpg: number | null
  basis: 'production' | 'thin-history' | 'no-history'
  /** The week this player's NFL team is off. Null when the schedule is unknown. */
  byeWeek?: number | null
  notes: string[]
}

export interface DraftPool {
  season: number
  generatedAt: string
  source: string
  method: string
  /** Whether the build that produced this pool had depth chart data to use. */
  usedDepthChart?: boolean
  players: DraftPoolPlayer[]
}

let cached: DraftPool | null = null
let cachedSeason = 0

function poolPath(season: number): string {
  return path.resolve(process.cwd(), 'data', 'derived', `draft-pool-${season}.json`)
}

/** The newest committed pool, preferring the upcoming season. */
export function loadDraftPool(file?: string): DraftPool | null {
  // A linked league has a board priced in its own scoring; without one this
  // falls back to the single shared pool.
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as DraftPool
    } catch {
      return null
    }
  }
  const upcoming = currentNflSeason() + 1
  for (const season of [upcoming, upcoming - 1]) {
    if (cached && cachedSeason === season) return cached

    const file = poolPath(season)
    if (!fs.existsSync(file)) continue

    try {
      cached = JSON.parse(fs.readFileSync(file, 'utf8')) as DraftPool
      cachedSeason = season
      return cached
    } catch {
      // A malformed pool should fall through to the next candidate rather than
      // taking the draft board down on the morning of a draft.
    }
  }
  return null
}

/** Present a pool entry the way the rest of the app models a player. */
export function toPlayer(entry: DraftPoolPlayer): Player {
  return {
    id: entry.playerId,
    name: entry.name,
    position: entry.position as Player['position'],
    nflTeam: entry.team,
    ownerTeamId: null,
    points: {
      projected: entry.projectedPpg,
      season: entry.projectedSeason,
      average: entry.projectedPpg,
    },
  }
}

export interface LeagueShape {
  teams: number
  starters: Record<string, number>
  /** Fraction of flex spots typically filled by each position. */
  flexShare: Record<string, number>
}

export const DEFAULT_SHAPE: LeagueShape = {
  teams: 12,
  starters: { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1 },
  flexShare: { RB: 0.4, WR: 0.5, TE: 0.1 },
}

export interface RankedPlayer extends DraftPoolPlayer {
  /** Projected points above the last startable player at the position. */
  vorp: number
  /** Rank within the position by projection. */
  positionRank: number
  overallRank: number
}

/**
 * Rank the pool by value over replacement rather than raw projection.
 *
 * Raw points put nine quarterbacks in the top twenty, which is the single most
 * common way a draft board misleads: in a one-quarterback league the twelfth
 * best quarterback is nearly as good as the third, so none of them is worth an
 * early pick. Replacement level is the last player at each position who will
 * actually start somewhere in the league, flex spots included.
 */
export function rankPool(pool: DraftPool, shape: LeagueShape = DEFAULT_SHAPE): RankedPlayer[] {
  const byPosition = new Map<string, DraftPoolPlayer[]>()
  for (const player of pool.players) {
    const list = byPosition.get(player.position)
    if (list) list.push(player)
    else byPosition.set(player.position, [player])
  }
  for (const list of byPosition.values()) {
    list.sort((a, b) => b.projectedSeason - a.projectedSeason)
  }

  const replacement = new Map<string, number>()
  for (const [position, starters] of Object.entries(shape.starters)) {
    const list = byPosition.get(position) ?? []
    const startable = Math.round((starters + (shape.flexShare[position] ?? 0)) * shape.teams)
    const index = Math.min(Math.max(startable, 1), list.length) - 1
    replacement.set(position, list[index]?.projectedSeason ?? 0)
  }

  const ranked: RankedPlayer[] = []
  for (const [position, list] of byPosition) {
    const bar = replacement.get(position)
    // A position the league does not start is not draftable.
    if (bar === undefined) continue

    for (const [index, player] of list.entries()) {
      ranked.push({
        ...player,
        vorp: Math.round((player.projectedSeason - bar) * 10) / 10,
        positionRank: index + 1,
        overallRank: 0,
      })
    }
  }

  ranked.sort((a, b) => b.vorp - a.vorp)
  ranked.forEach((player, index) => {
    player.overallRank = index + 1
  })

  return ranked
}
