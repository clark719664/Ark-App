import type { LeagueSnapshot, Player, PlayerPosition, RosterEntry } from '../../shared/types.js'
import type { Impact, ImpactCalculator } from './impact.js'
import { bestLineup, effectiveProjection, projectionOf } from './lineup.js'
import { round } from './stats.js'

/**
 * Waiver wire targets.
 *
 * A free agent is worth a claim only if he changes what you can actually put on
 * the field, so every candidate is valued the same way a trade is: add him to
 * the roster, re-solve the best legal lineup, and see how much the total moves.
 *
 * That definition handles the cases a per-position rule of thumb gets wrong —
 * a flex spot the new player would take instead, a starter who is on bye this
 * week, a second tight end who cannot start because there is only one slot.
 */

export interface WaiverTarget {
  player: Player
  /** Projected points per week this player adds to your best lineup. */
  upgrade: number
  /** The player he pushes out of the starting lineup, if any. */
  replaces: Player | null
  rank: number
  reasons: string[]
  priority: 'high' | 'medium' | 'low'
  /**
   * What the claim does to your season. Priced only for the targets that would
   * actually start for you, since a season simulation per bench stash is a lot
   * of arithmetic to establish that nothing happens.
   */
  impact?: Impact
}

export interface PositionOutlook {
  position: PlayerPosition
  /** Best upgrade available on the wire at this position. */
  bestUpgrade: number
  /** Who that upgrade would be. */
  bestPlayer: Player | null
}

export interface WaiverReport {
  teamId: string
  targets: WaiverTarget[]
  /** Where the wire can help most, best opportunity first. */
  outlook: PositionOutlook[]
  /** Roster holes caused by byes or injuries in the current week. */
  gaps: Array<{ position: PlayerPosition; reason: string }>
}

const CLAIMABLE_POSITIONS: PlayerPosition[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
const OUT_CODES = new Set(['O', 'IR', 'IR-R', 'SUSP', 'PUP', 'NA'])

/**
 * How many players from any one position may appear in the ranked list.
 *
 * Without this, one bye-week defense turns every healthy defense in the league
 * into a "priority claim" and buries the running back you actually need. You
 * only ever claim one of them.
 */
const MAX_PER_POSITION = 3

export function buildWaiverReport(
  snapshot: LeagueSnapshot,
  teamId: string,
  slots: string[],
  limit = 30,
  calculator?: ImpactCalculator,
): WaiverReport {
  const roster = snapshot.rosters[teamId] ?? []
  const currentWeek = snapshot.league.currentWeek

  const myPlayers = roster
    .map((entry) => entry.player)
    .filter((player): player is Player => player !== null)

  const base = bestLineup(myPlayers, slots, currentWeek)

  const rosteredIds = new Set(
    Object.values(snapshot.rosters).flatMap((entries) =>
      entries.map((entry) => entry.player?.id).filter((id): id is string => id !== undefined),
    ),
  )

  const freeAgents = snapshot.players.filter(
    (player) =>
      !player.ownerTeamId &&
      !rosteredIds.has(player.id) &&
      CLAIMABLE_POSITIONS.includes(player.position),
  )

  const gaps = findGaps(roster, currentWeek)
  const gapPositions = new Set(gaps.map((gap) => gap.position))

  const scored = freeAgents
    .map((player) => {
      const after = bestLineup([...myPlayers, player], slots, currentWeek)
      const upgrade = after.total - base.total

      // Whoever was starting before and isn't now is the man he displaces.
      const displaced =
        upgrade > 0
          ? (myPlayers.find((p) => base.chosenIds.has(p.id) && !after.chosenIds.has(p.id)) ?? null)
          : null

      return { player, upgrade, replaces: displaced }
    })
    .filter((candidate) => projectionOf(candidate.player) > 0)
    .sort((a, b) => b.upgrade - a.upgrade || projectionOf(b.player) - projectionOf(a.player))

  const outlook = buildOutlook(scored)

  // Cap per position so the list stays a set of distinct decisions.
  const perPosition = new Map<PlayerPosition, number>()
  const targets: WaiverTarget[] = []
  for (const candidate of scored) {
    if (targets.length >= limit) break
    const seen = perPosition.get(candidate.player.position) ?? 0
    if (seen >= MAX_PER_POSITION) continue
    perPosition.set(candidate.player.position, seen + 1)

    targets.push({
      player: candidate.player,
      upgrade: round(candidate.upgrade, 1),
      replaces: candidate.replaces,
      rank: targets.length + 1,
      reasons: buildReasons(candidate.player, candidate.upgrade, gapPositions, currentWeek),
      priority: priorityFor(candidate.upgrade, gapPositions.has(candidate.player.position)),
    })
  }

  if (calculator) priceTargets(targets, myPlayers, teamId, calculator)

  return { teamId, targets, outlook, gaps }
}

/**
 * Price the real upgrades in playoff probability.
 *
 * A pickup replaces the weakest player on the roster, so the roster keeps its
 * size — dropping nobody would flatter the claim by measuring an extra man
 * rather than a swap.
 */
function priceTargets(
  targets: WaiverTarget[],
  roster: Player[],
  teamId: string,
  calculator: ImpactCalculator,
): void {
  const weakest = [...roster].sort((a, b) => projectionOf(a) - projectionOf(b))[0]

  for (const target of targets) {
    if (target.upgrade <= 0) continue
    const after = [
      ...roster.filter((player) => player.id !== weakest?.id),
      target.player,
    ]
    target.impact = calculator.impactOf([{ teamId, players: after }], teamId)
  }
}

function buildOutlook(
  scored: Array<{ player: Player; upgrade: number }>,
): PositionOutlook[] {
  const best = new Map<PlayerPosition, { player: Player; upgrade: number }>()
  for (const candidate of scored) {
    const current = best.get(candidate.player.position)
    if (!current || candidate.upgrade > current.upgrade) {
      best.set(candidate.player.position, candidate)
    }
  }

  return CLAIMABLE_POSITIONS.map((position) => {
    const entry = best.get(position)
    return {
      position,
      bestUpgrade: round(entry?.upgrade ?? 0, 1),
      bestPlayer: entry?.player ?? null,
    }
  }).sort((a, b) => b.bestUpgrade - a.bestUpgrade)
}

function buildReasons(
  player: Player,
  upgrade: number,
  gapPositions: Set<PlayerPosition>,
  currentWeek: number,
): string[] {
  const reasons: string[] = []

  if (upgrade > 3) {
    reasons.push(`Adds ${upgrade.toFixed(1)} points a week to your best starting lineup`)
  } else if (upgrade > 0) {
    reasons.push(`A small upgrade — worth ${upgrade.toFixed(1)} points a week to your lineup`)
  } else {
    reasons.push('Would not crack your starting lineup as it stands')
  }

  if (gapPositions.has(player.position)) {
    reasons.push(`Covers a hole at ${player.position} this week`)
  }

  const owned = player.ownership?.percentOwned
  const delta = player.ownership?.percentOwnedDelta
  if (delta !== undefined && delta > 5) {
    reasons.push(`Trending up — rostered in ${delta.toFixed(0)}% more leagues this week`)
  } else if (owned !== undefined && owned < 25 && upgrade > 0) {
    reasons.push(`Rostered in just ${owned.toFixed(0)}% of leagues, so he should clear waivers`)
  } else if (owned !== undefined && upgrade > 0) {
    reasons.push(`Rostered in ${owned.toFixed(0)}% of leagues`)
  }

  if (player.byeWeek === currentWeek) {
    reasons.push(`On bye this week — no help until week ${currentWeek + 1}`)
  }
  if (player.injury && OUT_CODES.has(player.injury.code)) {
    reasons.push(`Currently ${player.injury.label ?? player.injury.code} — a stash, not a starter`)
  }

  return reasons
}

function priorityFor(upgrade: number, fillsGap: boolean): WaiverTarget['priority'] {
  if (upgrade > 4 || (fillsGap && upgrade > 1)) return 'high'
  if (upgrade > 1) return 'medium'
  return 'low'
}

function findGaps(roster: RosterEntry[], currentWeek: number): WaiverReport['gaps'] {
  const gaps: WaiverReport['gaps'] = []
  for (const entry of roster) {
    if (!entry.starter || !entry.player) continue
    const player = entry.player
    if (player.byeWeek === currentWeek) {
      gaps.push({ position: player.position, reason: `${player.name} is on bye` })
    } else if (player.injury && OUT_CODES.has(player.injury.code)) {
      gaps.push({
        position: player.position,
        reason: `${player.name} is ${player.injury.label ?? player.injury.code}`,
      })
    }
  }
  return gaps
}

/** The best free agents in the league, regardless of who needs them. */
export function topFreeAgents(snapshot: LeagueSnapshot, limit = 50): Player[] {
  return snapshot.players
    .filter((player) => !player.ownerTeamId)
    .sort(
      (a, b) =>
        effectiveProjection(b, undefined, snapshot.league.currentWeek) -
        effectiveProjection(a, undefined, snapshot.league.currentWeek),
    )
    .slice(0, limit)
}
