import type { LeagueShapeInput } from '../lib/api'

/**
 * League settings for the draft board.
 *
 * These change the ranking substantially rather than cosmetically — a second
 * starting quarterback moves the first one drafted from around pick 29 to
 * around pick 8 — so they sit in front of the board rather than behind a menu.
 */

interface Field {
  key: keyof LeagueShapeInput
  label: string
  min: number
  max: number
}

const FIELDS: Field[] = [
  { key: 'teams', label: 'Teams', min: 2, max: 20 },
  { key: 'qb', label: 'QB', min: 0, max: 3 },
  { key: 'rb', label: 'RB', min: 0, max: 5 },
  { key: 'wr', label: 'WR', min: 0, max: 6 },
  { key: 'te', label: 'TE', min: 0, max: 3 },
  { key: 'flex', label: 'Flex', min: 0, max: 4 },
  { key: 'k', label: 'K', min: 0, max: 2 },
  { key: 'def', label: 'D/ST', min: 0, max: 2 },
]

/**
 * Individual defensive players are a separate row because most leagues start
 * none of them, and a league that starts none should not have the board
 * cluttered with four hundred linebackers. Set any of these above zero and the
 * position appears on the board.
 */
const IDP_FIELDS: Field[] = [
  { key: 'lb', label: 'LB', min: 0, max: 6 },
  { key: 'db', label: 'DB', min: 0, max: 6 },
  { key: 'dl', label: 'DL', min: 0, max: 6 },
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

      <div className="space-y-3 p-4">
        <div className="flex flex-wrap gap-4">
          {FIELDS.map((field) => (
            <Spinner key={field.key} field={field} shape={shape} onChange={onChange} />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-ink-800 pt-3">
          <span className="text-xs uppercase tracking-wide text-ink-500">
            Individual defence
          </span>
          {IDP_FIELDS.map((field) => (
            <Spinner key={field.key} field={field} shape={shape} onChange={onChange} />
          ))}
          <span className="text-xs text-ink-500">
            Leave at zero unless your league starts individual defensive players.
          </span>
        </div>
      </div>
    </div>
  )
}

function Spinner({
  field,
  shape,
  onChange,
}: {
  field: Field
  shape: LeagueShapeInput
  onChange: (shape: LeagueShapeInput) => void
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
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
          onChange({ ...shape, [field.key]: Math.min(Math.max(parsed, field.min), field.max) })
        }}
      />
    </label>
  )
}
