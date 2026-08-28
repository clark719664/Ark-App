import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts'
import { Link } from 'react-router-dom'
import { api, useApi } from '../lib/api'
import { Card, ErrorState, Loading } from '../components/ui'
import { chartNumber, percent, points, record, signed } from '../lib/format'

const AXIS = { stroke: '#6b768d', fontSize: 12, tickLine: false, axisLine: false } as const
const TOOLTIP_STYLE = {
  background: '#12151c',
  border: '1px solid #232936',
  borderRadius: 8,
  fontSize: 12,
} as const

const SERIES_COLORS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6',
  '#f472b6', '#84cc16', '#06b6d4', '#fb923c', '#8b5cf6', '#64748b',
]

export default function Analytics() {
  const { data, error, loading, reload } = useApi(() => api.analytics(), [])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading || !data) return <Loading label="Running the numbers…" />

  const teamName = (id: string) => data.teams.find((t) => t.id === id)?.name ?? id

  const oddsData = [...data.playoffOdds]
    .sort((a, b) => b.makePlayoffs - a.makePlayoffs)
    .map((entry) => ({
      name: teamName(entry.teamId),
      playoffs: Number((entry.makePlayoffs * 100).toFixed(1)),
      title: Number((entry.winTitle * 100).toFixed(1)),
    }))

  const luckData = [...data.luck]
    .sort((a, b) => b.luckWins - a.luckWins)
    .map((entry) => ({
      name: teamName(entry.teamId),
      luck: entry.luckWins,
    }))

  // Scoring vs consistency: the upper-left quadrant is where you want to be —
  // high average, low week-to-week variance.
  const scatterData = data.powerRankings.map((entry) => {
    const team = data.teams.find((t) => t.id === entry.teamId)
    return {
      name: teamName(entry.teamId),
      // Initials keep the plot readable; the full name is in the tooltip.
      label: team?.abbrev ?? teamName(entry.teamId).split(' ').map((w) => w[0]).join(''),
      scoring: entry.components.scoring,
      consistency: entry.components.consistency,
      score: entry.score,
    }
  })

  const weeks = [...new Set(data.weeklyScores.map((w) => w.week))].sort((a, b) => a - b)
  const trendData = weeks.map((week) => {
    const row: Record<string, number | string> = { week }
    for (const team of data.teams) {
      const entry = data.weeklyScores.find((w) => w.week === week && w.teamId === team.id)
      if (entry) row[team.name] = entry.points
    }
    return row
  })

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-sm text-ink-400 mt-1">
          Playoff odds from {data.simulations.toLocaleString()} simulated seasons, using each team's
          own scoring distribution and the schedule it still has to play.
        </p>
      </div>

      <Card title="Playoff and title odds" subtitle="Percent of simulated seasons">
        <div className="h-[420px] p-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={oddsData} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid stroke="#232936" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} unit="%" {...AXIS} />
              <YAxis type="category" dataKey="name" width={150} interval={0} {...AXIS} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                cursor={{ fill: '#ffffff08' }}
                formatter={(value, name) => [`${chartNumber(value) ?? 0}%`, name === 'playoffs' ? 'Playoffs' : 'Title']}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-xs text-ink-400">{value === 'playoffs' ? 'Make playoffs' : 'Win title'}</span>
                )}
              />
              <Bar dataKey="playoffs" fill="#22c55e" radius={[0, 4, 4, 0]} />
              <Bar dataKey="title" fill="#3b82f6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Luck"
          subtitle="Wins above or below what each team's scoring supports"
        >
          <div className="h-80 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={luckData} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke="#232936" horizontal={false} />
                <XAxis type="number" {...AXIS} />
                <YAxis type="category" dataKey="name" width={140} interval={0} {...AXIS} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: '#ffffff08' }}
                  formatter={(value) => [signed(chartNumber(value)), 'Luck (wins)']}
                />
                <Bar dataKey="luck" radius={4}>
                  {luckData.map((entry) => (
                    <Cell key={entry.name} fill={entry.luck >= 0 ? '#f59e0b' : '#3b82f6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="px-4 pb-4 text-xs text-ink-500">
            Amber teams are winning more than they've earned; blue teams are better than their
            record says.
          </p>
        </Card>

        <Card title="Scoring vs consistency" subtitle="Top-right is a team with no weaknesses">
          <div className="h-80 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ left: 8, right: 44, top: 24, bottom: 8 }}>
                <CartesianGrid stroke="#232936" />
                <XAxis
                  type="number"
                  dataKey="scoring"
                  name="Scoring"
                  domain={[0, 100]}
                  label={{ value: 'Scoring →', position: 'insideBottom', offset: -4, fill: '#6b768d', fontSize: 11 }}
                  {...AXIS}
                />
                <YAxis
                  type="number"
                  dataKey="consistency"
                  name="Consistency"
                  domain={[0, 100]}
                  label={{ value: 'Consistency →', angle: -90, position: 'insideLeft', fill: '#6b768d', fontSize: 11 }}
                  {...AXIS}
                />
                <ZAxis type="number" dataKey="score" range={[60, 400]} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ strokeDasharray: '3 3' }}
                  formatter={(value, name) => [(chartNumber(value) ?? 0).toFixed(0), name]}
                  labelFormatter={() => ''}
                  content={({ payload }) => {
                    const point = payload?.[0]?.payload as
                      | { name: string; scoring: number; consistency: number; score: number }
                      | undefined
                    if (!point) return null
                    return (
                      <div style={TOOLTIP_STYLE} className="px-2 py-1.5">
                        <div className="font-semibold text-ink-100">{point.name}</div>
                        <div className="text-ink-400">
                          scoring {point.scoring.toFixed(0)} · consistency {point.consistency.toFixed(0)}
                        </div>
                        <div className="text-ink-400">power {point.score.toFixed(0)}</div>
                      </div>
                    )
                  }}
                />
                <Scatter data={scatterData} fill="#22c55e">
                  <LabelList
                    dataKey="label"
                    position="top"
                    offset={10}
                    style={{ fill: '#94a0b8', fontSize: 10, fontWeight: 600 }}
                  />
                  {scatterData.map((entry, i) => (
                    <Cell key={entry.name} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card title="Weekly scoring" subtitle="Every team, every week">
        <div className="h-96 p-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData}>
              <CartesianGrid stroke="#232936" vertical={false} />
              <XAxis dataKey="week" {...AXIS} />
              <YAxis width={44} {...AXIS} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(week) => `Week ${week}`} />
              <Legend
                formatter={(value) => <span className="text-[11px] text-ink-400">{value}</span>}
                wrapperStyle={{ fontSize: 11 }}
              />
              {data.teams.map((team, i) => (
                <Line
                  key={team.id}
                  type="linear"
                  dataKey={team.name}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={team.isMine ? 3 : 1.5}
                  dot={false}
                  opacity={team.isMine ? 1 : 0.65}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Remaining schedule" subtitle="Rank 1 faces the toughest opponents from here">
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th>Team</th>
                <th>Record</th>
                <th>All-play</th>
                <th>Luck</th>
                <th>Opponents faced</th>
                <th>Opponents left</th>
                <th>SoS rank</th>
                <th>Proj wins</th>
                <th>Playoffs</th>
              </tr>
            </thead>
            <tbody>
              {[...data.scheduleStrength]
                .sort((a, b) => a.futureRank - b.futureRank)
                .map((entry) => {
                  const team = data.teams.find((t) => t.id === entry.teamId)
                  const luck = data.luck.find((l) => l.teamId === entry.teamId)
                  const odds = data.playoffOdds.find((o) => o.teamId === entry.teamId)
                  if (!team) return null
                  return (
                    <tr key={entry.teamId} className={team.isMine ? 'bg-turf-500/5' : ''}>
                      <td>
                        <Link to={`/teams/${team.id}`} className="hover:text-turf-400 font-medium">
                          {team.name}
                        </Link>
                      </td>
                      <td>{record(team.record)}</td>
                      <td className="text-ink-400">{luck ? record(luck.allPlay) : '—'}</td>
                      <td className={luck && luck.luckWins >= 0 ? 'text-flag-400' : 'text-chalk-400'}>
                        {luck ? signed(luck.luckWins) : '—'}
                      </td>
                      <td className="text-ink-400">{points(entry.pastOpponentAvg)}</td>
                      <td>{points(entry.futureOpponentAvg)}</td>
                      <td className="text-ink-300">#{entry.futureRank}</td>
                      <td>{odds ? points(odds.projectedWins) : '—'}</td>
                      <td>{odds ? percent(odds.makePlayoffs) : '—'}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
