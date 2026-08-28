import { api, useApi, type WaiverTarget } from '../lib/api'
import { Card, Empty, ErrorState, Loading, Pill, StatTile } from '../components/ui'
import TeamPicker from '../components/TeamPicker'
import { useTeamSelection } from '../lib/useTeamSelection'
import { injuryTone, percentRaw, points, positionTone } from '../lib/format'

/**
 * Waiver wire. Ranked by what each free agent would actually add to *your*
 * starting lineup this week, rather than by raw projection — the best available
 * player is worthless to you if you already start someone better at his spot.
 */
export default function Waivers() {
  const [teamId, setTeamId] = useTeamSelection()
  const { data, error, loading, reload } = useApi(() => api.waivers(teamId || undefined), [teamId])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Loading label="Scanning the wire…" />
  if (!data) return null

  const upgrades = data.targets.filter((target) => target.upgrade > 0)
  const depth = data.targets.filter((target) => target.upgrade <= 0)
  const bestSpot = data.outlook[0]

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Waiver wire</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-400">
            Every free agent is scored by how much he raises your best possible lineup in week{' '}
            {data.week}, with flex spots, byes and injuries all accounted for.
          </p>
        </div>
        <TeamPicker teams={data.teams} value={data.teamId} onChange={setTeamId} />
      </header>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Real upgrades"
          value={upgrades.length}
          tone={upgrades.length > 0 ? 'text-turf-400' : 'text-ink-300'}
          hint="Free agents who would crack your lineup"
        />
        <StatTile
          label="Holes this week"
          value={data.gaps.length}
          tone={data.gaps.length > 0 ? 'text-blitz-400' : 'text-turf-400'}
          hint={data.gaps.length === 0 ? 'No byes or injuries in your lineup' : 'Byes and injuries to cover'}
        />
        <StatTile
          label="Biggest opportunity"
          value={bestSpot && bestSpot.bestUpgrade > 0 ? bestSpot.position : '—'}
          hint={
            bestSpot && bestSpot.bestUpgrade > 0
              ? `The wire can add ${points(bestSpot.bestUpgrade)} points a week here`
              : 'No position can be improved from the wire'
          }
        />
        <StatTile
          label="Best available"
          value={upgrades[0] ? `+${points(upgrades[0].upgrade)}` : '—'}
          tone={upgrades[0] ? 'text-turf-400' : undefined}
          hint={upgrades[0]?.player.name ?? 'Nothing on the wire beats your starters'}
        />
      </div>

      {data.gaps.length > 0 && (
        <Card title="Holes to cover" subtitle="Starters who will not score for you this week">
          <ul className="divide-y divide-ink-800">
            {data.gaps.map((gap, index) => (
              <li key={`${gap.position}-${index}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className={`pill ${positionTone(gap.position)}`}>{gap.position}</span>
                <span className="text-ink-200">{gap.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.outlook.some((entry) => entry.bestUpgrade > 0) && (
        <Card
          title="Where the wire can help"
          subtitle="Best available upgrade at each position"
        >
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.outlook.map((entry) => (
              <div
                key={entry.position}
                className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-850/50 px-3 py-2.5"
              >
                <span className={`pill ${positionTone(entry.position)}`}>{entry.position}</span>
                <span className="min-w-0 flex-1">
                  {entry.bestUpgrade > 0 && entry.bestPlayer ? (
                    <>
                      <span className="block truncate text-sm font-medium">
                        {entry.bestPlayer.name}
                      </span>
                      <span className="block text-[11px] text-ink-500">Best available upgrade</span>
                    </>
                  ) : (
                    <span className="block text-sm text-ink-500">
                      Nothing on the wire beats your starter
                    </span>
                  )}
                </span>
                <span
                  className={`shrink-0 text-sm font-semibold tabular ${
                    entry.bestUpgrade > 0 ? 'text-turf-400' : 'text-ink-600'
                  }`}
                >
                  {entry.bestUpgrade > 0 ? `+${points(entry.bestUpgrade)}` : '—'}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card
        title="Claim these"
        subtitle={
          upgrades.length > 0
            ? `${upgrades.length} available player${upgrades.length === 1 ? '' : 's'} would improve your starting lineup`
            : undefined
        }
      >
        {upgrades.length === 0 ? (
          <Empty>
            Nothing on the wire beats a player you already start. Hold your waiver priority.
          </Empty>
        ) : (
          <ul className="divide-y divide-ink-800">
            {upgrades.map((target) => (
              <TargetRow key={target.player.id} target={target} />
            ))}
          </ul>
        )}
      </Card>

      {depth.length > 0 && (
        <Card
          title="Depth and stashes"
          subtitle="Would not start for you now, but worth a bench spot"
        >
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Player</th>
                  <th className="text-right">Bye</th>
                  <th className="text-right">Projected</th>
                  <th className="text-right">Rostered in</th>
                </tr>
              </thead>
              <tbody>
                {depth.slice(0, 15).map((target) => (
                  <tr key={target.player.id}>
                    <td>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`pill ${positionTone(target.player.position)}`}>
                          {target.player.position}
                        </span>
                        <span className="truncate font-medium">{target.player.name}</span>
                        <span className="shrink-0 text-xs text-ink-500">
                          {target.player.nflTeam}
                        </span>
                      </span>
                    </td>
                    <td className="text-right text-ink-500">{target.player.byeWeek ?? '—'}</td>
                    <td className="text-right text-ink-300">
                      {points(target.player.points?.projected)}
                    </td>
                    <td className="text-right text-ink-400">
                      {percentRaw(target.player.ownership?.percentOwned)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

const PRIORITY_STYLES: Record<WaiverTarget['priority'], { label: string; className: string }> = {
  high: { label: 'Priority claim', className: 'bg-turf-500/15 text-turf-400' },
  medium: { label: 'Worth a claim', className: 'bg-flag-500/15 text-flag-400' },
  low: { label: 'Depth', className: 'bg-ink-700/60 text-ink-300' },
}

function TargetRow({ target }: { target: WaiverTarget }) {
  const priority = PRIORITY_STYLES[target.priority]

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-6 shrink-0 text-sm tabular text-ink-600">{target.rank}</span>
        <span className={`pill ${positionTone(target.player.position)}`}>
          {target.player.position}
        </span>
        <span className="font-semibold">{target.player.name}</span>
        <span className="text-xs text-ink-500">
          {target.player.nflTeam}
          {target.player.byeWeek ? ` · bye ${target.player.byeWeek}` : ''}
        </span>
        {target.player.injury && (
          <span
            className={`text-xs font-bold ${injuryTone(target.player.injury.code)}`}
            title={target.player.injury.label}
          >
            {target.player.injury.code}
          </span>
        )}
        <Pill className={priority.className}>{priority.label}</Pill>
        <span className="ml-auto shrink-0 text-right">
          <span className="block text-sm font-semibold tabular text-turf-400">
            +{points(target.upgrade)}
          </span>
          <span className="block text-[11px] text-ink-500">per week</span>
        </span>
      </div>

      <ul className="mt-2 space-y-1 pl-9">
        {target.reasons.map((reason) => (
          <li key={reason} className="text-sm leading-relaxed text-ink-300">
            {reason}
          </li>
        ))}
        {target.upgrade > 0 && (
          <li className="text-sm leading-relaxed text-ink-400">
            {target.replaces
              ? `Would take over from ${target.replaces.name} in your lineup.`
              : `Would fill an empty ${target.player.position} slot in your lineup.`}
          </li>
        )}
      </ul>
    </li>
  )
}
