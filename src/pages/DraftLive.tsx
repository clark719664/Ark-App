import { useEffect, useState } from 'react'
import { api, type DraftLiveResponse, type LiveSuggestion } from '../lib/api'
import { ErrorState, Loading } from '../components/ui'
import { positionTone } from '../lib/format'

/**
 * The draft, on whatever screen is nearest.
 *
 * This is the one page designed to be read on a phone with sixty seconds on
 * the clock, so it answers in priority order: is it my turn, who should I
 * take, what falls off if I wait. Everything else is below the fold.
 */

const POLL_MS = 3000

function Suggestion({ player, rank }: { player: LiveSuggestion; rank: number }) {
  return (
    <li className="flex items-center gap-3 border-b border-slate-800/60 py-2 last:border-0">
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-slate-500">{rank}</span>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${positionTone(player.position)}`}
      >
        {player.position}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-100">{player.name}</span>
        <span className="block truncate text-xs text-slate-500">
          {player.team} · {player.projectedPpg} ppg
          {player.notes[0] ? ` · ${player.notes[0]}` : ''}
        </span>
      </span>
      {player.fillsNeed && (
        <span className="shrink-0 rounded bg-turf-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-turf-400">
          need
        </span>
      )}
      <span className="w-12 shrink-0 text-right text-sm tabular-nums text-slate-300">
        {player.vorp}
      </span>
    </li>
  )
}

export default function DraftLive() {
  const [data, setData] = useState<DraftLiveResponse | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const next = await api.draftLive()
        if (!alive) return
        setData(next)
        setError(null)
      } catch (err) {
        if (!alive) return
        setError(err as Error)
      } finally {
        if (alive) {
          setLoading(false)
          timer = setTimeout(tick, POLL_MS)
        }
      }
    }

    void tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  if (loading && !data) return <Loading label="Connecting to the draft…" />
  if (error && !data) return <ErrorState error={error as never} />
  if (!data) return null

  const top = data.suggestions[0]
  const openNeeds = Object.entries(data.needs).filter(([, count]) => count > 0)

  return (
    <div className="mx-auto max-w-2xl space-y-3 pb-16">
      {data.stale && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          The watcher has not reported for {data.ageSeconds}s. It may have stopped —
          restart it with <code className="font-mono">npm run draft:watch</code>.
        </div>
      )}

      {data.isMyTurn ? (
        <div className="rounded-xl border-2 border-turf-500 bg-turf-500/10 p-4 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-turf-400">
            You are on the clock — pick {data.onTheClock}
          </p>
          {top && (
            <>
              <p className="mt-1 text-3xl font-bold text-slate-50">{top.name}</p>
              <p className="text-sm text-slate-300">
                {top.position} · {top.team} · {top.projectedPpg} ppg · value {top.vorp}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-sm text-slate-400">
              Pick <span className="tabular-nums text-slate-200">{data.onTheClock}</span> is up
            </p>
            <p className="text-sm text-slate-400">
              {data.totalPicks}/{data.teams * data.rounds} made
            </p>
          </div>
          <p className="mt-1 text-2xl font-bold text-slate-50">
            {data.picksUntilNext === null
              ? 'Your draft is done'
              : `${data.picksUntilNext} pick${data.picksUntilNext === 1 ? '' : 's'} until you're up`}
          </p>
          {data.nextPick !== null && (
            <p className="text-sm text-slate-400">You pick at {data.nextPick}</p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Take next
          </h2>
          <span className="text-xs text-slate-500">by value over replacement</span>
        </div>
        <ul>
          {data.suggestions.slice(0, 10).map((player, index) => (
            <Suggestion key={player.playerId} player={player} rank={index + 1} />
          ))}
        </ul>
      </div>

      {data.cliffs.length > 0 && data.picksUntilNext ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Falls off before pick {data.nextPick}
          </h2>
          <ul className="space-y-1 text-sm">
            {data.cliffs.map((cliff) => (
              <li key={cliff.position} className="flex items-baseline justify-between gap-2">
                <span className="text-slate-300">
                  <span className="font-semibold">{cliff.position}</span> {cliff.bestNow}
                  <span className="text-slate-500"> → {cliff.bestLater ?? 'nobody startable'}</span>
                </span>
                <span className="shrink-0 tabular-nums text-amber-400">−{cliff.drop}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Your roster ({data.myRoster.length})
        </h2>
        {data.myRoster.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing drafted yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {data.myRoster.map((player) => (
              <li
                key={player.playerId}
                className="rounded bg-slate-800/80 px-2 py-1 text-xs text-slate-200"
              >
                <span className="font-semibold">{player.position}</span> {player.name}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Still needed:{' '}
          {openNeeds.length === 0
            ? 'starters full'
            : openNeeds.map(([position, count]) => `${position}×${count}`).join(' · ')}
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Recent picks
        </h2>
        {data.recent.length === 0 ? (
          <p className="text-sm text-slate-500">
            No picks yet — draft status is {data.draftStatus}.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.recent.map((pick) => (
              <li
                key={pick.pick}
                className={`flex items-baseline gap-2 ${pick.mine ? 'text-turf-300' : 'text-slate-300'}`}
              >
                <span className="w-10 shrink-0 tabular-nums text-slate-500">{pick.slot}</span>
                <span className="min-w-0 flex-1 truncate">
                  {pick.playerName}
                  <span className="text-slate-500">
                    {' '}
                    {pick.position}
                    {pick.onBoard ? '' : ' (unranked)'}
                  </span>
                </span>
                <span className="w-24 shrink-0 truncate text-right text-xs text-slate-500">
                  {pick.teamName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-center text-xs text-slate-600">
        {data.leagueName} · seat {data.seat} of {data.teams} · updated {data.ageSeconds}s ago
        {data.unmatchedPicks > 0 && ` · ${data.unmatchedPicks} picks not on the board`}
      </p>
    </div>
  )
}
