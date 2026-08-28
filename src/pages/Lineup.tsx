import type { Player } from '@shared/types'
import { api, useApi, type LineupAssignment, type LineupResponse } from '../lib/api'
import { Card, Empty, ErrorState, Loading, StatTile } from '../components/ui'
import TeamPicker from '../components/TeamPicker'
import DataQualityNotice from '../components/DataQualityNotice'
import RiskPanel from '../components/RiskPanel'
import { useTeamSelection } from '../lib/useTeamSelection'
import { injuryTone, percent, points, positionTone, toneForOdds } from '../lib/format'

/**
 * Start/sit. The single highest-value screen in any fantasy app: over a season,
 * lineup mistakes cost more than every waiver claim combined.
 */
export default function Lineup() {
  const [teamId, setTeamId] = useTeamSelection()
  const { data, error, loading, reload } = useApi(() => api.lineup(teamId || undefined), [teamId])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Loading label="Building your best lineup…" />
  if (!data) return null

  const { lineup, odds, opponent } = data
  const perfect = lineup.pointsLeftOnBench === 0

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Start / Sit</h1>
          <p className="mt-1 text-sm text-ink-400">
            Week {data.week}
            {opponent ? ` · versus ${opponent.name}` : ''}
          </p>
        </div>
        <TeamPicker teams={data.teams} value={data.team.id} onChange={setTeamId} />
      </header>

      <DataQualityNotice quality={data.dataQuality} />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Lineup as set"
          value={points(lineup.currentProjected)}
          hint="Projected points"
        />
        <StatTile
          label="Best possible"
          value={points(lineup.optimalProjected)}
          hint="From the players you already roster"
        />
        <StatTile
          label="Left on the bench"
          value={points(lineup.pointsLeftOnBench)}
          tone={perfect ? 'text-turf-400' : 'text-flag-400'}
          hint={perfect ? 'Your lineup is already optimal' : `${lineup.swaps.length} change${lineup.swaps.length === 1 ? '' : 's'} to make`}
        />
        <StatTile
          label="Win probability"
          value={odds ? percent(odds.winProbability) : '—'}
          tone={odds ? toneForOdds(odds.winProbability) : undefined}
          hint={
            odds && opponent
              ? odds.basis === 'lineup'
                // Both sides are projected from their best available lineup, so
                // this is the answer to "if we both start our best team" —
                // which is why it can differ from the lineup-as-set number.
                ? `${points(odds.projected)} to ${points(odds.opponentProjected)} if both start their best lineup`
                : `${points(odds.projected)} to ${points(odds.opponentProjected)}, projected from season form`
              : 'No matchup scheduled this week'
          }
        />
      </div>

      {lineup.alerts.length > 0 && <Alerts alerts={lineup.alerts} />}

      <RiskPanel risk={data.risk} />

      {lineup.swaps.length > 0 ? (
        <Card
          title="Changes to make"
          subtitle="Ordered by how much each one is worth"
        >
          <ul className="divide-y divide-ink-800">
            {lineup.swaps.map((swap) => (
              <li key={`${swap.slot}-${swap.in.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="pill bg-ink-800 text-ink-300 shrink-0">{swap.slot}</span>
                <span className="flex items-center gap-2 text-sm">
                  <span className="text-blitz-400 line-through decoration-blitz-400/50">
                    {swap.out.name}
                  </span>
                  <span className="text-ink-500" aria-label="becomes">
                    →
                  </span>
                  <span className="font-semibold text-turf-400">{swap.in.name}</span>
                </span>
                <span className="ml-auto text-sm font-semibold text-turf-400 tabular shrink-0">
                  +{points(swap.gain)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card title="Changes to make">
          <Empty>
            Nothing to change — this is already the best lineup your roster can produce.
          </Empty>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Optimal lineup" subtitle="Highlighted rows differ from what is set now">
          <LineupTable assignments={lineup.optimal} />
        </Card>
        <Card title="Bench" subtitle="Everyone not in the optimal lineup">
          <BenchTable data={data} />
        </Card>
      </div>
    </div>
  )
}

function Alerts({ alerts }: { alerts: LineupResponse['lineup']['alerts'] }) {
  const high = alerts.filter((alert) => alert.severity === 'high')
  const medium = alerts.filter((alert) => alert.severity === 'medium')

  return (
    <Card
      title="Lineup alerts"
      subtitle={
        high.length > 0
          ? `${high.length} starter${high.length === 1 ? '' : 's'} cannot play this week`
          : 'Worth checking before kickoff'
      }
    >
      <ul className="divide-y divide-ink-800">
        {[...high, ...medium].map((alert) => (
          <li key={alert.player.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                alert.severity === 'high' ? 'bg-blitz-500' : 'bg-flag-500'
              }`}
              aria-hidden
            />
            <span className={`pill ${positionTone(alert.player.position)}`}>
              {alert.player.position}
            </span>
            <span className="font-medium">{alert.player.name}</span>
            <span className="text-ink-400">{alert.reason}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function LineupTable({ assignments }: { assignments: LineupAssignment[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th className="w-20">Slot</th>
            <th>Player</th>
            <th className="text-right">Projected</th>
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment, index) => (
            <tr
              key={`${assignment.slot}-${index}`}
              className={assignment.changed ? 'bg-turf-500/5' : ''}
            >
              <td>
                <span className="pill bg-ink-800 text-ink-300">{assignment.slot}</span>
              </td>
              <td>
                {assignment.player ? (
                  <PlayerCell player={assignment.player} highlight={assignment.changed} />
                ) : (
                  <span className="italic text-ink-500">No eligible player available</span>
                )}
              </td>
              <td className="text-right font-semibold">{points(assignment.projected)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BenchTable({ data }: { data: LineupResponse }) {
  const starting = new Set(
    data.lineup.optimal
      .map((assignment) => assignment.player?.id)
      .filter((id): id is string => id !== undefined),
  )
  const bench = data.roster.filter((entry) => entry.player && !starting.has(entry.player.id))

  if (bench.length === 0) return <Empty>Every rostered player is in the starting lineup.</Empty>

  return (
    <div className="overflow-x-auto">
      <table className="table-base">
        <thead>
          <tr>
            <th>Player</th>
            <th>Bye</th>
            <th className="text-right">Projected</th>
          </tr>
        </thead>
        <tbody>
          {bench
            .sort((a, b) => (b.projected ?? 0) - (a.projected ?? 0))
            .map((entry) => (
              <tr key={entry.player!.id}>
                <td>
                  <PlayerCell player={entry.player!} />
                </td>
                <td className="text-ink-500">{entry.player!.byeWeek ?? '—'}</td>
                <td className="text-right text-ink-400">{points(entry.projected)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

function PlayerCell({ player, highlight = false }: { player: Player; highlight?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
      <span className={`truncate ${highlight ? 'font-semibold text-turf-400' : 'font-medium'}`}>
        {player.name}
      </span>
      <span className="shrink-0 text-xs text-ink-500">{player.nflTeam}</span>
      {player.injury && (
        <span
          className={`shrink-0 text-xs font-bold ${injuryTone(player.injury.code)}`}
          title={player.injury.label}
        >
          {player.injury.code}
        </span>
      )}
    </span>
  )
}
