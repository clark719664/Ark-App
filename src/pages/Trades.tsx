import type { Player } from '@shared/types'
import { api, useApi, type MarketSignal, type TradeIdea } from '../lib/api'
import { Card, Empty, ErrorState, Loading, Meter, StatTile } from '../components/ui'
import TeamPicker from '../components/TeamPicker'
import DataQualityNotice from '../components/DataQualityNotice'
import { useTeamSelection } from '../lib/useTeamSelection'
import { points, positionTone, signed } from '../lib/format'

/**
 * Trade finder.
 *
 * Every idea here is one where both rosters end up projecting more points than
 * they did before — which is the only reason a trade ever gets accepted.
 */
export default function Trades() {
  const [teamId, setTeamId] = useTeamSelection()
  const { data, error, loading, reload } = useApi(() => api.trades(teamId || undefined), [teamId])

  if (error) return <ErrorState error={error} onRetry={reload} />
  if (loading && !data) return <Loading label="Looking for trades…" />
  if (!data) return null

  const thinnest = data.needs[0]
  const spare = data.surplus.reduce((count, entry) => count + entry.spare.length, 0)
  const bestIdea = data.ideas[0]

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trades</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-400">
            Deals where both rosters end up projecting more points. Every player is valued by what
            he adds to that specific starting lineup, so depth you can never start is worth exactly
            what it is worth to someone who can.
          </p>
        </div>
        <TeamPicker teams={data.teams} value={data.teamId} onChange={setTeamId} />
      </header>

      <DataQualityNotice quality={data.dataQuality} />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatTile label="Deals found" value={data.ideas.length} hint="Both sides gain" />
        <StatTile
          label="Your thinnest spot"
          value={thinnest?.position ?? '—'}
          hint={thinnest ? `Starters average ${points(thinnest.starterProjection)} points` : undefined}
        />
        <StatTile
          label="Spare parts"
          value={spare}
          hint={spare > 0 ? 'Rostered players you never start' : 'No obvious surplus'}
        />
        <StatTile
          label="Best deal"
          value={bestIdea ? `+${points(bestIdea.you.gain)}` : '—'}
          tone={bestIdea ? 'text-turf-400' : undefined}
          hint={bestIdea ? `Per week, with ${bestIdea.them.teamName}` : 'Nothing worth proposing'}
        />
      </div>

      <Card
        title="Suggested trades"
        subtitle="Ranked by total value created, then by how evenly it is split"
      >
        {data.ideas.length === 0 ? (
          <Empty>
            No trade improves both rosters right now. That usually means your lineup is already
            balanced — check back after a few injuries.
          </Empty>
        ) : (
          <ul className="divide-y divide-ink-800">
            {data.ideas.map((idea) => (
              <TradeCard key={idea.id} idea={idea} />
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Sell high" subtitle="Players riding a week that will not repeat">
          <SignalList
            signals={data.signals.filter((signal) => signal.kind === 'sell-high')}
            teamIdForSignals={data.teamId}
          />
        </Card>
        <Card title="Buy low" subtitle="Players whose price just dropped for one bad week">
          <SignalList
            signals={data.signals.filter((signal) => signal.kind === 'buy-low')}
            teamIdForSignals={data.teamId}
          />
        </Card>
      </div>

      {data.surplus.length > 0 && (
        <Card title="Your tradeable depth" subtitle="Rostered, but never in your starting lineup">
          <div className="flex flex-wrap gap-2 p-4">
            {data.surplus.flatMap((entry) =>
              entry.spare.map((player) => (
                <span
                  key={player.id}
                  className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-sm"
                >
                  <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
                  <span>{player.name}</span>
                  <span className="text-xs text-ink-500">
                    {points(player.points?.projected)} proj
                  </span>
                </span>
              )),
            )}
          </div>
        </Card>
      )}
    </div>
  )
}

function TradeCard({ idea }: { idea: TradeIdea }) {
  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
          With {idea.them.teamName}
        </span>
        {/* Both gains belong together: a trade is one transaction with two
            beneficiaries, not a gain attached to each column of players. */}
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-400">
          <span>
            You <span className="font-semibold tabular text-turf-400">{signed(idea.you.gain)}</span>
          </span>
          <span>
            {idea.them.teamName}{' '}
            <span className="font-semibold tabular text-ink-200">{signed(idea.them.gain)}</span>
          </span>
          <span className="flex items-center gap-2" title="How evenly the gain is split">
            Fairness
            <span className="w-14">
              <Meter value={idea.fairness * 100} tone="bg-chalk-500" />
            </span>
          </span>
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TradeColumn heading="You send" players={idea.you.sends} />
        <TradeColumn heading="You get" players={idea.you.receives} accent />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-ink-300">{idea.rationale}</p>
    </li>
  )
}

function TradeColumn({
  heading,
  players,
  accent = false,
}: {
  heading: string
  players: Player[]
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        accent ? 'border-turf-600/40 bg-turf-500/5' : 'border-ink-800 bg-ink-850/50'
      }`}
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">{heading}</span>
      <ul className="mt-2 space-y-1.5">
        {players.map((player) => (
          <li key={player.id} className="flex min-w-0 items-center gap-2 text-sm">
            <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
            <span className="truncate font-medium">{player.name}</span>
            <span className="ml-auto shrink-0 text-xs tabular text-ink-500">
              {points(player.points?.projected)} projected
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SignalList({
  signals,
  teamIdForSignals,
}: {
  signals: MarketSignal[]
  teamIdForSignals: string
}) {
  if (signals.length === 0) {
    return <Empty>Nobody in the league has swung far enough from their baseline yet.</Empty>
  }

  return (
    <ul className="divide-y divide-ink-800">
      {signals.map((signal) => (
        <li key={signal.player.id} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`pill ${positionTone(signal.player.position)}`}>
              {signal.player.position}
            </span>
            <span className="font-semibold">{signal.player.name}</span>
            <span className="text-xs text-ink-500">{signal.teamName ?? 'Free agent'}</span>
            {signal.teamId === teamIdForSignals && (
              <span className="pill bg-turf-500/15 text-turf-400">yours</span>
            )}
            <span
              className={`ml-auto text-sm font-semibold tabular ${
                signal.kind === 'sell-high' ? 'text-flag-400' : 'text-chalk-400'
              }`}
            >
              {signed(signal.swing)}
            </span>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-ink-400">{signal.note}</p>
        </li>
      ))}
    </ul>
  )
}
