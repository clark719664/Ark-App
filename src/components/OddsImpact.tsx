import type { Impact, PostureAdvice } from '../lib/api'
import { percent } from '../lib/format'

/**
 * A move's value in the only currency that settles the season.
 *
 * Points per week is the input; playoff probability is what it buys, and the
 * exchange rate is wildly different depending on where a team stands. Showing
 * both keeps the reasoning visible instead of asking anyone to take the number
 * on faith.
 */
export function OddsSwing({ impact, compact = false }: { impact: Impact | undefined; compact?: boolean }) {
  if (!impact) return null

  const { playoffSwing, titleSwing } = impact
  const meaningful = Math.abs(playoffSwing) >= 0.1 || Math.abs(titleSwing) >= 0.1

  if (!meaningful) {
    return (
      <span className="text-xs text-ink-500" title="This move does not change your season either way">
        No change to your season
      </span>
    )
  }

  return (
    <span className={`flex items-center gap-3 tabular ${compact ? 'text-xs' : 'text-sm'}`}>
      <Swing label="Playoffs" value={playoffSwing} />
      <Swing label="Title" value={titleSwing} />
    </span>
  )
}

function Swing({ label, value }: { label: string; value: number }) {
  const positive = value > 0
  const negligible = Math.abs(value) < 0.1

  return (
    <span className="flex items-baseline gap-1">
      <span className="text-ink-500">{label}</span>
      <span
        className={`font-semibold ${
          negligible ? 'text-ink-400' : positive ? 'text-turf-400' : 'text-blitz-400'
        }`}
      >
        {negligible ? '—' : `${positive ? '+' : ''}${value.toFixed(1)}pp`}
      </span>
    </span>
  )
}

const POSTURE_STYLES: Record<PostureAdvice['posture'], string> = {
  contend: 'border-turf-600/40 bg-turf-500/10',
  push: 'border-flag-500/30 bg-flag-500/10',
  sell: 'border-chalk-500/30 bg-chalk-500/10',
}

const POSTURE_TONE: Record<PostureAdvice['posture'], string> = {
  contend: 'text-turf-400',
  push: 'text-flag-400',
  sell: 'text-chalk-400',
}

/** What this manager should be doing, given where they actually stand. */
export function PostureBanner({ posture }: { posture: PostureAdvice | undefined }) {
  if (!posture) return null

  return (
    <div className={`rounded-xl border px-4 py-3 ${POSTURE_STYLES[posture.posture]}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`font-semibold ${POSTURE_TONE[posture.posture]}`}>
          {posture.headline}
        </span>
        <span className="text-xs tabular text-ink-400">
          {percent(posture.playoffOdds)} to make the playoffs
        </span>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink-300">{posture.detail}</p>
    </div>
  )
}
