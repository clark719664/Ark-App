import type { LeagueSnapshot, Player, PlayerPosition, RosterEntry } from '../../shared/types.js'
import { rosterAfterTrade, type Impact, type ImpactCalculator } from './impact.js'
import { bestLineup, projectionOf } from './lineup.js'
import { canFill } from './slots.js'
import { mean, round } from './stats.js'

/**
 * Trade finding.
 *
 * A trade is worth proposing when both rosters get better, which happens when
 * each side is giving up depth it can't start and getting back something it
 * can. Every player is valued by what he adds to *that specific roster* — a
 * third good tight end is worth far less to the team that already has two than
 * to the team starting a replacement-level one.
 *
 * Nothing here knows about "trade value charts" or consensus rankings. The
 * whole model is: simulate the roster before and after, and see who gains.
 */

const TRADEABLE_POSITIONS: PlayerPosition[] = ['QB', 'RB', 'WR', 'TE']

export interface TradeSide {
  teamId: string
  teamName: string
  sends: Player[]
  receives: Player[]
  /** Weekly projected starting-lineup points gained. */
  gain: number
}

export interface TradeIdea {
  id: string
  you: TradeSide
  them: TradeSide
  /** Combined gain — how much total value the trade unlocks. */
  totalGain: number
  /** 0-1: 1 means both sides gain equally. */
  fairness: number
  rationale: string
  /**
   * What the trade does to your season, not just your Sunday. Present only on
   * the ideas that survive ranking, because pricing one costs a full season
   * simulation.
   */
  impact?: Impact
}

export interface TradeReport {
  teamId: string
  ideas: TradeIdea[]
  surplus: Array<{ position: PlayerPosition; depth: number; spare: Player[] }>
  needs: Array<{ position: PlayerPosition; starterProjection: number }>
}

/**
 * The projected points a roster's best legal starting lineup produces. This is
 * the only value function used: a player is worth exactly what he adds to it.
 */
export function lineupStrength(players: Player[], slots: string[], currentWeek?: number): number {
  return bestLineup(players, slots, currentWeek).total
}

function rosterPlayers(roster: RosterEntry[]): Player[] {
  return roster
    .map((entry) => entry.player)
    .filter((player): player is Player => player !== null)
}

export interface TradeOptions {
  /** Cap on ideas returned. */
  limit?: number
  /** Require both sides to gain at least this many projected points. */
  minGain?: number
  /** Include two-for-one packages as well as straight swaps. */
  includePackages?: boolean
  /**
   * Price the surviving ideas in playoff probability. Costs one season
   * simulation each, so it is applied after ranking rather than during it.
   */
  impact?: ImpactCalculator
}

export function findTrades(
  snapshot: LeagueSnapshot,
  teamId: string,
  slots: string[],
  opts: TradeOptions = {},
): TradeReport {
  const limit = opts.limit ?? 12
  const minGain = opts.minGain ?? 0.5
  const myRoster = snapshot.rosters[teamId] ?? []
  const myPlayers = rosterPlayers(myRoster)
  const myBase = lineupStrength(myPlayers, slots)

  const ideas: TradeIdea[] = []

  for (const team of snapshot.teams) {
    if (team.id === teamId) continue
    const theirPlayers = rosterPlayers(snapshot.rosters[team.id] ?? [])
    if (theirPlayers.length === 0) continue
    const theirBase = lineupStrength(theirPlayers, slots)

    // One-for-one swaps.
    for (const mine of myPlayers) {
      if (!TRADEABLE_POSITIONS.includes(mine.position)) continue
      for (const theirs of theirPlayers) {
        if (!TRADEABLE_POSITIONS.includes(theirs.position)) continue
        // Swapping like for like at the same value is churn, not a trade.
        if (mine.position === theirs.position) continue

        const myAfter = lineupStrength(swap(myPlayers, [mine], [theirs]), slots)
        const theirAfter = lineupStrength(swap(theirPlayers, [theirs], [mine]), slots)
        const myGain = myAfter - myBase
        const theirGain = theirAfter - theirBase

        if (myGain < minGain || theirGain < minGain) continue

        ideas.push(
          buildIdea(teamId, team.id, team.name, [mine], [theirs], myGain, theirGain),
        )
      }
    }

    if (opts.includePackages !== false) {
      // Two-for-one: spend surplus depth to consolidate into a starter.
      const spare = surplusPlayers(myPlayers, slots)
      for (let i = 0; i < spare.length; i += 1) {
        for (let j = i + 1; j < spare.length; j += 1) {
          const packageOut = [spare[i]!, spare[j]!]
          for (const theirs of theirPlayers) {
            if (!TRADEABLE_POSITIONS.includes(theirs.position)) continue

            const myAfter = lineupStrength(swap(myPlayers, packageOut, [theirs]), slots)
            const theirAfter = lineupStrength(swap(theirPlayers, [theirs], packageOut), slots)
            const myGain = myAfter - myBase
            const theirGain = theirAfter - theirBase

            if (myGain < minGain || theirGain < minGain) continue

            ideas.push(
              buildIdea(teamId, team.id, team.name, packageOut, [theirs], myGain, theirGain),
            )
          }
        }
      }
    }
  }

  // Prefer trades that create the most total value, then the fairest ones —
  // but spread them around. Twelve variations on the same player-for-player
  // swap with the same manager is one idea, not twelve.
  const ranked = diversify(
    dedupe(ideas).sort((a, b) => b.totalGain - a.totalGain || b.fairness - a.fairness),
    limit,
  )

  const priced = opts.impact ? priceIdeas(snapshot, teamId, ranked, opts.impact) : ranked

  return {
    teamId,
    ideas: priced,
    surplus: positionSurplus(myPlayers, slots),
    needs: positionNeeds(myPlayers, slots),
  }
}

/**
 * Re-price each idea as a change in playoff odds.
 *
 * Both rosters are moved, not just yours: the player you send makes the other
 * team better, and if they are racing you for the last spot that cost is real
 * and belongs in the number.
 */
function priceIdeas(
  snapshot: LeagueSnapshot,
  teamId: string,
  ideas: TradeIdea[],
  calculator: ImpactCalculator,
): TradeIdea[] {
  const mine = rosterPlayers(snapshot.rosters[teamId] ?? [])

  return ideas.map((idea) => {
    const theirs = rosterPlayers(snapshot.rosters[idea.them.teamId] ?? [])
    return {
      ...idea,
      impact: calculator.impactOf(
        [
          { teamId, players: rosterAfterTrade(mine, idea.you.sends, idea.you.receives) },
          {
            teamId: idea.them.teamId,
            players: rosterAfterTrade(theirs, idea.them.sends, idea.them.receives),
          },
        ],
        teamId,
      ),
    }
  })
}

function buildIdea(
  myTeamId: string,
  theirTeamId: string,
  theirTeamName: string,
  sends: Player[],
  receives: Player[],
  myGain: number,
  theirGain: number,
): TradeIdea {
  const total = myGain + theirGain
  // 1 when both sides gain the same; approaches 0 as one side takes it all.
  const fairness = total === 0 ? 0 : 1 - Math.abs(myGain - theirGain) / total

  return {
    id: `${sends.map((p) => p.id).join('+')}>${receives.map((p) => p.id).join('+')}@${theirTeamId}`,
    you: {
      teamId: myTeamId,
      teamName: 'You',
      sends,
      receives,
      gain: round(myGain, 1),
    },
    them: {
      teamId: theirTeamId,
      teamName: theirTeamName,
      sends: receives,
      receives: sends,
      gain: round(theirGain, 1),
    },
    totalGain: round(total, 1),
    fairness: round(fairness, 2),
    rationale: explain(sends, receives, myGain, theirGain, theirTeamName),
  }
}

function explain(
  sends: Player[],
  receives: Player[],
  myGain: number,
  theirGain: number,
  theirTeamName: string,
): string {
  const outPositions = [...new Set(sends.map((p) => p.position))].join(' and ')
  const receiveNames = receives.map((p) => p.name).join(' and ')

  // What is actually established: the incoming player improves your lineup by
  // more than losing the outgoing one costs it, and the reverse for them.
  const shape =
    sends.length > receives.length
      ? `You cannot start both of the players going out, and ${receiveNames} starts immediately.`
      : `${receiveNames} adds more to your lineup than losing ${sends[0]?.name ?? 'the player'} takes away.`

  return (
    `${shape} Worth about ${myGain.toFixed(1)} points a week to you. ` +
    `${theirTeamName} gains roughly ${theirGain.toFixed(1)} a week themselves, because ` +
    `${outPositions} is a position their own lineup is short of.`
  )
}

function swap(players: Player[], out: Player[], incoming: Player[]): Player[] {
  const outIds = new Set(out.map((player) => player.id))
  return [...players.filter((player) => !outIds.has(player.id)), ...incoming]
}

/** Players who don't crack the starting lineup and aren't the first man up. */
function surplusPlayers(players: Player[], slots: string[]): Player[] {
  const spare: Player[] = []
  for (const position of TRADEABLE_POSITIONS) {
    const atPosition = players
      .filter((player) => player.position === position)
      .sort((a, b) => projectionOf(b) - projectionOf(a))
    const startingSpots = slots.filter((slot) => canFill(slot, position)).length
    // Keep one backup past the starters; anything beyond that is tradeable.
    spare.push(...atPosition.slice(startingSpots + 1))
  }
  return spare.sort((a, b) => projectionOf(b) - projectionOf(a)).slice(0, 6)
}

function positionSurplus(players: Player[], slots: string[]): TradeReport['surplus'] {
  return TRADEABLE_POSITIONS.map((position) => {
    const atPosition = players
      .filter((player) => player.position === position)
      .sort((a, b) => projectionOf(b) - projectionOf(a))
    const startingSpots = slots.filter((slot) => canFill(slot, position)).length
    return {
      position,
      depth: atPosition.length,
      spare: atPosition.slice(startingSpots + 1),
    }
  }).filter((entry) => entry.spare.length > 0)
}

function positionNeeds(players: Player[], slots: string[]): TradeReport['needs'] {
  return TRADEABLE_POSITIONS.map((position) => {
    const atPosition = players
      .filter((player) => player.position === position)
      .sort((a, b) => projectionOf(b) - projectionOf(a))
    const startingSpots = Math.max(1, slots.filter((slot) => canFill(slot, position)).length)
    const starters = atPosition.slice(0, startingSpots)
    return {
      position,
      starterProjection: round(mean(starters.map((player) => projectionOf(player))), 1),
    }
  }).sort((a, b) => a.starterProjection - b.starterProjection)
}

const MAX_PER_PARTNER = 2
const MAX_PER_PACKAGE = 2

/**
 * Cap how many ideas any one trade partner or outgoing package can occupy.
 *
 * Returning fewer, distinct ideas is the point — six variations on shopping the
 * same player to the same manager is one idea wearing six hats, and it buries
 * the genuinely different options underneath it.
 */
function diversify(ideas: TradeIdea[], limit: number): TradeIdea[] {
  const perPartner = new Map<string, number>()
  const perPackage = new Map<string, number>()
  const picked: TradeIdea[] = []

  for (const idea of ideas) {
    if (picked.length >= limit) break

    const partnerKey = idea.them.teamId
    const packageKey = idea.you.sends.map((p) => p.id).sort().join('+')
    const partnerCount = perPartner.get(partnerKey) ?? 0
    const packageCount = perPackage.get(packageKey) ?? 0
    if (partnerCount >= MAX_PER_PARTNER || packageCount >= MAX_PER_PACKAGE) continue

    perPartner.set(partnerKey, partnerCount + 1)
    perPackage.set(packageKey, packageCount + 1)
    picked.push(idea)
  }

  return picked
}

function dedupe(ideas: TradeIdea[]): TradeIdea[] {
  const seen = new Set<string>()
  const unique: TradeIdea[] = []
  for (const idea of ideas) {
    if (seen.has(idea.id)) continue
    seen.add(idea.id)
    unique.push(idea)
  }
  return unique
}

// --- Buy low / sell high ----------------------------------------------------

export interface MarketSignal {
  player: Player
  teamId: string | null
  teamName: string | null
  seasonAverage: number
  recentAverage: number
  /** recentAverage - seasonAverage. */
  swing: number
  kind: 'buy-low' | 'sell-high'
  note: string
}

/**
 * Players whose recent form has pulled away from their season baseline.
 *
 * A hot streak inflates a player's perceived value above what he'll actually
 * produce, and a cold one deflates it. Those two gaps are where trades get
 * made, and the swing is measured against the player's own season rather than
 * against the league so a consistent low scorer never shows up as a bargain.
 */
export function findMarketSignals(
  snapshot: LeagueSnapshot,
  limit = 8,
  viewerTeamId?: string,
): MarketSignal[] {
  const teamNames = new Map(snapshot.teams.map((team) => [team.id, team.name]))
  const signals: MarketSignal[] = []

  for (const player of snapshot.players) {
    const season = player.points?.average
    const recent = player.points?.lastWeek
    if (season === undefined || recent === undefined || season <= 0) continue
    // Ignore players too marginal for anyone to trade for.
    if (season < 6) continue

    const swing = recent - season
    if (Math.abs(swing) < season * 0.35) continue

    const kind = swing > 0 ? 'sell-high' : 'buy-low'
    const owner = player.ownerTeamId ? (teamNames.get(player.ownerTeamId) ?? null) : null
    signals.push({
      player,
      teamId: player.ownerTeamId ?? null,
      teamName: owner,
      seasonAverage: round(season, 1),
      recentAverage: round(recent, 1),
      swing: round(swing, 1),
      kind,
      note: buildSignalNote(kind, recent, season, owner, player.ownerTeamId === viewerTeamId),
    })
  }

  return signals
    .sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing))
    .slice(0, limit)
}

function buildSignalNote(
  kind: MarketSignal['kind'],
  recent: number,
  season: number,
  owner: string | null,
  isYours: boolean,
): string {
  const line = `Scored ${recent.toFixed(1)} last week against a ${season.toFixed(1)} season average.`

  if (kind === 'sell-high') {
    if (isYours) return `${line} This is the most he will ever be worth in a trade — move him now.`
    return owner === null
      ? `${line} One week does not make him this good. Do not overpay.`
      : `${line} ${owner} will want full price. Let someone else pay it.`
  }

  if (isYours) return `${line} Hold. One bad week is noise, and selling now is selling the bottom.`
  return owner === null
    ? `${line} Free, and the drop looks like noise rather than decline.`
    : `${line} ${owner} may take less for him than he is worth.`
}
