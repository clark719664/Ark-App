import type { LeagueShapeInput } from '../lib/api'

/**
 * League settings for the draft board.
 *
 * These change the ranking substantially rather than cosmetically — a second
 * starting quarterback moves the first one drafted from around pick 29 to
 * around pick 8 — so they sit in front of the board rather than behind a menu.
 */

const FIELDS: Array<{ key: keyof LeagueShapeInput; label: string; min: number; max: number }> = [
  { key: 'teams', label: 'Teams', min: 2, max: 20 },
  { key: 'qb', label: 'QB', min: 0, max: 3 },
  { key: 'rb', label: 'RB', min: 0, max: 5 },
  { key: 'wr', label: 'WR', min: 0, max: 6 },
  { key: 'te', label: 'TE', min: 0, max: 3 },
  { key: 'flex', label: 'Flex', min: 0, max: 4 },
]

export default function LeagueShapeBar({
  shape,
  onChange,
}: {
  shape: LeagueShapeInput
  onChange: (shape: LeagueShapeInput) => void
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="font-semibold text-ink-100">Your league</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            Rankings are value over replacement, so these settings change the board — a superflex
            league moves the first quarterback up roughly twenty picks.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 p-4">
        {FIELDS.map((field) => (
          <label key={field.key} className="flex items-center gap-2 text-sm">
            <span className="text-ink-400">{field.label}</span>
            <input
              type="number"
              className="input w-16 py-1 tabular"
              min={field.min}
              max={field.max}
              value={shape[field.key]}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (!Number.isFinite(parsed)) return
                onChange({
                  ...shape,
                  [field.key]: Math.min(Math.max(parsed, field.min), field.max),
                })
              }}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
