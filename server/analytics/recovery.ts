import type { Player } from '../../shared/types.js'

/**
 * What a player coming back from injury is actually worth.
 *
 * Ark used to treat a returning player as though nothing had happened: off the
 * report, valued at his projection like anyone else. Measured across 16 seasons
 * of injury reports, that is too generous. A player back from five to seven
 * missed games produces about 66% of his pre-injury rate in his first game and
 * 80% across his first three, and the injury itself matters — knees and feet
 * cost roughly a fifth of production for weeks, while ankles and concussions
 * cost almost nothing.
 *
 * Projections from a platform may already price some of this in. The discount
 * here is applied only where the app is making its own judgement about a player
 * who has just returned, and it is deliberately mild for that reason.
 */

/** Production in the first three games back, as a fraction of pre-injury form. */
const BY_WEEKS_MISSED: Array<{ minWeeks: number; firstGame: number; firstThree: number }> = [
  { minWeeks: 8, firstGame: 0.8, firstThree: 0.81 },
  { minWeeks: 5, firstGame: 0.66, firstThree: 0.8 },
  { minWeeks: 4, firstGame: 0.86, firstThree: 0.89 },
  { minWeeks: 3, firstGame: 0.8, firstThree: 0.89 },
  { minWeeks: 2, firstGame: 0.89, firstThree: 0.91 },
]

/**
 * Recovery by body part, first three games back. Sorted worst first, which is
 * also roughly how much a manager should discount the player.
 */
const BY_INJURY: Record<string, number> = {
  foot: 0.79,
  knee: 0.8,
  shoulder: 0.84,
  groin: 0.85,
  hamstring: 0.92,
  concussion: 0.94,
  ankle: 0.98,
}

export interface RecoveryEstimate {
  /** Multiplier to apply to the player's normal expectation, 0-1. */
  multiplier: number
  /** Plain-language reason, or null when no discount applies. */
  reason: string | null
}

export const NO_DISCOUNT: RecoveryEstimate = { multiplier: 1, reason: null }

export function recoveryFor(input: {
  weeksMissed: number
  /** Games played since returning; 0 means this is the first one back. */
  gamesSinceReturn: number
  /** Body part, if the report named one. */
  injury?: string | undefined
}): RecoveryEstimate {
  // The effect has faded by the fourth game back.
  if (input.gamesSinceReturn > 2 || input.weeksMissed < 2) return NO_DISCOUNT

  const bucket = BY_WEEKS_MISSED.find((entry) => input.weeksMissed >= entry.minWeeks)
  if (!bucket) return NO_DISCOUNT

  const byTime = input.gamesSinceReturn === 0 ? bucket.firstGame : bucket.firstThree

  const named = input.injury?.toLowerCase() ?? ''
  const bodyPart = Object.keys(BY_INJURY).find((part) => named.includes(part))
  const byType = bodyPart ? (BY_INJURY[bodyPart] ?? 1) : 1

  // Take the more cautious of the two rather than compounding them, since the
  // two measurements overlap on the same absences.
  const multiplier = Math.min(byTime, byType)
  if (multiplier >= 0.97) return NO_DISCOUNT

  const missed = `${input.weeksMissed} week${input.weeksMissed === 1 ? '' : 's'}`
  const when = input.gamesSinceReturn === 0 ? 'first game back' : 'still working back'

  return {
    multiplier,
    reason: bodyPart
      ? `Back from a ${bodyPart} injury after ${missed}; players return at about ${(multiplier * 100).toFixed(0)}% for the first few games`
      : `Missed ${missed} and is in his ${when}; returns from absences that long run at about ${(multiplier * 100).toFixed(0)}%`,
  }
}

/**
 * Best-effort recovery estimate from what a scrape can actually see.
 *
 * A platform's roster page gives an injury designation but not a history, so
 * weeks missed has to be inferred from elsewhere. When it is unknown, no
 * discount is applied — guessing at it would be worse than leaving the
 * projection alone.
 */
export function recoveryForPlayer(
  player: Player,
  history?: { weeksMissed: number; gamesSinceReturn: number },
): RecoveryEstimate {
  if (!history) return NO_DISCOUNT
  return recoveryFor({
    weeksMissed: history.weeksMissed,
    gamesSinceReturn: history.gamesSinceReturn,
    ...(player.injury?.detail ? { injury: player.injury.detail } : {}),
  })
}
