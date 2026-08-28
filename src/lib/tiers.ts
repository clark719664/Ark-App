import type { Player } from '@shared/types'

/**
 * Tiering.
 *
 * A ranked list tells you Player 14 is better than Player 15. Tiers tell you
 * something far more useful on the clock: whether that gap actually matters. If
 * six receivers are effectively interchangeable, you take the running back now
 * and come back for one of the six next round.
 *
 * Tier breaks are found by looking for unusually large drops in projected value
 * between consecutive players at a position — a gap more than one standard
 * deviation above the typical gap starts a new tier.
 */

export function playerValue(player: Player): number {
  // Prefer a forward-looking number, fall back to what they've actually done.
  return (
    player.points?.projected ??
    player.points?.average ??
    (player.points?.season !== undefined ? player.points.season / 10 : 0)
  )
}

export interface TieredPlayer {
  player: Player
  tier: number
  value: number
  /** Drop in value from the previous player at this position. */
  dropFromPrevious: number
}

export function assignTiers(players: Player[], maxTiers = 12): TieredPlayer[] {
  const ranked = [...players]
    .map((player) => ({ player, value: playerValue(player) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)

  if (ranked.length === 0) return []

  const gaps: number[] = []
  for (let i = 1; i < ranked.length; i += 1) {
    gaps.push(ranked[i - 1]!.value - ranked[i]!.value)
  }

  const meanGap = gaps.reduce((sum, g) => sum + g, 0) / (gaps.length || 1)
  const variance =
    gaps.length > 1
      ? gaps.reduce((sum, g) => sum + (g - meanGap) ** 2, 0) / (gaps.length - 1)
      : 0
  const threshold = meanGap + Math.sqrt(variance)

  const result: TieredPlayer[] = []
  let tier = 1
  for (const [i, entry] of ranked.entries()) {
    const drop = i === 0 ? 0 : ranked[i - 1]!.value - entry.value
    // A break needs a real gap, not just noise in a flat stretch.
    if (i > 0 && drop > threshold && drop > 0.5 && tier < maxTiers) tier += 1
    result.push({ player: entry.player, tier, value: entry.value, dropFromPrevious: drop })
  }

  return result
}

/** Tier the pool separately per position, then merge back into one board. */
export function tierByPosition(players: Player[]): Map<string, TieredPlayer[]> {
  const byPosition = new Map<string, Player[]>()
  for (const player of players) {
    const list = byPosition.get(player.position)
    if (list) list.push(player)
    else byPosition.set(player.position, [player])
  }

  const tiered = new Map<string, TieredPlayer[]>()
  for (const [position, list] of byPosition) {
    tiered.set(position, assignTiers(list))
  }
  return tiered
}

/**
 * Value over replacement: how much better a player is than the guy you could
 * get for free at the same position. This is what makes cross-position
 * comparison meaningful — 18 points from a QB is worth less than 15 from a
 * tight end when every QB scores 17.
 */
export function valueOverReplacement(
  players: Player[],
  starterCounts: Record<string, number>,
  teamCount: number,
): Map<string, number> {
  const byPosition = new Map<string, Player[]>()
  for (const player of players) {
    const list = byPosition.get(player.position)
    if (list) list.push(player)
    else byPosition.set(player.position, [player])
  }

  const vorp = new Map<string, number>()
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => playerValue(b) - playerValue(a))
    // The replacement is roughly the last starter drafted at this position.
    const starters = (starterCounts[position] ?? 1) * teamCount
    const replacementIndex = Math.min(Math.max(starters - 1, 0), sorted.length - 1)
    const replacementValue = playerValue(sorted[replacementIndex] ?? sorted[sorted.length - 1]!)

    for (const player of sorted) {
      vorp.set(player.id, playerValue(player) - replacementValue)
    }
  }
  return vorp
}
