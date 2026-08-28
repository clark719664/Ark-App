import type { Player, RosterEntry } from '../shared/types.js'
import { isBenchSlot } from '../server/analytics/slots.js'
import type { Agent, AgentView } from './agents.js'
import {
  advanceWeek, buildPlayerPool, drawScore, makeRng, recordResult, willPlay,
  type PlayerState, type Rng, type TruePlayer,
} from './world.js'

/**
 * One simulated season, start to finish.
 *
 * Draft, then week by week: refresh projections and injuries, let every agent
 * set a lineup and make a waiver claim, play the games, update standings. Then
 * a seeded bracket. The only thing that separates the teams is their manager.
 */

export const STARTING_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF']
const BENCH_SIZE = 6
const REGULAR_SEASON_WEEKS = 14
const PLAYOFF_TEAMS = 6
const NUM_TEAMS = 12

export interface TeamResult {
  teamId: string
  agentName: string
  wins: number
  losses: number
  pointsFor: number
  pointsAgainst: number
  seed: number | null
  madePlayoffs: boolean
  wonTitle: boolean
  /** Points that were on the bench in a lineup the manager could have started. */
  pointsLeftOnBench: number
  /**
   * Hidden true talent of the roster at season's end — the sum of the ten best
   * players' real weekly means. Agents cannot see this; it is here to show
   * whether a strategy's roster genuinely improved or whether it only chased
   * lucky projections.
   */
  endingTalent: number
  /** True talent of the drafted roster, for comparison. */
  draftedTalent: number
}

interface Team {
  id: string
  agent: Agent
  roster: string[]
  draftedTalent: number
  wins: number
  losses: number
  pointsFor: number
  pointsAgainst: number
  pointsLeftOnBench: number
  /** Lower is better; the worst record gets first claim next week. */
  waiverPriority: number
}

/**
 * A snake draft by projection, so every manager starts from a comparable roster
 * and later differences come from in-season management rather than the draft.
 */
function draft(teams: Team[], pool: TruePlayer[], state: Map<string, PlayerState>): void {
  const available = [...pool].sort(
    (a, b) => (state.get(b.id)?.projection ?? 0) - (state.get(a.id)?.projection ?? 0),
  )
  const rounds = STARTING_SLOTS.length + BENCH_SIZE

  // Caps stop one team hoarding a position, and the last two rounds are set
  // aside for kicker and defense. Without that reservation the snake forces
  // whoever picks at the turn to spend a mid round on a kicker, which handed
  // some seats materially better rosters than others before the season began.
  const CAPS: Record<string, number> = { QB: 2, RB: 6, WR: 7, TE: 2, K: 1, DEF: 1 }
  const LATE_ROUNDS = 2

  const countsOf = (team: Team): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const id of team.roster) {
      const player = pool.find((p) => p.id === id)
      if (player) counts.set(player.position, (counts.get(player.position) ?? 0) + 1)
    }
    return counts
  }

  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? teams : [...teams].reverse()
    const late = round >= rounds - LATE_ROUNDS

    for (const team of order) {
      const counts = countsOf(team)

      const wanted = (player: TruePlayer): boolean => {
        const held = counts.get(player.position) ?? 0
        if (held >= (CAPS[player.position] ?? 99)) return false
        // Kicker and defense are worth one late pick each, never an early one.
        if (['K', 'DEF'].includes(player.position)) return late
        return true
      }

      // Late on, a still-missing kicker or defense is the priority.
      const missing = late
        ? ['K', 'DEF'].filter((position) => (counts.get(position) ?? 0) === 0)
        : []

      const index =
        missing.length > 0
          ? available.findIndex((player) => missing.includes(player.position))
          : available.findIndex(wanted)

      const pick = available.splice(index === -1 ? 0 : index, 1)[0]
      if (pick) team.roster.push(pick.id)
    }
  }
}

/** Round robin via the circle method, so the schedule is balanced. */
function schedule(teamCount: number, weeks: number): Array<Array<[number, number]>> {
  const rotation = Array.from({ length: teamCount }, (_, i) => i)
  const result: Array<Array<[number, number]>> = []

  for (let week = 0; week < weeks; week += 1) {
    const pairs: Array<[number, number]> = []
    for (let i = 0; i < teamCount / 2; i += 1) {
      const home = rotation[i]
      const away = rotation[teamCount - 1 - i]
      if (home !== undefined && away !== undefined) pairs.push([home, away])
    }
    result.push(pairs)

    const fixed = rotation[0]!
    const rest = rotation.slice(1)
    const last = rest.pop()!
    rotation.splice(0, rotation.length, fixed, last, ...rest)
  }
  return result
}

/** Present a team's roster the way the app models one. */
function toRoster(
  roster: string[],
  pool: Map<string, TruePlayer>,
  state: Map<string, PlayerState>,
  teamId: string,
  week: number,
): RosterEntry[] {
  return roster.map((id, index) => {
    const truth = pool.get(id)!
    const seen = state.get(id)!

    const player: Player = {
      id: truth.id,
      name: truth.name,
      position: truth.position,
      nflTeam: truth.nflTeam,
      byeWeek: truth.byeWeek,
      ownerTeamId: teamId,
      points: {
        projected: seen.projection,
        ...(seen.gamesPlayed > 0
          ? { season: seen.seasonPoints, average: seen.seasonPoints / seen.gamesPlayed }
          : {}),
      },
      ...(seen.injury.kind === 'out'
        ? { injury: { code: 'O', label: 'Out' } }
        : seen.injury.kind === 'questionable'
          ? { injury: { code: 'Q', label: 'Questionable' } }
          : {}),
    }

    // Slot labels here are only a starting point; agents return their own.
    const slot = index < STARTING_SLOTS.length ? STARTING_SLOTS[index]! : 'BN'
    return {
      slot,
      starter: !isBenchSlot(slot),
      player,
      projected: truth.byeWeek === week ? 0 : seen.projection,
    }
  })
}

function toFreeAgents(
  pool: TruePlayer[],
  owned: Set<string>,
  state: Map<string, PlayerState>,
): Player[] {
  return pool
    .filter((player) => !owned.has(player.id))
    .map((truth) => {
      const seen = state.get(truth.id)!
      return {
        id: truth.id,
        name: truth.name,
        position: truth.position,
        nflTeam: truth.nflTeam,
        byeWeek: truth.byeWeek,
        ownerTeamId: null,
        points: {
          projected: seen.projection,
          ...(seen.gamesPlayed > 0
            ? { season: seen.seasonPoints, average: seen.seasonPoints / seen.gamesPlayed }
            : {}),
        },
        ...(seen.injury.kind === 'out'
          ? { injury: { code: 'O', label: 'Out' } }
          : seen.injury.kind === 'questionable'
            ? { injury: { code: 'Q', label: 'Questionable' } }
            : {}),
      } satisfies Player
    })
    .sort((a, b) => (b.points?.projected ?? 0) - (a.points?.projected ?? 0))
}

export interface SeasonOptions {
  seed: number
  agents: Agent[]
}

export function runSeason(opts: SeasonOptions): TeamResult[] {
  const rng = makeRng(opts.seed)
  const pool = buildPlayerPool(rng)
  const byId = new Map(pool.map((player) => [player.id, player]))
  const state = new Map<string, PlayerState>()

  // Week 0 gives everyone a projection to draft against.
  advanceWeek(rng, pool, state, 0)

  const teams: Team[] = opts.agents.slice(0, NUM_TEAMS).map((agent, index) => ({
    id: String(index + 1),
    agent,
    roster: [],
    wins: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointsLeftOnBench: 0,
    draftedTalent: 0,
    waiverPriority: index,
  }))

  draft(teams, pool, state)
  for (const team of teams) team.draftedTalent = rosterTalent(team.roster, byId)

  const fixtures = schedule(NUM_TEAMS, REGULAR_SEASON_WEEKS)

  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week += 1) {
    advanceWeek(rng, pool, state, week)

    const owned = new Set(teams.flatMap((team) => team.roster))
    const freeAgents = toFreeAgents(pool, owned, state)

    // Opponent strength is what a manager could reasonably estimate: the sum of
    // their opponent's best startable projections.
    const pairs = fixtures[(week - 1) % fixtures.length] ?? []
    const opponentOf = new Map<string, Team>()
    for (const [homeIndex, awayIndex] of pairs) {
      const home = teams[homeIndex]!
      const away = teams[awayIndex]!
      opponentOf.set(home.id, away)
      opponentOf.set(away.id, home)
    }

    const lineups = new Map<string, Array<{ slot: string; playerId: string | null }>>()

    for (const team of teams) {
      const opponent = opponentOf.get(team.id)
      const view: AgentView = {
        roster: toRoster(team.roster, byId, state, team.id, week),
        slots: STARTING_SLOTS,
        week,
        freeAgents,
        opponent: opponent ? estimateOpponent(opponent, byId, state, week) : null,
        rng,
      }
      lineups.set(team.id, team.agent.setLineup(view))
    }

    // Score the week from the hidden truth, not from projections.
    const scored = new Map<string, number>()
    const weekScores = new Map<string, number>()
    for (const player of pool) {
      const seen = state.get(player.id)!
      const played = willPlay(rng, player, seen, week)
      const points = played ? drawScore(rng, player) : 0
      scored.set(player.id, points)
      recordResult(state, player.id, points, played)
    }

    for (const team of teams) {
      const lineup = lineups.get(team.id) ?? []
      const started = new Set(
        lineup.map((slot) => slot.playerId).filter((id): id is string => id !== null),
      )
      const total = [...started].reduce((sum, id) => sum + (scored.get(id) ?? 0), 0)
      weekScores.set(team.id, total)

      // What the best legal lineup would have scored, in hindsight.
      const ideal = idealScore(team.roster, byId, scored)
      team.pointsLeftOnBench += Math.max(0, ideal - total)
    }

    for (const [homeIndex, awayIndex] of pairs) {
      const home = teams[homeIndex]!
      const away = teams[awayIndex]!
      const homeScore = weekScores.get(home.id) ?? 0
      const awayScore = weekScores.get(away.id) ?? 0

      home.pointsFor += homeScore
      home.pointsAgainst += awayScore
      away.pointsFor += awayScore
      away.pointsAgainst += homeScore

      if (homeScore >= awayScore) {
        home.wins += 1
        away.losses += 1
      } else {
        away.wins += 1
        home.losses += 1
      }
    }

    processWaivers(teams, byId, state, pool, week)
  }

  return finishSeason(teams, byId, state, rng)
}

/** What a manager can see of their opponent: best startable projection. */
function estimateOpponent(
  team: Team,
  pool: Map<string, TruePlayer>,
  state: Map<string, PlayerState>,
  week: number,
): { mean: number; spread: number } {
  const projections = team.roster
    .map((id) => {
      const truth = pool.get(id)!
      const seen = state.get(id)!
      if (truth.byeWeek === week || seen.injury.kind === 'out') return { position: truth.position, value: 0 }
      return { position: truth.position, value: seen.projection }
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, STARTING_SLOTS.length)

  const mean = projections.reduce((sum, entry) => sum + entry.value, 0)
  // Roughly the spread of a ten-player lineup; agents are not given the truth.
  return { mean, spread: Math.max(12, mean * 0.19) }
}

function idealScore(
  roster: string[],
  pool: Map<string, TruePlayer>,
  scored: Map<string, number>,
): number {
  // Greedy over the actual results: most restrictive slots first.
  const remaining = [...roster]
  let total = 0

  const order = [...STARTING_SLOTS].sort((a, b) => {
    const aWidth = a.includes('/') ? 3 : 1
    const bWidth = b.includes('/') ? 3 : 1
    return aWidth - bWidth
  })

  for (const slot of order) {
    let bestId: string | null = null
    let bestScore = -1
    for (const id of remaining) {
      const player = pool.get(id)
      if (!player) continue
      const eligible = slot.includes('/')
        ? ['RB', 'WR', 'TE'].includes(player.position)
        : player.position === slot
      if (!eligible) continue
      const score = scored.get(id) ?? 0
      if (score > bestScore) {
        bestScore = score
        bestId = id
      }
    }
    if (bestId) {
      total += bestScore
      remaining.splice(remaining.indexOf(bestId), 1)
    }
  }
  return total
}

/** Sum of the ten best true weekly means on a roster. */
function rosterTalent(roster: string[], pool: Map<string, TruePlayer>): number {
  return roster
    .map((id) => pool.get(id)?.trueMean ?? 0)
    .sort((a, b) => b - a)
    .slice(0, STARTING_SLOTS.length)
    .reduce((sum, value) => sum + value, 0)
}

function processWaivers(
  teams: Team[],
  pool: Map<string, TruePlayer>,
  state: Map<string, PlayerState>,
  allPlayers: TruePlayer[],
  week: number,
): void {
  // Worst record claims first, which is how waiver priority works.
  const order = [...teams].sort((a, b) => a.wins - b.wins || a.pointsFor - b.pointsFor)

  for (const team of order) {
    const owned = new Set(teams.flatMap((t) => t.roster))
    const freeAgents = toFreeAgents(allPlayers, owned, state)

    const claim = team.agent.waiverClaim({
      roster: toRoster(team.roster, pool, state, team.id, week),
      slots: STARTING_SLOTS,
      week,
      freeAgents,
      opponent: null,
      rng: makeRng(week * 31 + Number(team.id)),
    })

    if (!claim) continue
    const dropIndex = team.roster.indexOf(claim.drop.id)
    if (dropIndex === -1) continue
    if (owned.has(claim.add.id)) continue

    team.roster.splice(dropIndex, 1)
    team.roster.push(claim.add.id)
  }
}

function finishSeason(
  teams: Team[],
  pool: Map<string, TruePlayer>,
  state: Map<string, PlayerState>,
  rng: Rng,
): TeamResult[] {
  const standings = [...teams].sort(
    (a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor,
  )

  const seeds = new Map(standings.map((team, index) => [team.id, index + 1]))
  const field = standings.slice(0, PLAYOFF_TEAMS)

  const champion = playBracket(field, pool, state, rng)

  return teams.map((team) => ({
    teamId: team.id,
    agentName: team.agent.name,
    wins: team.wins,
    losses: team.losses,
    pointsFor: Number(team.pointsFor.toFixed(1)),
    pointsAgainst: Number(team.pointsAgainst.toFixed(1)),
    seed: seeds.get(team.id) ?? null,
    madePlayoffs: (seeds.get(team.id) ?? 99) <= PLAYOFF_TEAMS,
    wonTitle: champion?.id === team.id,
    pointsLeftOnBench: Number(team.pointsLeftOnBench.toFixed(1)),
    endingTalent: Number(rosterTalent(team.roster, pool).toFixed(1)),
    draftedTalent: Number(team.draftedTalent.toFixed(1)),
  }))
}

/**
 * A seeded bracket with byes for the top two. Playoff weeks are simulated the
 * same way as the regular season: agents set a lineup, and the hidden truth
 * decides it.
 */
function playBracket(
  field: Team[],
  pool: Map<string, TruePlayer>,
  state: Map<string, PlayerState>,
  rng: Rng,
): Team | undefined {
  if (field.length === 0) return undefined

  const score = (team: Team, week: number): number => {
    const view: AgentView = {
      roster: toRoster(team.roster, pool, state, team.id, week),
      slots: STARTING_SLOTS,
      week,
      freeAgents: [],
      opponent: null,
      rng,
    }
    const lineup = team.agent.setLineup(view)
    return lineup.reduce((sum, entry) => {
      if (!entry.playerId) return sum
      const player = pool.get(entry.playerId)
      const seen = state.get(entry.playerId)
      if (!player || !seen) return sum
      return sum + (willPlay(rng, player, seen, week) ? drawScore(rng, player) : 0)
    }, 0)
  }

  let alive = field.slice(0, 2)
  const playIn = field.slice(2)
  let week = REGULAR_SEASON_WEEKS + 1

  const round: Team[] = []
  for (let i = 0; i < playIn.length / 2; i += 1) {
    const high = playIn[i]
    const low = playIn[playIn.length - 1 - i]
    if (!high || !low) continue
    round.push(score(high, week) >= score(low, week) ? high : low)
  }
  alive = [...alive, ...round]

  while (alive.length > 1) {
    week += 1
    const next: Team[] = []
    for (let i = 0; i < alive.length / 2; i += 1) {
      const high = alive[i]
      const low = alive[alive.length - 1 - i]
      if (!high || !low) continue
      next.push(score(high, week) >= score(low, week) ? high : low)
    }
    alive = next
  }

  return alive[0]
}
