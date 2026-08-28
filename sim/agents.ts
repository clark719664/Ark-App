import type { Player, PlayerPosition, RosterEntry } from '../shared/types.js'
import { bestLineupByRosterValue, rosterValue } from '../server/analytics/lineup.js'
import { analyseLineupRisk } from '../server/analytics/risk.js'
import { canFill, slotEligibility } from '../server/analytics/slots.js'
import type { Rng } from './world.js'

/**
 * The competing managers.
 *
 * Every agent sees exactly the same information: this week's projections, the
 * injury designations, its own roster and the free agent pool. What differs is
 * only what each one does with that. Any advantage Ark shows has to come from
 * the decisions, because nothing else is different.
 *
 * The Ark agent deliberately calls the same functions the app serves to users —
 * this is a test of the shipped analytics, not of a reimplementation of them.
 */

export interface AgentView {
  /** Roster as the app would model it, projections already attached. */
  roster: RosterEntry[]
  slots: string[]
  week: number
  /** Free agents, richest first, as the waiver page would show them. */
  freeAgents: Player[]
  /** What this week's opponent is expected to score, and how variable they are. */
  opponent: { mean: number; spread: number } | null
  rng: Rng
}

export interface WaiverClaim {
  add: Player
  drop: Player
}

export interface Agent {
  readonly name: string
  readonly description: string
  /** Which players to start, as slot assignments. */
  setLineup(view: AgentView): Array<{ slot: string; playerId: string | null }>
  /** One claim per week, or null to pass. */
  waiverClaim(view: AgentView): WaiverClaim | null
}

const projectionOf = (entry: RosterEntry): number =>
  entry.projected ?? entry.player?.points?.projected ?? 0

const playerProjection = (player: Player): number => player.points?.projected ?? 0

/** Add/drop decisions are about the rest of the season, not about Sunday. */
const keepValue = (player: Player): number => rosterValue(player)

/** Slot assignments from a set of chosen players, most restrictive slot first. */
function assign(
  candidates: Array<{ player: Player; projection: number }>,
  slots: string[],
): Array<{ slot: string; playerId: string | null }> {
  const ordered = slots
    .map((slot, index) => ({ slot, index, width: slotEligibility(slot)?.length ?? 99 }))
    .sort((a, b) => a.width - b.width || a.index - b.index)

  const used = new Set<string>()
  const chosen = new Map<number, string>()

  for (const { slot, index } of ordered) {
    const best = candidates
      .filter(
        (candidate) =>
          !used.has(candidate.player.id) &&
          canFill(slot, candidate.player.position, candidate.player.eligiblePositions),
      )
      .sort((a, b) => b.projection - a.projection)[0]
    if (best) {
      used.add(best.player.id)
      chosen.set(index, best.player.id)
    }
  }

  return slots.map((slot, index) => ({ slot, playerId: chosen.get(index) ?? null }))
}

function rosterCandidates(roster: RosterEntry[]): Array<{ player: Player; projection: number }> {
  return roster
    .filter((entry) => entry.player !== null)
    .map((entry) => ({ player: entry.player!, projection: projectionOf(entry) }))
}

/**
 * The weakest player on a roster, used as the drop when claiming. Positional
 * scarcity is respected: dropping your only kicker to add a fourth receiver
 * costs more than it gains, and no sensible manager does it.
 */
function dropCandidate(roster: RosterEntry[], slots: string[]): Player | null {
  const players = roster
    .map((entry) => entry.player)
    .filter((player): player is Player => player !== null)

  const counts = new Map<PlayerPosition, number>()
  for (const player of players) counts.set(player.position, (counts.get(player.position) ?? 0) + 1)

  const required = new Map<PlayerPosition, number>()
  for (const slot of slots) {
    for (const position of slotEligibility(slot) ?? []) {
      // A flex slot means one more body is needed across its eligible positions.
      required.set(position, Math.max(required.get(position) ?? 0, 1))
    }
  }

  const droppable = players.filter((player) => {
    const held = counts.get(player.position) ?? 0
    const need = required.get(player.position) ?? 0
    return held > need
  })

  const pool = droppable.length > 0 ? droppable : players
  return [...pool].sort((a, b) => keepValue(a) - keepValue(b))[0] ?? null
}

/**
 * How much better a free agent must look before it is worth a claim.
 *
 * Selecting the maximum of many noisy estimates is biased upward — the winner's
 * curse — so a threshold near zero means constant churn toward whoever got a
 * lucky projection. Measured in simulation, no margin cost about 13 points of
 * true roster talent per season.
 */
const ARK_CLAIM_MARGIN = 1.0

// --- Ark: the shipped analytics ---------------------------------------------

export class ArkAgent implements Agent {
  readonly name = 'Ark'
  readonly description =
    'Optimal lineup, switched to the win-probability lineup when the matchup calls for it; ' +
    'claims free agents by how much they raise the best lineup it can field.'

  setLineup(view: AgentView) {
    // With no opponent to measure against there is no win probability to
    // maximise, so fall back to the points-optimal lineup.
    if (!view.opponent) {
      return assign(this.startable(view), view.slots)
    }

    const analysis = analyseLineupRisk(view.roster, view.slots, view.opponent, view.week)
    return analysis.byWinProbability.assignments.map((entry) => ({
      slot: entry.slot,
      playerId: entry.player?.id ?? null,
    }))
  }

  waiverClaim(view: AgentView): WaiverClaim | null {
    const players = view.roster
      .map((entry) => entry.player)
      .filter((player): player is Player => player !== null)

    const base = bestLineupByRosterValue(players, view.slots)
    const drop = dropCandidate(view.roster, view.slots)
    if (!drop) return null

    const kept = players.filter((player) => player.id !== drop.id)

    let best: { add: Player; gain: number } | null = null
    for (const candidate of view.freeAgents.slice(0, 40)) {
      const after = bestLineupByRosterValue([...kept, candidate], view.slots)
      const gain = after - base
      if (!best || gain > best.gain) best = { add: candidate, gain }
    }

    // Picking the best of forty noisy estimates flatters whichever one got the
    // luckiest reading, so a claim has to clear a margin rather than merely
    // look better. Without this the roster churns itself downhill.
    return best && best.gain > ARK_CLAIM_MARGIN ? { add: best.add, drop } : null
  }

  private startable(view: AgentView) {
    return rosterCandidates(view.roster)
  }
}

// --- Projection: what a good conventional tool gives you ---------------------

export class ProjectionAgent implements Agent {
  readonly name = 'Projection'
  readonly description =
    'Always starts the highest projected legal lineup and claims the free agent with the ' +
    'highest projection. This is what a competent conventional tool recommends.'

  setLineup(view: AgentView) {
    return assign(rosterCandidates(view.roster), view.slots)
  }

  waiverClaim(view: AgentView): WaiverClaim | null {
    const drop = dropCandidate(view.roster, view.slots)
    const add = view.freeAgents[0]
    if (!drop || !add) return null
    return playerProjection(add) > playerProjection(drop) ? { add, drop } : null
  }
}

// --- Streamer: churns the wire every week ------------------------------------

export class StreamerAgent implements Agent {
  readonly name = 'Streamer'
  readonly description =
    'Starts the highest projected lineup and always makes a claim, chasing whoever looks best ' +
    'on the wire this week regardless of whether they improve anything.'

  setLineup(view: AgentView) {
    return assign(rosterCandidates(view.roster), view.slots)
  }

  waiverClaim(view: AgentView): WaiverClaim | null {
    const drop = dropCandidate(view.roster, view.slots)
    const add = view.freeAgents[0]
    return drop && add ? { add, drop } : null
  }
}

// --- Set and forget ----------------------------------------------------------

export class SetAndForgetAgent implements Agent {
  readonly name = 'Set & forget'
  readonly description =
    'Sets a lineup once by position and never touches it again — no waiver claims, no reaction ' +
    'to injuries or byes. The manager who drafted in August and stopped paying attention.'

  private locked = new Map<string, Array<{ slot: string; playerId: string | null }>>()

  setLineup(view: AgentView) {
    const key = view.roster
      .map((entry) => entry.player?.id ?? '-')
      .join(',')
      .slice(0, 200)

    const existing = this.locked.get(key)
    if (existing) return existing

    // The one lineup it ever sets is based on the first week's projections.
    const lineup = assign(rosterCandidates(view.roster), view.slots)
    this.locked.set(key, lineup)
    return lineup
  }

  waiverClaim(): WaiverClaim | null {
    return null
  }
}

// --- Random ------------------------------------------------------------------

export class RandomAgent implements Agent {
  readonly name = 'Random'
  readonly description = 'Fills every slot with a random eligible player. The floor.'

  setLineup(view: AgentView) {
    const candidates = rosterCandidates(view.roster)
    const used = new Set<string>()

    return view.slots.map((slot) => {
      const eligible = candidates.filter(
        (candidate) =>
          !used.has(candidate.player.id) &&
          canFill(slot, candidate.player.position, candidate.player.eligiblePositions),
      )
      const pick = eligible[Math.floor(view.rng() * eligible.length)]
      if (pick) used.add(pick.player.id)
      return { slot, playerId: pick?.player.id ?? null }
    })
  }

  waiverClaim(): WaiverClaim | null {
    return null
  }
}

export function buildAgents(): Agent[] {
  // Three of each of the serious strategies, plus the weak ones, so a twelve
  // team league has a realistic mix and no strategy wins on scarcity alone.
  return [
    new ArkAgent(), new ArkAgent(), new ArkAgent(),
    new ProjectionAgent(), new ProjectionAgent(), new ProjectionAgent(),
    new StreamerAgent(), new StreamerAgent(),
    new SetAndForgetAgent(), new SetAndForgetAgent(),
    new RandomAgent(), new RandomAgent(),
  ]
}
