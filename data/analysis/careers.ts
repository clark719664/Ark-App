import type { PlayerBio, WeeklyStat } from '../load.js'

/**
 * Career shape: when players arrive, when they peak, and when they fall off.
 *
 * Useful for two decisions the app makes badly today. A trade is priced on
 * current production alone, with no view on which side of his curve a player
 * sits. And a breakout — the second- or third-year jump — is worth far more
 * than the price it usually costs, if you can tell which players are about to
 * make one.
 */

export interface AgeCurvePoint {
  position: string
  age: number
  playerSeasons: number
  /** Median points per game at this age. */
  medianPpg: number
  /** Median change from the same player's previous season. */
  medianChange: number
}

function seasonAge(bio: PlayerBio, season: number): number | null {
  if (!bio.birthDate) return null
  const born = new Date(bio.birthDate)
  if (Number.isNaN(born.getTime())) return null
  // Age on 1 September of that season, which is roughly opening weekend.
  const reference = new Date(Date.UTC(season, 8, 1))
  return (reference.getTime() - born.getTime()) / (365.25 * 24 * 3600 * 1000)
}

interface SeasonLine {
  playerId: string
  position: string
  season: number
  age: number
  games: number
  ppg: number
}

export function buildSeasonLines(
  stats: WeeklyStat[],
  players: Map<string, PlayerBio>,
  positions: string[],
): SeasonLine[] {
  const grouped = new Map<string, WeeklyStat[]>()
  for (const stat of stats) {
    if (!positions.includes(stat.position)) continue
    const key = `${stat.playerId}:${stat.season}`
    const list = grouped.get(key)
    if (list) list.push(stat)
    else grouped.set(key, [stat])
  }

  const lines: SeasonLine[] = []
  for (const games of grouped.values()) {
    const first = games[0]!
    const bio = players.get(first.playerId)
    if (!bio) continue

    const age = seasonAge(bio, first.season)
    if (age === null || age < 20 || age > 40) continue
    if (games.length < 6) continue

    lines.push({
      playerId: first.playerId,
      position: first.position,
      season: first.season,
      age: Math.round(age),
      games: games.length,
      ppg: games.reduce((sum, game) => sum + game.fantasyPointsPpr, 0) / games.length,
    })
  }

  return lines
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

export function measureAgeCurves(
  stats: WeeklyStat[],
  players: Map<string, PlayerBio>,
  positions = ['QB', 'RB', 'WR', 'TE'],
): AgeCurvePoint[] {
  const lines = buildSeasonLines(stats, players, positions)

  // Year-over-year change for the same player, which controls for the fact
  // that only good players are still in the league at 33.
  const byPlayer = new Map<string, SeasonLine[]>()
  for (const line of lines) {
    const list = byPlayer.get(line.playerId)
    if (list) list.push(line)
    else byPlayer.set(line.playerId, [line])
  }

  const changes = new Map<string, number[]>()
  for (const seasons of byPlayer.values()) {
    const ordered = [...seasons].sort((a, b) => a.season - b.season)
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!
      const current = ordered[i]!
      if (current.season !== previous.season + 1) continue
      const key = `${current.position}:${current.age}`
      const list = changes.get(key)
      if (list) list.push(current.ppg - previous.ppg)
      else changes.set(key, [current.ppg - previous.ppg])
    }
  }

  const points: AgeCurvePoint[] = []
  for (const position of positions) {
    for (let age = 21; age <= 37; age += 1) {
      const atAge = lines.filter((line) => line.position === position && line.age === age)
      if (atAge.length < 20) continue

      points.push({
        position,
        age,
        playerSeasons: atAge.length,
        medianPpg: median(atAge.map((line) => line.ppg)),
        medianChange: median(changes.get(`${position}:${age}`) ?? []),
      })
    }
  }

  return points
}

/**
 * What actually predicts a breakout.
 *
 * A breakout is defined here as a jump of at least 4 points per game over the
 * previous season while clearing a startable threshold — big enough to change
 * a lineup, not a marginal player going from 2 to 4. The question is which
 * signals available *before* the jump identify it.
 */
export interface BreakoutFactor {
  factor: string
  description: string
  /** Breakout rate among players with this signal. */
  withSignal: number
  /** Breakout rate among those without. */
  withoutSignal: number
  /** How many times more likely a breakout is with the signal. */
  lift: number
  sampleWith: number
  sampleWithout: number
}

const BREAKOUT_JUMP = 4
const BREAKOUT_FLOOR = 10

export function measureBreakoutFactors(
  stats: WeeklyStat[],
  players: Map<string, PlayerBio>,
  positions = ['RB', 'WR', 'TE'],
): BreakoutFactor[] {
  const lines = buildSeasonLines(stats, players, positions)

  // Usage signals from the prior season, which is what a manager can see.
  const usage = new Map<string, { targetShare: number; games: number; ppg: number }>()
  const grouped = new Map<string, WeeklyStat[]>()
  for (const stat of stats) {
    const key = `${stat.playerId}:${stat.season}`
    const list = grouped.get(key)
    if (list) list.push(stat)
    else grouped.set(key, [stat])
  }
  for (const [key, games] of grouped) {
    const shares = games.map((g) => g.targetShare).filter((v): v is number => v !== undefined)
    usage.set(key, {
      targetShare: shares.length > 0 ? shares.reduce((a, b) => a + b, 0) / shares.length : 0,
      games: games.length,
      ppg: games.reduce((sum, g) => sum + g.fantasyPointsPpr, 0) / games.length,
    })
  }

  const byPlayer = new Map<string, SeasonLine[]>()
  for (const line of lines) {
    const list = byPlayer.get(line.playerId)
    if (list) list.push(line)
    else byPlayer.set(line.playerId, [line])
  }

  interface Candidate {
    brokeOut: boolean
    young: boolean
    earlyPick: boolean
    risingUsage: boolean
    lowPriorRole: boolean
  }

  const candidates: Candidate[] = []

  for (const [playerId, seasons] of byPlayer) {
    const bio = players.get(playerId)
    const ordered = [...seasons].sort((a, b) => a.season - b.season)

    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!
      const current = ordered[i]!
      if (current.season !== previous.season + 1) continue

      const priorUsage = usage.get(`${playerId}:${previous.season}`)
      const twoBack = usage.get(`${playerId}:${previous.season - 1}`)

      candidates.push({
        brokeOut: current.ppg - previous.ppg >= BREAKOUT_JUMP && current.ppg >= BREAKOUT_FLOOR,
        young: current.age <= 24,
        earlyPick: (bio?.draftRound ?? 99) <= 2,
        risingUsage:
          priorUsage !== undefined &&
          twoBack !== undefined &&
          priorUsage.targetShare > twoBack.targetShare * 1.15,
        lowPriorRole: previous.ppg < 9,
      })
    }
  }

  const rate = (subset: Candidate[]) =>
    subset.length === 0 ? 0 : subset.filter((c) => c.brokeOut).length / subset.length

  const build = (
    factor: string,
    description: string,
    predicate: (c: Candidate) => boolean,
  ): BreakoutFactor => {
    const withSignal = candidates.filter(predicate)
    const withoutSignal = candidates.filter((c) => !predicate(c))
    const a = rate(withSignal)
    const b = rate(withoutSignal)
    return {
      factor,
      description,
      withSignal: a,
      withoutSignal: b,
      lift: b === 0 ? 0 : a / b,
      sampleWith: withSignal.length,
      sampleWithout: withoutSignal.length,
    }
  }

  return [
    build('age 24 or under', 'Still on the early part of the curve', (c) => c.young),
    build('drafted round 1-2', 'Draft capital the team is invested in', (c) => c.earlyPick),
    build('target share rising', 'Role grew last season versus the one before', (c) => c.risingUsage),
    build('limited prior role', 'Scored under 9 points a game last season', (c) => c.lowPriorRole),
    build(
      'young and early pick',
      'Both signals together',
      (c) => c.young && c.earlyPick,
    ),
    build(
      'young, early pick, rising role',
      'All three signals together',
      (c) => c.young && c.earlyPick && c.risingUsage,
    ),
  ]
}
