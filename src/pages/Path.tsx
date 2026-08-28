import { api, useApi, type GameLeverage } from '../lib/api'
import { Card, ErrorState, Loading, Meter, StatTile } from '../components/ui'
import TeamPicker from '../components/TeamPicker'
import { useTeamSelection } from '../lib/useTeamSelection'
import { percent } from '../lib/format'

/**
 * What is still on the table, and which games decide it.
 *
 * Standings say where a team is. This says what has to happen — and, more
 * usefully, which of the remaining games actually move the season and which
 * are already decided either way.
 */
export default function Path() {
  const [teamId, setTeamId] = useTeamSelection()
  const { data, error, loading, reload } = useApi(() => api.path(teamId || undefined), [teamId])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Loading label="Simulating the rest of the season…" />
  if (!data) return null

  const biggest = data.games[0]
  const status = data.clinched ? 'Clinched' : data.eliminated ? 'Eliminated' : 'In the hunt'
  // Nothing left to decide: showing four bars of zero is noise, not information.
  const settled = !biggest || biggest.swing < 1

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Season path</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-400">
            Every remaining game simulated twice — once won, once lost — to see how much of the
            season actually rides on it.
          </p>
        </div>
        <TeamPicker teams={data.teams} value={data.teamId} onChange={setTeamId} />
      </header>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Playoff odds"
          value={percent(data.playoffOdds)}
          tone={
            data.clinched ? 'text-turf-400' : data.eliminated ? 'text-blitz-400' : 'text-flag-400'
          }
          hint={status}
        />
        <StatTile
          label="Games left"
          value={data.gamesRemaining}
          hint="In the regular season"
        />
        <StatTile
          label="Wins to clinch"
          value={data.clinched ? 'Done' : (data.winsToClinch ?? '—')}
          hint={
            data.clinched
              ? 'Already through'
              : data.winsToClinch === null
                ? 'Winning out still would not be certain'
                : 'Makes the playoffs near certain'
          }
        />
        <StatTile
          label="Biggest game"
          value={biggest && biggest.swing >= 1 ? `Week ${biggest.week}` : '—'}
          tone={biggest && biggest.swing > 15 ? 'text-flag-400' : undefined}
          hint={
            biggest && biggest.swing >= 1
              ? `${biggest.swing.toFixed(0)} points of playoff odds ride on it`
              : 'No remaining game changes the outcome'
          }
        />
      </div>

      <Card title="Where you stand">
        <p className="px-4 py-3 text-sm leading-relaxed text-ink-200">{data.summary}</p>
      </Card>

      {data.games.length > 0 && (
        <Card
          title="What each game is worth"
          subtitle={
            settled
              ? 'Every remaining game, though none of them change the outcome now'
              : 'Playoff odds if you win, against playoff odds if you lose'
          }
        >
          <ul className="divide-y divide-ink-800">
            {data.games.map((game) => (
              <GameRow key={game.week} game={game} opponents={data.opponents} settled={settled} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function GameRow({
  game,
  opponents,
  settled,
}: {
  game: GameLeverage
  opponents: Record<string, string>
  settled: boolean
}) {
  const decisive = game.swing >= 15

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-16 shrink-0 text-sm font-semibold text-ink-300">Week {game.week}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {opponents[game.opponentTeamId] ?? `Team ${game.opponentTeamId}`}
        </span>
        {game.mustWin && <span className="pill bg-blitz-500/15 text-blitz-400">Must win</span>}
        <span
          className={`shrink-0 text-sm font-semibold tabular ${
            decisive ? 'text-flag-400' : 'text-ink-400'
          }`}
        >
          {game.swing.toFixed(1)}pp
        </span>
      </div>

      {!settled && (
        <>
      <div className="mt-2 flex items-center gap-3 text-xs tabular text-ink-500">
        <span className="w-16 shrink-0">Win</span>
        <span className="max-w-[240px] flex-1">
          <Meter value={game.oddsIfWin * 100} tone="bg-turf-500" />
        </span>
        <span className="w-12 shrink-0 text-turf-400">{percent(game.oddsIfWin)}</span>
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs tabular text-ink-500">
        <span className="w-16 shrink-0">Lose</span>
        <span className="max-w-[240px] flex-1">
          <Meter value={game.oddsIfLose * 100} tone="bg-blitz-500" />
        </span>
        <span className="w-12 shrink-0 text-blitz-400">{percent(game.oddsIfLose)}</span>
      </div>
        </>
      )}
    </li>
  )
}
