import { useState } from 'react'
import type { Player } from '@shared/types'
import { api, useApi } from '../lib/api'
import { Card, Empty, ErrorState, Loading } from '../components/ui'
import { injuryTone, percentRaw, points, positionTone } from '../lib/format'

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF']

const STATUSES = [
  { value: 'all', label: 'Everyone' },
  { value: 'available', label: 'Free agents' },
  { value: 'rostered', label: 'Rostered' },
]

const SORTS = [
  { value: 'points', label: 'Season pts' },
  { value: 'average', label: 'Avg pts' },
  { value: 'projected', label: 'Projected' },
  { value: 'owned', label: '% owned' },
  { value: 'name', label: 'Name' },
]

export default function Players() {
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState('ALL')
  const [status, setStatus] = useState('all')
  const [sort, setSort] = useState('points')

  const { data, error, loading, reload } = useApi(
    () => api.players({ q: query, pos: position, status, sort, limit: 250 }),
    [query, position, status, sort],
  )

  if (error) return <ErrorState error={error} onRetry={reload} />

  const teamNames = new Map((data?.teams ?? []).map((t) => [t.id, t.name]))

  return (
    <div className="space-y-4">
      <Card
        title="Player research"
        subtitle={data ? `${data.total} players match` : undefined}
        actions={
          <input
            className="input w-48"
            placeholder="Search name or team…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search players"
          />
        }
      >
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-ink-800">
          <ButtonGroup
            options={POSITIONS.map((p) => ({ value: p, label: p }))}
            value={position}
            onChange={setPosition}
          />
          <span className="h-4 w-px bg-ink-700" />
          <ButtonGroup options={STATUSES} value={status} onChange={setStatus} />
          <span className="ml-auto flex items-center gap-2 text-xs text-ink-400">
            Sort
            <select
              className="input py-1"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              aria-label="Sort players"
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        </div>

        {loading && !data && <Loading label="Loading players…" />}
        {data && data.players.length === 0 && (
          <Empty>
            No players match those filters.
            {status === 'available' && ' Try "Everyone" — free agents come from the Yahoo player pool, which needs a sync.'}
          </Empty>
        )}
        {data && data.players.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-8" />
                  <th>Player</th>
                  <th>Owner</th>
                  <th>Bye</th>
                  <th>Season</th>
                  <th>Avg</th>
                  <th>Proj</th>
                  <th>% Own</th>
                  <th>% Start</th>
                </tr>
              </thead>
              <tbody>
                {data.players.map((player, index) => (
                  <PlayerRow
                    key={player.id}
                    player={player}
                    index={index}
                    ownerName={player.ownerTeamId ? teamNames.get(player.ownerTeamId) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function PlayerRow({
  player,
  index,
  ownerName,
}: {
  player: Player
  index: number
  ownerName: string | undefined
}) {
  return (
    <tr>
      <td className="text-ink-600 tabular text-xs">{index + 1}</td>
      <td>
        <div className="flex items-center gap-2 min-w-0">
          <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
          <span className="truncate font-medium">{player.name}</span>
          <span className="text-xs text-ink-500 shrink-0">{player.nflTeam}</span>
          {player.injury && (
            <span
              className={`text-xs font-bold shrink-0 ${injuryTone(player.injury.code)}`}
              title={player.injury.label}
            >
              {player.injury.code}
            </span>
          )}
        </div>
      </td>
      <td className="text-xs">
        {ownerName ? (
          <span className="text-ink-300 truncate">{ownerName}</span>
        ) : (
          <span className="pill bg-turf-500/15 text-turf-400">FA</span>
        )}
      </td>
      <td className="text-ink-500">{player.byeWeek ?? '—'}</td>
      <td className="font-semibold">{points(player.points?.season)}</td>
      <td>{points(player.points?.average)}</td>
      <td className="text-ink-400">{points(player.points?.projected)}</td>
      <td className="text-ink-400">{percentRaw(player.ownership?.percentOwned)}</td>
      <td className="text-ink-400">{percentRaw(player.ownership?.percentStarted)}</td>
    </tr>
  )
}

function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded px-2 py-1 text-xs font-semibold transition-colors ${
            option.value === value
              ? 'bg-ink-700 text-ink-100'
              : 'text-ink-400 hover:bg-ink-800 hover:text-ink-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
