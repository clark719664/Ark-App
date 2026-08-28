import type { DataQuality } from '@shared/types'

/**
 * A standing warning on any page whose rankings depend on projections.
 *
 * When the scrape cannot find weekly projections, the manager tools still
 * produce a ranked list — it just means something weaker than it appears to.
 * Saying so plainly is the difference between a useful fallback and a
 * confident-looking guess.
 */
export default function DataQualityNotice({ quality }: { quality: DataQuality | null | undefined }) {
  if (!quality || quality.projections === 'provider') return null

  const broken = quality.projections === 'none'

  return (
    <div
      role="status"
      className={`rounded-xl border px-4 py-3 ${
        broken
          ? 'border-blitz-500/30 bg-blitz-500/10'
          : 'border-flag-500/30 bg-flag-500/10'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            broken ? 'bg-blitz-500' : 'bg-flag-500'
          }`}
          aria-hidden
        />
        <div className="min-w-0 text-sm leading-relaxed">
          <p className={`font-semibold ${broken ? 'text-blitz-400' : 'text-flag-400'}`}>
            {broken ? 'Rankings on this page are not reliable' : 'Ranking by season average'}
          </p>
          {quality.notes.map((note) => (
            <p key={note} className="mt-1 text-ink-300">
              {note}
            </p>
          ))}
          <p className="mt-1 text-xs text-ink-400">
            {quality.playersWithProjections} of {quality.totalRosteredPlayers} rostered players
            came back with a weekly projection.
          </p>
        </div>
      </div>
    </div>
  )
}
