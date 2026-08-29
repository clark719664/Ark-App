import type { DraftPick, YahooPlayer } from './yahoo/draftFeed.js'
import {
  DEFAULT_SHAPE,
  loadDraftPool,
  rankPool,
  type LeagueShape,
  type RankedPlayer,
} from './draftPool.js'

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
  /**
   * How many picks pass before the seat next chooses *after* the choice it is
   * making now.
   *
   * This is the horizon a cliff should be measured over, and on your own turn
   * it is not `picksUntilNext`: that is zero, which says nothing falls away
   * before you pick, which is true and useless. The question on the clock is
   * what survives to the pick after this one.
   */
  cliffHorizon: number | null
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
  const mine = snakePicks(opts.teams, opts.position, opts.rounds)
  const nextPick = mine.find((pick) => pick >= onTheClock) ?? null
  const picksUntilNext = nextPick === null ? null : nextPick - onTheClock
  const following = nextPick === null ? null : (mine.find((pick) => pick > nextPick) ?? null)

  return {
    taken,
    available,
    myRoster,
    nextPick,
    picksUntilNext,
    onTheClock,
    cliffHorizon:
      picksUntilNext === null ? null
      : picksUntilNext > 0 ? picksUntilNext
      // On the clock: look past this pick to the one after it. Null in the
      // final round, where there is no next pick to lose anyone to.
      : following === null ? null
      : following - onTheClock,
  }
}

/** Positions a flex spot accepts. */
export const FLEX_POSITIONS = new Set(['RB', 'WR', 'TE'])

/** The key flex spots are counted under, so the UI can name them.  */
export const FLEX_SLOT = 'FLEX'

/**
 * What the roster still needs, so a recommendation can prefer a starter at an
 * empty slot over a marginally better player at one already filled.
 *
 * Flex spots are counted separately rather than folded into RB, WR and TE. A
 * league with a flex has ten starters and only nine named slots, so counting
 * the named ones alone declares the lineup full a player early — which reads
 * as "you are done at running back" while the flex is still empty, and hides
 * exactly the cliff you would want to see.
 */
export function remainingNeeds(
  roster: RankedPlayer[],
  starters: Record<string, number>,
  flexSpots = 0,
): Record<string, number> {
  const needs: Record<string, number> = {}
  for (const [position, count] of Object.entries(starters)) needs[position] = count

  let flexLeft = flexSpots
  for (const player of roster) {
    const current = needs[player.position]
    if (current !== undefined && current > 0) {
      needs[player.position] = current - 1
      continue
    }
    // A player past his named slots falls into the flex, if one is open.
    if (flexLeft > 0 && FLEX_POSITIONS.has(player.position)) flexLeft -= 1
  }

  if (flexSpots > 0) needs[FLEX_SLOT] = flexLeft
  return needs
}

/** Whether one more of this position would fill a slot that is still open. */
export function fillsOpenSlot(position: string, needs: Record<string, number>): boolean {
  if ((needs[position] ?? 0) > 0) return true
  return FLEX_POSITIONS.has(position) && (needs[FLEX_SLOT] ?? 0) > 0
}

/**
 * How many flex spots a shape carries.
 *
 * The shape stores flex as the share of it each position typically fills, which
 * is what replacement level needs; the shares are cut from one flex spot each,
 * so they sum back to the count.
 */
export function flexCount(shape: LeagueShape): number {
  return Math.round(Object.values(shape.flexShare).reduce((sum, share) => sum + share, 0))
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

  // Board rank by id, so survivorship is a lookup rather than an indexOf scan
  // of the whole board once per position on every poll.
  const boardRank = new Map<string, number>()
  available.forEach((player, index) => boardRank.set(player.playerId, index))

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
    const survivors = pool.filter(
      (player) => (boardRank.get(player.playerId) ?? 0) >= picksUntilNext,
    )
    const bestLater = survivors[0] ?? null
    const drop = bestLater ? bestNow.vorp - bestLater.vorp : bestNow.vorp
    output.push({ position, bestNow, bestLater, drop })
  }

  return output.sort((a, b) => b.drop - a.drop)
}

export function loadBoard(shape: LeagueShape, poolFile?: string): RankedPlayer[] {
  const pool = loadDraftPool(poolFile)
  if (!pool) {
    throw new Error(
      poolFile
        ? `No board at ${poolFile}. Run: npm run league:link`
        : 'No draft pool. Run: npm run data:draft 2026',
    )
  }
  return rankPool(pool, shape)
}

/**
 * The league's shape, preferring anything set explicitly and otherwise using
 * what Yahoo reports for the league itself.
 *
 * Six environment variables previously had to agree with the league or the
 * board was quietly wrong about the seat, the round count or which slots were
 * open. Detection removes that class of mistake; the overrides remain because a
 * commissioner can change a setting after a draft order has gone out.
 */
export function shapeFromEnv(detected?: {
  teams?: number
  starters?: Record<string, number>
  flex?: number
}): LeagueShape {
  const starters = { ...(detected?.starters ?? DEFAULT_SHAPE.starters) }
  for (const position of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    const raw = process.env[`SHAPE_${position}`]
    if (raw === undefined) continue
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 0) starters[position] = parsed
  }

  const teamsEnv = Number.parseInt(process.env['LEAGUE_TEAMS'] ?? '', 10)
  const teams = Number.isFinite(teamsEnv) && teamsEnv > 0
    ? teamsEnv
    : detected?.teams && detected.teams > 0
      ? detected.teams
      : DEFAULT_SHAPE.teams

  const flexEnv = Number.parseInt(process.env['SHAPE_FLEX'] ?? '', 10)
  const flex = Number.isFinite(flexEnv) && flexEnv >= 0 ? flexEnv : detected?.flex
  const flexShare =
    flex !== undefined && flex >= 0
      ? { RB: 0.4 * flex, WR: 0.5 * flex, TE: 0.1 * flex }
      : { ...DEFAULT_SHAPE.flexShare }

  return { teams, starters, flexShare }
}
