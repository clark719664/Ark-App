import type { DraftPick, YahooPlayer } from './yahoo/draftFeed.js'
import { loadDraftPool, rankPool, type LeagueShape, type RankedPlayer } from './draftPool.js'

/**
 * Turning a stream of Yahoo picks into advice.
 *
 * The feed names players by Yahoo's own key; the board ranks players by
 * nflverse id. Nothing joins those two but the name, so matching is done here
 * and anything that fails to match is reported rather than dropped: a pick
 * that silently fails to come off the board leaves a drafted player sitting at
 * the top of your recommendations, which is worse than no tool at all.
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

export function normalizeName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[.'`’-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = cleaned.split(' ').filter((part) => !SUFFIXES.has(part))
  return parts.join(' ')
}

/** Yahoo writes team codes in mixed case and disagrees on a few franchises. */
const TEAM_ALIASES: Record<string, string> = {
  jac: 'JAX',
  wsh: 'WAS',
  lar: 'LA',
  sd: 'LAC',
  oak: 'LV',
  stl: 'LA',
}

export function normalizeTeam(team: string): string {
  const upper = team.trim().toUpperCase()
  return TEAM_ALIASES[upper.toLowerCase()] ?? upper
}

export interface MatchResult {
  byPlayerKey: Map<string, RankedPlayer>
  unmatched: YahooPlayer[]
}

/**
 * Join Yahoo's player list to the ranked board.
 *
 * Defences are matched on team rather than name, because Yahoo calls them by
 * city and the pool calls them by abbreviation.
 */
export function matchPlayers(yahoo: YahooPlayer[], board: RankedPlayer[]): MatchResult {
  const byName = new Map<string, RankedPlayer[]>()
  const byTeamDefense = new Map<string, RankedPlayer>()

  for (const player of board) {
    if (player.position === 'DEF') {
      byTeamDefense.set(normalizeTeam(player.team ?? ''), player)
      continue
    }
    const key = normalizeName(player.name)
    const list = byName.get(key)
    if (list) list.push(player)
    else byName.set(key, [player])
  }

  const byPlayerKey = new Map<string, RankedPlayer>()
  const unmatched: YahooPlayer[] = []

  for (const player of yahoo) {
    if (player.position === 'DEF') {
      const defense = byTeamDefense.get(normalizeTeam(player.team))
      if (defense) byPlayerKey.set(player.playerKey, defense)
      else unmatched.push(player)
      continue
    }

    const candidates = byName.get(normalizeName(player.name)) ?? []
    if (candidates.length === 0) {
      unmatched.push(player)
      continue
    }
    // A shared name is resolved by position first, then team.
    const exact =
      candidates.find(
        (candidate) =>
          candidate.position === player.position &&
          normalizeTeam(candidate.team ?? '') === normalizeTeam(player.team),
      ) ??
      candidates.find((candidate) => candidate.position === player.position) ??
      candidates[0]
    if (exact) byPlayerKey.set(player.playerKey, exact)
    else unmatched.push(player)
  }

  return { byPlayerKey, unmatched }
}

/**
 * The overall pick numbers belonging to one seat in a snake draft.
 * Odd rounds run in draft order, even rounds run back.
 */
export function snakePicks(teams: number, position: number, rounds: number): number[] {
  const picks: number[] = []
  for (let round = 1; round <= rounds; round++) {
    const withinRound = round % 2 === 1 ? position : teams - position + 1
    picks.push((round - 1) * teams + withinRound)
  }
  return picks
}

export interface DraftView {
  taken: Set<string>
  available: RankedPlayer[]
  myRoster: RankedPlayer[]
  nextPick: number | null
  picksUntilNext: number | null
  onTheClock: number
}

export function buildView(
  picks: DraftPick[],
  matched: Map<string, RankedPlayer>,
  board: RankedPlayer[],
  opts: { myTeamKey: string; teams: number; position: number; rounds: number },
): DraftView {
  const taken = new Set<string>()
  const myRoster: RankedPlayer[] = []

  for (const pick of picks) {
    const player = matched.get(pick.playerKey)
    if (!player) continue
    taken.add(player.playerId)
    if (pick.teamKey === opts.myTeamKey) myRoster.push(player)
  }

  const available = board.filter((player) => !taken.has(player.playerId))
  const onTheClock = picks.length + 1
  const nextPick =
    snakePicks(opts.teams, opts.position, opts.rounds).find((pick) => pick >= onTheClock) ?? null

  return {
    taken,
    available,
    myRoster,
    nextPick,
    picksUntilNext: nextPick === null ? null : nextPick - onTheClock,
    onTheClock,
  }
}

/**
 * What the roster still needs, so a recommendation can prefer a starter at an
 * empty slot over a marginally better player at one already filled.
 */
export function remainingNeeds(
  roster: RankedPlayer[],
  starters: Record<string, number>,
): Record<string, number> {
  const needs: Record<string, number> = {}
  for (const [position, count] of Object.entries(starters)) needs[position] = count
  for (const player of roster) {
    const current = needs[player.position]
    if (current !== undefined && current > 0) needs[player.position] = current - 1
  }
  return needs
}

/**
 * How far the best player at each position is expected to fall by the time the
 * seat picks again. The gap between the best available now and the best likely
 * to survive is what a pick is actually worth, and it is the only number that
 * says whether a position can wait a round.
 */
export function positionCliffs(
  available: RankedPlayer[],
  picksUntilNext: number | null,
  positions: string[],
): Array<{ position: string; bestNow: RankedPlayer; bestLater: RankedPlayer | null; drop: number }> {
  const output: Array<{
    position: string
    bestNow: RankedPlayer
    bestLater: RankedPlayer | null
    drop: number
  }> = []

  for (const position of positions) {
    const pool = available.filter((player) => player.position === position)
    const bestNow = pool[0]
    if (!bestNow) continue
    if (picksUntilNext === null) {
      output.push({ position, bestNow, bestLater: null, drop: 0 })
      continue
    }
    // Assume every pick between now and the next one takes a ranked player,
    // which is pessimistic but the right direction to be wrong in.
    const survivors = pool.filter((player) => available.indexOf(player) >= picksUntilNext)
    const bestLater = survivors[0] ?? null
    const drop = bestLater ? bestNow.vorp - bestLater.vorp : bestNow.vorp
    output.push({ position, bestNow, bestLater, drop })
  }

  return output.sort((a, b) => b.drop - a.drop)
}

export function loadBoard(shape: LeagueShape): RankedPlayer[] {
  const pool = loadDraftPool()
  if (!pool) throw new Error('No draft pool. Run: npm run data:draft 2026')
  return rankPool(pool, shape)
}
