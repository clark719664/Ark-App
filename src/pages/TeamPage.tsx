import { Link, useParams } from 'react-router-dom'
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { RosterEntry } from '@shared/types'
import { api, useApi } from '../lib/api'
import { Card, Empty, ErrorState, Loading, StatTile } from '../components/ui'
import {
  chartNumber, injuryTone, percent, points, positionTone, record, signed, toneForOdds,
} from '../lib/format'

export default function TeamPage() {
  const { id = '' } = useParams()
  const { data, error, loading, reload } = useApi(() => api.team(id), [id])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading || !data) return <Loading label="Loading team…" />

  const { team, roster, schedule, power, luck, odds, weeklyScores } = data
  const starters = roster.filter((entry) => entry.starter)
  const bench = roster.filter((entry) => !entry.starter)
  const leagueAvg =
    weeklyScores.length > 0
      ? weeklyScores.reduce((sum, w) => sum + w.points, 0) / weeklyScores.length
      : 0

  return (
    <div className="space-y-6">
      <div>
        <Link to="/standings" className="text-xs text-ink-500 hover:text-ink-300">
          ← Standings
        </Link>
        <h1 className="text-2xl font-bold tracking-tight mt-1">{team.name}</h1>
        {team.managerName && <p className="text-sm text-ink-400">{team.managerName}</p>}
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <StatTile label="Record" value={record(team.record)} hint={`rank #${team.rank ?? '—'}`} />
        <StatTile label="Points for" value={points(team.pointsFor)} hint={`${points(team.pointsAgainst)} against`} />
        <StatTile
          label="Power rank"
          value={power ? `#${power.rank}` : '—'}
          hint={power ? `score ${power.score.toFixed(0)}` : undefined}
        />
        <StatTile
          label="Playoff odds"
          value={odds ? percent(odds.makePlayoffs) : '—'}
          tone={odds ? toneForOdds(odds.makePlayoffs) : undefined}
          hint={odds ? `title ${percent(odds.winTitle)}` : undefined}
        />
        <StatTile
          label="Luck"
          value={luck ? signed(luck.luckWins) : '—'}
          hint={luck ? `all-play ${record(luck.allPlay)}` : undefined}
        />
      </div>

      <Card title="Weekly scoring" subtitle="Dashed line is the league average per week">
        {weeklyScores.length === 0 ? (
          <Empty>No completed games yet.</Empty>
        ) : (
          <div className="h-64 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weeklyScores.map((w) => ({ week: w.week, points: w.points, won: w.won }))}>
                <CartesianGrid stroke="#232936" vertical={false} />
                <XAxis dataKey="week" stroke="#6b768d" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#6b768d" fontSize={12} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  contentStyle={{
                    background: '#12151c',
                    border: '1px solid #232936',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelFormatter={(week) => `Week ${week}`}
                  formatter={(value) => [points(chartNumber(value)), 'Points']}
                />
                <ReferenceLine y={leagueAvg} stroke="#4a5468" strokeDasharray="4 4" />
                <Line
                  type="linear"
                  dataKey="points"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#22c55e' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Roster" className="lg:col-span-2">
          {roster.length === 0 ? (
            <Empty>No roster data. Run a sync to pull it from Yahoo.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th className="w-16">Slot</th>
                    <th>Player</th>
                    <th>Bye</th>
                    <th>Proj</th>
                    <th>Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {starters.map((entry, i) => (
                    <RosterRow key={`s-${i}`} entry={entry} />
                  ))}
                  {bench.length > 0 && (
                    <tr>
                      <td colSpan={5} className="!py-1 text-[11px] uppercase tracking-wide text-ink-500 bg-ink-950/50">
                        Bench
                      </td>
                    </tr>
                  )}
                  {bench.map((entry, i) => (
                    <RosterRow key={`b-${i}`} entry={entry} dim />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Schedule">
          <ul className="divide-y divide-ink-800 text-sm">
            {schedule.map((game) => (
              <li key={game.week} className="px-4 py-2 flex items-center gap-3">
                <span className="w-8 text-ink-500 tabular">{game.week}</span>
                <span
                  className={`w-5 font-bold ${
                    game.result === 'W'
                      ? 'text-turf-400'
                      : game.result === 'L'
                        ? 'text-blitz-400'
                        : 'text-ink-600'
                  }`}
                >
                  {game.result ?? '·'}
                </span>
                <Link
                  to={`/teams/${game.opponent?.id ?? ''}`}
                  className="flex-1 truncate text-ink-300 hover:text-turf-400 transition-colors"
                >
                  {game.isHome ? '' : '@ '}
                  {game.opponent?.name ?? 'TBD'}
                </Link>
                <span className="tabular text-xs text-ink-400 shrink-0">
                  {game.final ? `${points(game.points)}–${points(game.opponentPoints)}` : '—'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function RosterRow({ entry, dim = false }: { entry: RosterEntry; dim?: boolean }) {
  const player = entry.player

  return (
    <tr className={dim ? 'text-ink-400' : ''}>
      <td>
        <span className="pill bg-ink-800 text-ink-300">{entry.slot}</span>
      </td>
      <td>
        {player ? (
          <div className="flex items-center gap-2 min-w-0">
            <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
            <span className="truncate font-medium">{player.name}</span>
            <span className="text-xs text-ink-500 shrink-0">{player.nflTeam}</span>
            {player.injury && (
              <span className={`text-xs font-bold shrink-0 ${injuryTone(player.injury.code)}`} title={player.injury.label}>
                {player.injury.code}
              </span>
            )}
          </div>
        ) : (
          <span className="text-ink-600 italic">Empty</span>
        )}
      </td>
      <td className="text-ink-500">{player?.byeWeek ?? '—'}</td>
      <td className="text-ink-400">{points(entry.projected)}</td>
      <td className="font-semibold">{points(entry.points)}</td>
    </tr>
  )
}
