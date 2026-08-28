import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, useApi, type MatchupWithTeams } from '../lib/api'
import { Card, Empty, ErrorState, Loading } from '../components/ui'
import { points } from '../lib/format'

export default function Matchups() {
  const [week, setWeek] = useState<number | undefined>(undefined)
  const { data, error, loading, reload } = useApi(() => api.matchups(week), [week])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (!data && loading) return <Loading label="Loading matchups…" />
  if (!data) return null

  return (
    <div className="space-y-4">
      <Card
        title={`Week ${data.week}`}
        subtitle={data.week === data.currentWeek ? 'Current week' : undefined}
        actions={
          <div className="flex items-center gap-1 overflow-x-auto max-w-full">
            {data.weeks.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWeek(w)}
                className={`rounded px-2 py-1 text-xs font-semibold tabular transition-colors ${
                  w === data.week
                    ? 'bg-turf-600 text-ink-950'
                    : w === data.currentWeek
                      ? 'bg-ink-800 text-turf-400'
                      : 'text-ink-400 hover:bg-ink-800'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        }
      >
        {data.matchups.length === 0 ? (
          <Empty>No matchups scheduled for week {data.week}.</Empty>
        ) : (
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {data.matchups.map((matchup, i) => (
              <MatchupCard key={`${matchup.week}-${i}`} matchup={matchup} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function MatchupCard({ matchup }: { matchup: MatchupWithTeams }) {
  const played = matchup.final || matchup.home.score > 0 || matchup.away.score > 0
  const homeWon = matchup.winnerTeamId === matchup.home.teamId
  const awayWon = matchup.winnerTeamId === matchup.away.teamId

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-850/50 p-3">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-ink-500 mb-2">
        <span>{matchup.isPlayoff ? 'Playoffs' : `Week ${matchup.week}`}</span>
        <span className={matchup.final ? 'text-ink-400' : 'text-turf-400'}>
          {matchup.final ? 'Final' : played ? 'In progress' : 'Upcoming'}
        </span>
      </div>

      <Side
        teamId={matchup.away.teamId}
        name={matchup.awayTeam?.name}
        isMine={matchup.awayTeam?.isMine ?? false}
        score={matchup.away.score}
        projected={matchup.away.projected}
        played={played}
        won={awayWon}
      />
      <Side
        teamId={matchup.home.teamId}
        name={matchup.homeTeam?.name}
        isMine={matchup.homeTeam?.isMine ?? false}
        score={matchup.home.score}
        projected={matchup.home.projected}
        played={played}
        won={homeWon}
      />
    </div>
  )
}

function Side({
  teamId, name, isMine, score, projected, played, won,
}: {
  teamId: string
  name: string | undefined
  isMine: boolean
  score: number
  projected: number | undefined
  played: boolean
  won: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Link
        to={`/teams/${teamId}`}
        className={`truncate text-sm hover:text-turf-400 transition-colors ${
          won ? 'font-semibold text-ink-100' : 'text-ink-300'
        }`}
      >
        {name ?? `Team ${teamId}`}
        {isMine && <span className="ml-2 pill bg-turf-500/15 text-turf-400">you</span>}
      </Link>
      <div className="text-right shrink-0">
        <div className={`tabular font-semibold ${won ? 'text-turf-400' : 'text-ink-200'}`}>
          {played ? points(score) : '—'}
        </div>
        {projected !== undefined && (
          <div className="text-[11px] text-ink-500 tabular">proj {points(projected)}</div>
        )}
      </div>
    </div>
  )
}
