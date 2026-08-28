import type { Player, RosterEntry } from '../../shared/types.js'
import { canFill, isBenchSlot, slotEligibility } from './slots.js'
import { round } from './stats.js'

/**
 * Start/sit optimization.
 *
 * Given a roster and the league's starting slots, work out the highest-scoring
 * legal lineup and compare it to what's actually set. The gap is points left on
 * the bench, which over a season is usually a larger number than any waiver
 * pickup will ever be worth.
 */

export interface LineupAssignment {
  slot: string
  player: Player | null
  projected: number
  /** True when this differs from the manager's current lineup. */
  changed: boolean
}

export interface LineupResult {
  optimal: LineupAssignment[]
  /** Projected total of the lineup currently set. */
  currentProjected: number
  /** Projected total of the best legal lineup. */
  optimalProjected: number
  /** optimalProjected - currentProjected. */
  pointsLeftOnBench: number
  /** Players to bench, paired with who should replace them. */
  swaps: Array<{ slot: string; out: Player; in: Player; gain: number }>
  /** Starters who can't play this week and need replacing. */
  alerts: Array<{ player: Player; reason: string; severity: 'high' | 'medium' }>
}

/** Projection for a player, falling back to season form when none is given. */
export function projectionOf(player: Player | null, entry?: RosterEntry): number {
  if (entry?.projected !== undefined && Number.isFinite(entry.projected)) return entry.projected
  if (!player) return 0
  return player.points?.projected ?? player.points?.average ?? 0
}

const OUT_CODES = new Set(['O', 'IR', 'IR-R', 'SUSP', 'PUP', 'NA', 'D'])

/**
 * What a player is actually worth *this week*. A player on bye or ruled out
 * scores zero however good he is, and pretending otherwise makes a lineup with
 * two byes in it look stronger than the legal lineup that replaces them.
 */
export function effectiveProjection(
  player: Player | null,
  entry: RosterEntry | undefined,
  currentWeek: number | undefined,
): number {
  if (!player) return 0
  if (isUnavailable(player, currentWeek)) return 0
  return projectionOf(player, entry)
}

/**
 * Solve the assignment by filling the most restrictive slots first.
 *
 * This is optimal here, not merely a heuristic: fantasy slot eligibility forms
 * a laminar family — any two slots' eligible sets are either disjoint (QB vs
 * WR) or nested (RB inside FLEX) — and greedy most-restrictive-first is exact
 * on laminar families. A general assignment solver would buy nothing.
 */
export function optimizeLineup(
  roster: RosterEntry[],
  slots: string[],
  currentWeek?: number,
): LineupResult {
  const available = roster
    .filter((entry) => entry.player !== null)
    .map((entry) => ({
      player: entry.player!,
      projected: projectionOf(entry.player, entry),
      entry,
    }))

  // A player on bye or ruled out scores nothing, so never start one.
  const playable = available.filter((candidate) => !isUnavailable(candidate.player, currentWeek))

  // Keep each slot's original position so the result can be presented in the
  // league's own lineup order, while solving in restrictiveness order.
  const orderedSlots = slots
    .map((slot, index) => ({ slot, index, width: slotEligibility(slot)?.length ?? 99 }))
    .sort((a, b) => a.width - b.width || a.index - b.index)

  const used = new Set<string>()
  const assignments = new Map<number, { player: Player; projected: number }>()

  for (const { slot, index } of orderedSlots) {
    const best = playable
      .filter(
        (candidate) =>
          !used.has(candidate.player.id) &&
          canFill(slot, candidate.player.position, candidate.player.eligiblePositions),
      )
      .sort((a, b) => b.projected - a.projected)[0]

    if (best) {
      used.add(best.player.id)
      assignments.set(index, { player: best.player, projected: best.projected })
    }
  }

  const currentStarters = roster.filter((entry) => entry.starter && entry.player)
  const currentProjected = currentStarters.reduce(
    (sum, entry) => sum + effectiveProjection(entry.player, entry, currentWeek),
    0,
  )
  const optimalProjected = [...assignments.values()].reduce((sum, a) => sum + a.projected, 0)

  const currentStarterIds = new Set(currentStarters.map((entry) => entry.player!.id))

  const optimal: LineupAssignment[] = slots.map((slot, index) => {
    const assigned = assignments.get(index)
    return {
      slot,
      player: assigned?.player ?? null,
      projected: round(assigned?.projected ?? 0, 1),
      changed: assigned ? !currentStarterIds.has(assigned.player.id) : false,
    }
  })

  const optimalIds = new Set(
    optimal.map((a) => a.player?.id).filter((id): id is string => id !== undefined),
  )

  // Pair each starter who loses their spot with the bench player taking it,
  // best gain first, so the swaps read as concrete actions.
  const benched = currentStarters
    .filter((entry) => !optimalIds.has(entry.player!.id))
    .map((entry) => ({
      player: entry.player!,
      projected: effectiveProjection(entry.player, entry, currentWeek),
    }))
    .sort((a, b) => a.projected - b.projected)

  // Match the most restrictive slot first, for the same reason the solve does:
  // pairing a flex promotion first would consume the only WR available to
  // displace, and leave a genuine WR change with no partner to report.
  const promoted = optimal
    .filter((a) => a.player !== null && a.changed)
    .map((a) => ({
      slot: a.slot,
      player: a.player!,
      projected: a.projected,
      width: slotEligibility(a.slot)?.length ?? 99,
    }))
    .sort((a, b) => a.width - b.width || b.projected - a.projected)

  // Pair each promotion with the starter it actually displaces: the weakest
  // current starter who is eligible for that same slot. Zipping the two lists
  // positionally would produce nonsense like benching a defense from a WR slot.
  const remaining = [...benched]
  const swaps: LineupResult['swaps'] = []

  for (const incoming of promoted) {
    const candidateIndex = remaining.findIndex((candidate) =>
      canFill(incoming.slot, candidate.player.position, candidate.player.eligiblePositions),
    )
    if (candidateIndex === -1) continue

    const outgoing = remaining.splice(candidateIndex, 1)[0]!
    const gain = round(incoming.projected - outgoing.projected, 1)
    if (gain > 0) {
      swaps.push({ slot: incoming.slot, out: outgoing.player, in: incoming.player, gain })
    }
  }

  swaps.sort((a, b) => b.gain - a.gain)

  return {
    optimal,
    currentProjected: round(currentProjected, 1),
    optimalProjected: round(optimalProjected, 1),
    pointsLeftOnBench: round(Math.max(0, optimalProjected - currentProjected), 1),
    swaps,
    alerts: buildAlerts(currentStarters, currentWeek),
  }
}

export function isUnavailable(player: Player, currentWeek?: number): boolean {
  if (currentWeek !== undefined && player.byeWeek === currentWeek) return true
  return player.injury !== undefined && OUT_CODES.has(player.injury.code)
}

function buildAlerts(
  starters: RosterEntry[],
  currentWeek?: number,
): LineupResult['alerts'] {
  const alerts: LineupResult['alerts'] = []

  for (const entry of starters) {
    const player = entry.player
    if (!player) continue

    if (currentWeek !== undefined && player.byeWeek === currentWeek) {
      alerts.push({ player, reason: `On bye in week ${currentWeek}`, severity: 'high' })
      continue
    }
    if (player.injury && OUT_CODES.has(player.injury.code)) {
      alerts.push({
        player,
        reason: player.injury.label ?? `Listed ${player.injury.code}`,
        severity: 'high',
      })
      continue
    }
    if (player.injury) {
      alerts.push({
        player,
        reason: player.injury.label ?? `Listed ${player.injury.code}`,
        severity: 'medium',
      })
    }
  }

  return alerts
}


export interface BestLineup {
  total: number
  /** Ids of the players who make the lineup. */
  chosenIds: Set<string>
}

/**
 * The best legal starting lineup a set of players can produce in a given week.
 *
 * This is the single value function the manager tools share. Asking "what is
 * this player worth to me" becomes "how much higher is this number with him on
 * the roster", which handles flex slots, byes and injuries correctly without
 * any per-position rules of thumb.
 */
export function bestLineup(
  players: Player[],
  slots: string[],
  currentWeek?: number,
): BestLineup {
  const ordered = slots
    .map((slot, index) => ({ slot, index, width: slotEligibility(slot)?.length ?? 99 }))
    .sort((a, b) => a.width - b.width || a.index - b.index)

  const chosenIds = new Set<string>()
  let total = 0

  for (const { slot } of ordered) {
    let best: { player: Player; value: number } | null = null
    for (const player of players) {
      if (chosenIds.has(player.id)) continue
      if (!canFill(slot, player.position, player.eligiblePositions)) continue
      const value = effectiveProjection(player, undefined, currentWeek)
      if (!best || value > best.value) best = { player, value }
    }
    if (best && best.value > 0) {
      chosenIds.add(best.player.id)
      total += best.value
    }
  }

  return { total, chosenIds }
}

/** Slots to use when the league didn't report its lineup configuration. */
export const DEFAULT_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'W/R/T', 'K', 'DEF']

export function resolveSlots(
  configured: Array<{ slot: string; count: number }> | undefined,
  roster: RosterEntry[],
): string[] {
  const fromConfig = (configured ?? [])
    .filter(({ slot }) => !isBenchSlot(slot))
    .flatMap(({ slot, count }) => Array.from({ length: count }, () => slot))
  if (fromConfig.length > 0) return fromConfig

  // Fall back to the slots the roster itself is using.
  const fromRoster = roster.filter((entry) => entry.starter).map((entry) => entry.slot)
  return fromRoster.length > 0 ? fromRoster : DEFAULT_SLOTS
}

/**
 * A player's value for *roster* decisions, as opposed to lineup decisions.
 *
 * These are two different questions and they want two different numbers. Whom
 * to start this week is answered by this week's projection. Whom to add or drop
 * is a question about the rest of the season, and answering it with a single
 * week's projection is a mistake with a name: ranking candidates by a noisy
 * estimate and taking the maximum systematically selects for players whose
 * noise happened to be favourable, and drops players whose noise happened to be
 * bad. Do that every week and the roster decays.
 *
 * It is not a hypothetical. In a 600-season simulation, ranking waiver claims
 * on weekly projections alone cost about 13 points of true roster talent over a
 * season while strategies that transacted less actually gained. So a roster
 * decision blends the current projection with the player's season-long form,
 * weighted by how much of that season has actually been observed.
 */
const ROSTER_VALUE_PRIOR_GAMES = 3

export function rosterValue(player: Player | null): number {
  if (!player) return 0

  const projection = player.points?.projected
  const average = player.points?.average
  const season = player.points?.season

  if (average === undefined) return projection ?? 0
  if (projection === undefined) return average

  // Infer how many games the average is built on; more evidence, more weight.
  const games = season !== undefined && average > 0 ? Math.max(1, Math.round(season / average)) : 1
  const weight = games / (games + ROSTER_VALUE_PRIOR_GAMES)

  return weight * average + (1 - weight) * projection
}

/**
 * The best lineup a set of players supports, valued for the rest of the season
 * rather than for one week. Bye weeks and short-term injury tags are ignored on
 * purpose: a player is not worth less to a roster because he is off this Sunday.
 */
export function bestLineupByRosterValue(players: Player[], slots: string[]): number {
  const ordered = slots
    .map((slot, index) => ({ slot, index, width: slotEligibility(slot)?.length ?? 99 }))
    .sort((a, b) => a.width - b.width || a.index - b.index)

  const used = new Set<string>()
  let total = 0

  for (const { slot } of ordered) {
    let best: { id: string; value: number } | null = null
    for (const player of players) {
      if (used.has(player.id)) continue
      if (!canFill(slot, player.position, player.eligiblePositions)) continue
      const value = rosterValue(player)
      if (!best || value > best.value) best = { id: player.id, value }
    }
    if (best && best.value > 0) {
      used.add(best.id)
      total += best.value
    }
  }

  return total
}
