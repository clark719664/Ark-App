import type { TeamOption } from '../lib/api'

/**
 * Which team the manager tools act for.
 *
 * Defaults to whichever team is flagged as yours (`YAHOO_TEAM_ID`), but stays
 * switchable — half the value of a trade finder is looking at the problem from
 * the other manager's side of the table.
 */
export default function TeamPicker({
  teams,
  value,
  onChange,
}: {
  teams: TeamOption[]
  value: string
  onChange: (teamId: string) => void
}) {
  if (teams.length === 0) return null

  return (
    <label className="flex items-center gap-2 text-xs text-ink-400">
      <span>Acting for</span>
      <select
        className="input py-1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
            {team.isMine ? ' (you)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
