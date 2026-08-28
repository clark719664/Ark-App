import type { RiskAnalysis } from '../lib/api'
import { Card } from './ui'
import { percent, points, positionTone } from '../lib/format'

/**
 * Start/sit as a question about winning rather than about scoring.
 *
 * Only shown when chasing points and chasing the win actually disagree —
 * which is the minority of weeks, and exactly the weeks worth thinking about.
 */
export default function RiskPanel({ risk }: { risk: RiskAnalysis | null }) {
  if (!risk) return null

  const postureCopy: Record<RiskAnalysis['posture'], string> = {
    underdog:
      'You are the underdog here. Your average week loses this matchup, so the lineup that ' +
      'wins most often is the one with the widest range of outcomes — not the highest projection.',
    favourite:
      'You are the favourite here. You win unless something goes wrong, so the lineup that wins ' +
      'most often is the steadiest one, even at a small cost in projected points.',
    even:
      'This matchup is close to even. When the projections are level, variance barely changes ' +
      'your chances, so take the points.',
  }

  if (!risk.differ) {
    return (
      <Card title="Risk check" subtitle="Chasing points and chasing the win agree this week">
        <div className="px-4 py-3 text-sm leading-relaxed text-ink-300">
          <p>{postureCopy[risk.posture]}</p>
          <p className="mt-2 text-ink-400">
            Your best lineup projects {points(risk.byPoints.mean)} ± {points(risk.byPoints.spread)},
            against roughly {points(risk.opponent.mean)} — about{' '}
            {percent(risk.byPoints.winProbability)} to win. No change would improve those odds.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card
      title="A different lineup wins more often"
      subtitle={`Worth ${risk.winProbabilityGain.toFixed(1)} percentage points of win probability`}
    >
      <div className="px-4 py-3">
        <p className="text-sm leading-relaxed text-ink-300">{postureCopy[risk.posture]}</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Option
            label="Highest projection"
            lineup={risk.byPoints}
            note={`${points(risk.byPoints.mean)} ± ${points(risk.byPoints.spread)}`}
          />
          <Option
            label="Best chance to win"
            lineup={risk.byWinProbability}
            note={`${points(risk.byWinProbability.mean)} ± ${points(risk.byWinProbability.spread)}`}
            accent
          />
        </div>

        <ul className="mt-3 space-y-2">
          {risk.moves.map((move) => (
            <li key={`${move.slot}-${move.in.id}`} className="text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="pill bg-ink-800 text-ink-300">{move.slot}</span>
                <span className="text-blitz-400 line-through decoration-blitz-400/50">
                  {move.out.name}
                </span>
                <span className="text-ink-500" aria-hidden>
                  →
                </span>
                <span className={`pill ${positionTone(move.in.position)}`}>
                  {move.in.position}
                </span>
                <span className="font-semibold text-turf-400">{move.in.name}</span>
              </span>
              <span className="mt-0.5 block leading-relaxed text-ink-400">{move.reason}</span>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          This gives up {points(risk.pointsGivenUp)} projected points to gain{' '}
          {risk.winProbabilityGain.toFixed(1)} points of win probability. Player-to-player spread is
          estimated from position, so treat it as a tiebreaker between close calls rather than a
          reason to bench someone clearly better.
        </p>
      </div>
    </Card>
  )
}

function Option({
  label,
  lineup,
  note,
  accent = false,
}: {
  label: string
  lineup: RiskAnalysis['byPoints']
  note: string
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        accent ? 'border-turf-600/40 bg-turf-500/5' : 'border-ink-800 bg-ink-850/50'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</span>
        <span className={`text-lg font-bold tabular ${accent ? 'text-turf-400' : 'text-ink-100'}`}>
          {percent(lineup.winProbability, 1)}
        </span>
      </div>
      <div className="mt-0.5 text-xs tabular text-ink-500">{note}</div>
    </div>
  )
}
