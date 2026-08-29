import type { Player, RosterEntry } from '../shared/types.js'
import {
  assign,
  dropCandidate,
  playerProjection,
  rosterCandidates,
  type Agent,
  type AgentView,
  type WaiverClaim,
} from './agents.js'

/**
 * Rivals fitted to the people actually in the league.
 *
 * The shipped simulation plays Ark against invented archetypes, which answers
 * "is this strategy sound" but not "does it beat these nine". Two things about
 * a manager are measurable from a season of league history and matter more
 * than anything else:
 *
 *   - how often they touch the wire, straight from the transaction log
 *   - how much they leave on their bench, from every weekly lineup they set
 *
 * Bench waste is measured against the hindsight-perfect lineup, so nobody
 * reaches zero and the number includes irreducible uncertainty. What separates
 * managers is the part above that floor, and that is what gets fitted here.
 */

export interface ManagerProfile {
  teamKey: string
  name: string
  /** Successful adds per week, from the transaction log. */
  addsPerWeek: number
  /** Points left on the bench as a share of points started. */
  benchWasteShare: number
  /** Fitted so the simulated share matches the measured one. */
  lineupNoise?: number
}

/** Box-Muller, so lineup mistakes are gaussian rather than uniform. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * A manager who sees the same projections as everyone else but acts on them
 * imperfectly. Noise on the projection is what produces a suboptimal lineup,
 * and the size of it is fitted per person rather than assumed.
 */
export class LeagueRival implements Agent {
  readonly name: string
  readonly description: string
  private readonly noise: number
  private readonly claimRate: number

  constructor(profile: ManagerProfile) {
    this.name = profile.name
    this.claimRate = Math.min(1, Math.max(0, profile.addsPerWeek))
    this.noise = profile.lineupNoise ?? 0.2
    this.description =
      `Fitted to ${profile.name}: ${profile.addsPerWeek.toFixed(2)} adds a week, ` +
      `${(profile.benchWasteShare * 100).toFixed(1)}% of points left on the bench.`
  }

  setLineup(view: AgentView) {
    const candidates = rosterCandidates(view.roster).map((candidate) => ({
      player: candidate.player,
      projection: candidate.projection * (1 + this.noise * gaussian(view.rng)),
    }))
    return assign(candidates, view.slots)
  }

  waiverClaim(view: AgentView): WaiverClaim | null {
    if (view.rng() > this.claimRate) return null
    const drop = dropCandidate(view.roster, view.slots)
    const add = view.freeAgents[0]
    if (!drop || !add) return null
    // Typical managers chase this week's projection rather than season value,
    // which is the behaviour the shipped analytics deliberately avoids.
    return playerProjection(add) > playerProjection(drop) ? { add, drop } : null
  }
}

/** Roster helper kept here so the agent file stays about strategy. */
export function rosterPlayers(roster: RosterEntry[]): Player[] {
  return roster.map((entry) => entry.player).filter((p): p is Player => p !== null)
}

export interface Measured {
  name: string
  wasteShare: number
}

/**
 * Fit each manager's lineup noise so the simulated bench waste matches the
 * measured one. A fixed-point loop rather than a formula, because the mapping
 * from noise to waste depends on the rest of the league.
 */
export function fitNoise(
  profiles: ManagerProfile[],
  simulate: (profiles: ManagerProfile[]) => Map<string, number>,
  opts: { rounds?: number; tolerance?: number } = {},
): ManagerProfile[] {
  const rounds = opts.rounds ?? 8
  const tolerance = opts.tolerance ?? 0.002
  let current = profiles.map((p) => ({ ...p, lineupNoise: p.lineupNoise ?? 0.25 }))

  for (let round = 0; round < rounds; round++) {
    const observed = simulate(current)
    let worst = 0
    current = current.map((profile) => {
      const seen = observed.get(profile.name)
      if (seen === undefined) return profile
      const gap = profile.benchWasteShare - seen
      worst = Math.max(worst, Math.abs(gap))
      // Waste rises roughly with noise, so step proportionally and clamp.
      const next = (profile.lineupNoise ?? 0.25) + gap * 4
      return { ...profile, lineupNoise: Math.min(2, Math.max(0, next)) }
    })
    if (worst < tolerance) break
  }

  return current
}
