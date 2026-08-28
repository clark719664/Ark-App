import { Link } from 'react-router-dom'
import { api, useApi, type LineupResponse, type StandingsRow, type WaiversResponse } from '../lib/api'
import { Card, Empty, ErrorState, Loading, Meter, StatTile } from '../components/ui'
import { percent, points, positionTone, record, signed, toneForOdds } from '../lib/format'

/**
 * The one screen to open on a Sunday morning: where you stand, what this week
 * looks like, and the two or three things in the league worth knowing about.
 */
export default function Dashboard() {
  const standings = useApi(() => api.standings(), [])
  const matchups = useApi(() => api.matchups(), [])
  const lineup = useApi(() => api.lineup(), [])
  const waivers = useApi(() => api.waivers(), [])

  if (standings.error) return <ErrorState error={standings.error} onRetry={standings.reload} />
  if (standings.loading || !standings.data) return <Loading label="Loading your league…" />

  const rows = standings.data.rows
  const league = standings.data.league
  const mine = rows.find((row) => row.team.isMine) ?? null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{league.name}</h1>
        <p className="text-sm text-ink-400 mt-1">
          {league.season} season · Week {league.currentWeek} of {league.regularSeasonWeeks}
          {league.scoringType ? ` · ${league.scoringType}` : ''}
        </p>
      </div>

      {mine ? <MyTeamTiles row={mine} playoffTeams={league.playoffTeams} /> : null}

      <ActionList lineup={lineup.data} waivers={waivers.data} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title={`Week ${matchups.data?.week ?? league.currentWeek}`}
          subtitle="Live scoreboard"
          className="lg:col-span-2"
          actions={
            <Link to="/matchups" className="text-xs text-ink-400 hover:text-turf-400">
              All weeks →
            </Link>
          }
        >
          {matchups.loading && <Loading />}
          {matchups.data && matchups.data.matchups.length === 0 && <Empty>No matchups this week.</Empty>}
          {matchups.data && matchups.data.matchups.length > 0 && (
            <ul className="divide-y divide-ink-800">
              {matchups.data.matchups.map((matchup, i) => {
                const homeWinning = matchup.home.score >= matchup.away.score
                return (
                  <li key={`${matchup.week}-${i}`} className="px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className={`truncate ${homeWinning ? 'text-ink-100' : 'text-ink-400'}`}>
                        {matchup.homeTeam?.name ?? matchup.home.teamId}
                      </span>
                      <span className="tabular font-semibold shrink-0">
                        {points(matchup.home.score)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-0.5">
                      <span className={`truncate ${!homeWinning ? 'text-ink-100' : 'text-ink-400'}`}>
                        {matchup.awayTeam?.name ?? matchup.away.teamId}
                      </span>
                      <span className="tabular font-semibold shrink-0">
                        {points(matchup.away.score)}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title="Power rankings" subtitle="Scoring-weighted, not record-weighted">
          <ol className="divide-y divide-ink-800">
            {[...rows]
              .filter((row) => row.power)
              .sort((a, b) => (a.power!.rank ?? 99) - (b.power!.rank ?? 99))
              .map((row) => (
                <li key={row.team.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <span className="w-5 text-ink-500 tabular">{row.power!.rank}</span>
                  <Link
                    to={`/teams/${row.team.id}`}
                    className="flex-1 truncate hover:text-turf-400 transition-colors"
                  >
                    {row.team.name}
                  </Link>
                  <span className="w-24 shrink-0">
                    <Meter value={row.power!.score} />
                  </span>
                  <span className="w-8 text-right tabular text-ink-300">
                    {row.power!.score.toFixed(0)}
                  </span>
                </li>
              ))}
          </ol>
        </Card>
      </div>

      <LeagueNotes rows={rows} />
    </div>
  )
}


/**
 * The short list of things that are actually worth doing before kickoff,
 * pulled from the lineup optimizer and the waiver wire. Anything already
 * handled drops off the list rather than sitting there as a green tick.
 */
function ActionList({
  lineup,
  waivers,
}: {
  lineup: LineupResponse | null
  waivers: WaiversResponse | null
}) {
  if (!lineup && !waivers) return null

  const items: Array<{ key: string; to: string; label: string; body: React.ReactNode }> = []

  if (lineup && lineup.lineup.pointsLeftOnBench > 0) {
    const count = lineup.lineup.swaps.length
    items.push({
      key: 'lineup',
      to: '/lineup',
      label: 'Fix your lineup',
      body: (
        <>
          You are leaving{' '}
          <strong className="text-flag-400">
            {points(lineup.lineup.pointsLeftOnBench)} projected points
          </strong>{' '}
          on the bench across {count} change{count === 1 ? '' : 's'}.
        </>
      ),
    })
  }

  const blocking = lineup?.lineup.alerts.filter((alert) => alert.severity === 'high') ?? []
  if (blocking.length > 0) {
    items.push({
      key: 'alerts',
      to: '/lineup',
      label: 'Starters who cannot play',
      body: (
        <>
          {blocking.map((alert, index) => (
            <span key={alert.player.id}>
              {index > 0 ? ', ' : ''}
              <strong>{alert.player.name}</strong> ({alert.reason.toLowerCase()})
            </span>
          ))}
          .
        </>
      ),
    })
  }

  const topClaim = waivers?.targets.find((target) => target.upgrade > 0)
  if (topClaim) {
    items.push({
      key: 'waiver',
      to: '/waivers',
      label: 'Best claim on the wire',
      body: (
        <>
          <span className={`pill mr-1.5 ${positionTone(topClaim.player.position)}`}>
            {topClaim.player.position}
          </span>
          <strong>{topClaim.player.name}</strong> projects{' '}
          <strong className="text-turf-400">+{points(topClaim.upgrade)} a week</strong> over your
          weakest starter at the position.
        </>
      ),
    })
  }

  if (items.length === 0) {
    return (
      <Card title="Before kickoff" subtitle="Everything the tools would change">
        <Empty>
          Your lineup is optimal, nobody is on bye or ruled out, and nothing on the waiver wire
          beats a player you already start. Nothing to do.
        </Empty>
      </Card>
    )
  }

  return (
    <Card title="Before kickoff" subtitle={`${items.length} thing${items.length === 1 ? '' : 's'} worth doing`}>
      <ul className="divide-y divide-ink-800">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              to={item.to}
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-ink-850/60"
            >
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-flag-500" aria-hidden />
              <span className="min-w-0">
                <span className="block text-xs font-semibold uppercase tracking-wide text-ink-500">
                  {item.label}
                </span>
                <span className="mt-0.5 block text-sm leading-relaxed text-ink-200">
                  {item.body}
                </span>
              </span>
              <span className="ml-auto shrink-0 self-center text-ink-600" aria-hidden>
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function MyTeamTiles({ row, playoffTeams }: { row: StandingsRow; playoffTeams: number }) {
  const { team, power, luck, odds, schedule } = row

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink-300">{team.name}</h2>
        <span className="pill bg-turf-500/15 text-turf-400">your team</span>
      </div>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="Record"
          value={record(team.record)}
          hint={`${points(team.pointsFor)} scored · ${points(team.pointsAgainst)} allowed`}
        />
        <StatTile
          label="Power rank"
          value={power ? `#${power.rank}` : '—'}
          hint={power ? `Score ${power.score.toFixed(0)} of 100` : undefined}
        />
        <StatTile
          label="Playoff odds"
          value={odds ? percent(odds.makePlayoffs) : '—'}
          tone={odds ? toneForOdds(odds.makePlayoffs) : undefined}
          hint={`Top ${playoffTeams} teams qualify`}
        />
        <StatTile
          label="Luck"
          value={luck ? signed(luck.luckWins) : '—'}
          hint={luck ? `All-play record ${record(luck.allPlay)}` : undefined}
        />
        <StatTile
          label="Remaining SoS"
          value={schedule ? `#${schedule.futureRank}` : '—'}
          hint={schedule ? `Opponents average ${points(schedule.futureOpponentAvg)}` : undefined}
        />
      </div>
    </div>
  )
}

/**
 * Three observations pulled straight from the analytics. These are the things
 * you'd want someone to tell you before you set your lineup.
 */
function LeagueNotes({ rows }: { rows: StandingsRow[] }) {
  const withLuck = rows.filter((row) => row.luck)
  if (withLuck.length === 0) return null

  const luckiest = [...withLuck].sort((a, b) => b.luck!.luckWins - a.luck!.luckWins)[0]!
  const unluckiest = [...withLuck].sort((a, b) => a.luck!.luckWins - b.luck!.luckWins)[0]!
  const onTheBubble = [...rows]
    .filter((row) => row.odds && row.odds.makePlayoffs > 0.2 && row.odds.makePlayoffs < 0.8)
    .sort((a, b) => Math.abs(0.5 - a.odds!.makePlayoffs) - Math.abs(0.5 - b.odds!.makePlayoffs))[0]

  const notes: Array<{ label: string; body: React.ReactNode }> = [
    {
      label: 'Running hot',
      body: (
        <>
          <strong>{luckiest.team.name}</strong> is {signed(luckiest.luck!.luckWins)} wins above what
          their scoring supports — an all-play record of {record(luckiest.luck!.allPlay)} against a
          real record of {record(luckiest.team.record)}. Expect regression.
        </>
      ),
    },
    {
      label: 'Better than the record',
      body: (
        <>
          <strong>{unluckiest.team.name}</strong> scores like a{' '}
          {percent(unluckiest.luck!.expectedWinPct)} team but sits at{' '}
          {record(unluckiest.team.record)}. The most dangerous opponent left on anyone's schedule.
        </>
      ),
    },
  ]

  if (onTheBubble) {
    notes.push({
      label: 'True coin flip',
      body: (
        <>
          <strong>{onTheBubble.team.name}</strong> is at {percent(onTheBubble.odds!.makePlayoffs)} to
          make the playoffs — the closest thing to a toss-up in the league right now.
        </>
      ),
    })
  }

  return (
    <Card title="What the numbers say" subtitle="Derived from all-play records and 20,000 simulated seasons">
      <ul className="divide-y divide-ink-800">
        {notes.map((note) => (
          <li key={note.label} className="px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              {note.label}
            </div>
            <p className="text-sm text-ink-200 mt-1 leading-relaxed">{note.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  )
}
