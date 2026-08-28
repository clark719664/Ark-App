import { Link } from 'react-router-dom'
import { api, useApi, type StandingsRow } from '../lib/api'
import { Card, Delta, ErrorState, Loading, Meter } from '../components/ui'
import { percent, points, record, signed, toneForLuck, toneForOdds } from '../lib/format'

/**
 * Standings, but with the columns that actually predict the rest of the season
 * sitting next to the ones that describe the past. All-play record and luck are
 * the point: a 7-3 team with a losing all-play record is a team you can catch.
 */
export default function Standings() {
  const { data, error, loading, reload } = useApi(() => api.standings(), [])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading || !data) return <Loading label="Loading standings…" />

  const playoffLine = data.league.playoffTeams

  return (
    <div className="space-y-4">
      <Card
        title="Standings"
        subtitle={`${data.league.name} · ${data.league.season} · top ${playoffLine} make the playoffs`}
      >
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Team</th>
                <th>Record</th>
                <th title="Points scored">PF</th>
                <th title="Points allowed">PA</th>
                <th title="Record if this team played every other team every week">All-Play</th>
                <th title="Wins above or below what this team's scoring deserved">Luck</th>
                <th title="Composite strength score, 0-100">Power</th>
                <th title="Chance of making the playoffs">Playoffs</th>
                <th title="Chance of winning the title">Title</th>
                <th>Streak</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, index) => (
                <Row key={row.team.id} row={row} index={index} playoffLine={playoffLine} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-ink-500 px-1">
        <strong className="text-ink-400">All-Play</strong> is each team's record if it had played
        every other team every week — it removes schedule luck.{' '}
        <strong className="text-ink-400">Luck</strong> is actual wins minus the wins that all-play
        record implies: positive means a team has been winning more than it has earned.
      </p>
    </div>
  )
}

function Row({
  row,
  index,
  playoffLine,
}: {
  row: StandingsRow
  index: number
  playoffLine: number
}) {
  const { team, power, luck, odds } = row
  const isPlayoffCutoff = index === playoffLine - 1

  return (
    <tr
      className={[
        team.isMine ? 'bg-turf-500/5' : '',
        isPlayoffCutoff ? 'border-b-2 border-b-turf-600/40' : '',
      ].join(' ')}
    >
      <td className="text-ink-500">{index + 1}</td>
      <td className="max-w-[240px]">
        <Link to={`/teams/${team.id}`} className="hover:text-turf-400 transition-colors">
          <span className="font-medium">{team.name}</span>
          {team.isMine && <span className="ml-2 pill bg-turf-500/15 text-turf-400">you</span>}
        </Link>
        {team.managerName && (
          <div className="text-xs text-ink-500 truncate">{team.managerName}</div>
        )}
      </td>
      <td className="font-semibold">{record(team.record)}</td>
      <td>{points(team.pointsFor)}</td>
      <td className="text-ink-400">{points(team.pointsAgainst)}</td>
      <td className="text-ink-300">{luck ? record(luck.allPlay) : '—'}</td>
      <td className={luck ? toneForLuck(luck.luckWins) : ''}>
        {luck ? signed(luck.luckWins) : '—'}
      </td>
      <td>
        {power ? (
          <div className="flex items-center gap-2 min-w-[120px]">
            <span className="w-10 font-semibold">{power.score.toFixed(0)}</span>
            <Meter value={power.score} />
            <span className="w-10 text-xs">
              <Delta value={power.delta} />
            </span>
          </div>
        ) : (
          '—'
        )}
      </td>
      <td className={odds ? toneForOdds(odds.makePlayoffs) : ''}>
        {odds ? percent(odds.makePlayoffs) : '—'}
      </td>
      <td className="text-ink-300">{odds ? percent(odds.winTitle) : '—'}</td>
      <td className="text-ink-400">{team.streak ?? '—'}</td>
    </tr>
  )
}
