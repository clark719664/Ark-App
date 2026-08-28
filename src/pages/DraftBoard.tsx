import { useMemo, useState } from 'react'
import type { Player } from '@shared/types'
import { api, useApi } from '../lib/api'
import { Card, Empty, ErrorState, Loading, StatTile } from '../components/ui'
import { useLocalStorage } from '../lib/useLocalStorage'
import { playerValue, tierByPosition, valueOverReplacement, type TieredPlayer } from '../lib/tiers'
import { injuryTone, points, positionTone } from '../lib/format'

/**
 * A live draft board.
 *
 * The board is the thing you actually keep open on draft night: everyone still
 * available, grouped into tiers so you can see when a position is about to fall
 * off a cliff, with one click to cross a player off and one to claim him for
 * your own roster. State lives in localStorage, so a refresh or a closed laptop
 * doesn't lose the draft.
 */

const BOARD_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

interface DraftState {
  /** Player ids that are off the board. */
  drafted: string[]
  /** Player ids you drafted yourself. */
  mine: string[]
  /** Ordered log so the last pick can be undone. */
  order: string[]
}

const EMPTY_STATE: DraftState = { drafted: [], mine: [], order: [] }

export default function DraftBoard() {
  const players = useApi(() => api.players({ status: 'all', limit: 1000, sort: 'projected' }), [])
  const draft = useApi(() => api.draft(), [])
  const league = useApi(() => api.league(), [])

  const [state, setState, reset] = useLocalStorage<DraftState>('ark.draft.v1', EMPTY_STATE)
  const [tab, setTab] = useState<'board' | 'results'>('board')

  if (players.error) return <ErrorState error={players.error} onRetry={players.reload} />
  if (players.loading || !players.data) return <Loading label="Loading the player pool…" />

  const draftedSet = new Set(state.drafted)
  const mineSet = new Set(state.mine)

  const markDrafted = (id: string, isMine: boolean) => {
    setState((prev) => ({
      drafted: prev.drafted.includes(id) ? prev.drafted : [...prev.drafted, id],
      mine: isMine && !prev.mine.includes(id) ? [...prev.mine, id] : prev.mine,
      order: [...prev.order, id],
    }))
  }

  const undo = () => {
    setState((prev) => {
      const last = prev.order[prev.order.length - 1]
      if (!last) return prev
      return {
        drafted: prev.drafted.filter((id) => id !== last),
        mine: prev.mine.filter((id) => id !== last),
        order: prev.order.slice(0, -1),
      }
    })
  }

  const hasResults = (draft.data?.picks.length ?? 0) > 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Draft board</h1>
        <div className="flex items-center gap-1 rounded-lg border border-ink-800 p-0.5">
          <TabButton active={tab === 'board'} onClick={() => setTab('board')}>
            Live board
          </TabButton>
          <TabButton active={tab === 'results'} onClick={() => setTab('results')} disabled={!hasResults}>
            Results{hasResults ? ` (${draft.data!.picks.length})` : ''}
          </TabButton>
        </div>

        {tab === 'board' && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs tabular text-ink-400">
              {state.drafted.length} off the board · {state.mine.length} yours
            </span>
            <button type="button" className="btn py-1 text-xs" onClick={undo} disabled={state.order.length === 0}>
              Undo
            </button>
            <button
              type="button"
              className="btn py-1 text-xs"
              onClick={() => {
                if (window.confirm('Clear the whole board? This cannot be undone.')) reset()
              }}
              disabled={state.drafted.length === 0}
            >
              Reset
            </button>
          </div>
        )}
      </div>

      {tab === 'board' ? (
        <LiveBoard
          players={players.data.players}
          draftedSet={draftedSet}
          mineSet={mineSet}
          onDraft={markDrafted}
          teamCount={league.data?.league.numTeams ?? 12}
          rosterSlots={league.data?.league.rosterSlots ?? []}
        />
      ) : (
        <Results draft={draft} />
      )}
    </div>
  )
}

function TabButton({
  active, onClick, disabled, children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-3 py-1 text-sm font-semibold transition-colors disabled:opacity-40 ${
        active ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'
      }`}
    >
      {children}
    </button>
  )
}

function LiveBoard({
  players, draftedSet, mineSet, onDraft, teamCount, rosterSlots,
}: {
  players: Player[]
  draftedSet: Set<string>
  mineSet: Set<string>
  onDraft: (id: string, isMine: boolean) => void
  teamCount: number
  rosterSlots: Array<{ slot: string; count: number }>
}) {
  const available = useMemo(
    () => players.filter((player) => !draftedSet.has(player.id)),
    [players, draftedSet],
  )

  const tiers = useMemo(() => tierByPosition(available), [available])

  const starterCounts = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    for (const { slot, count } of rosterSlots) {
      const key = slot.toUpperCase()
      if (BOARD_POSITIONS.includes(key)) counts[key] = count
    }
    // Sensible defaults when the league didn't report its lineup.
    return { QB: 1, RB: 2, WR: 3, TE: 1, K: 1, DEF: 1, ...counts }
  }, [rosterSlots])

  const vorp = useMemo(
    () => valueOverReplacement(available, starterCounts, teamCount),
    [available, starterCounts, teamCount],
  )

  const bestAvailable = useMemo(
    () =>
      [...available]
        .sort((a, b) => (vorp.get(b.id) ?? -99) - (vorp.get(a.id) ?? -99))
        .slice(0, 10),
    [available, vorp],
  )

  const myRoster = useMemo(() => players.filter((p) => mineSet.has(p.id)), [players, mineSet])

  const needs = useMemo(() => {
    const have: Record<string, number> = {}
    for (const player of myRoster) have[player.position] = (have[player.position] ?? 0) + 1
    return BOARD_POSITIONS.map((position) => ({
      position,
      have: have[position] ?? 0,
      need: starterCounts[position] ?? 0,
    }))
  }, [myRoster, starterCounts])

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Available"
          value={available.length}
          hint={`${players.length} players in the pool`}
        />
        <StatTile
          label="Your picks"
          value={myRoster.length}
          hint={
            needs.filter((n) => n.have < n.need).length > 0
              ? `Still need ${needs.filter((n) => n.have < n.need).map((n) => n.position).join(', ')}`
              : 'Every starting spot filled'
          }
        />
        <StatTile
          label="Best available"
          value={
            <span className="text-lg leading-tight block truncate" title={bestAvailable[0]?.name}>
              {bestAvailable[0]?.name ?? '—'}
            </span>
          }
                    hint={
            bestAvailable[0]
              ? `${bestAvailable[0].position} · ${points(playerValue(bestAvailable[0]))} projected`
              : undefined
          }
        />
        <StatTile
          label="Thinnest position"
          value={thinnestPosition(tiers)}
          hint="Fewest players left in the top tier"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <Card
          title="Best available"
          subtitle="Ranked by value over replacement"
          className="lg:col-span-1"
        >
          <ol className="divide-y divide-ink-800">
            {bestAvailable.map((player, i) => (
              <li key={player.id} className="px-3 py-2 flex items-center gap-2 text-sm">
                <span className="w-4 text-xs text-ink-600 tabular">{i + 1}</span>
                <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
                <span className="flex-1 truncate">{player.name}</span>
                <span className="tabular text-xs text-turf-400">
                  +{points(vorp.get(player.id))}
                </span>
              </li>
            ))}
          </ol>
        </Card>

        <div className="lg:col-span-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {BOARD_POSITIONS.map((position) => (
            <PositionColumn
              key={position}
              position={position}
              tiered={(tiers.get(position) ?? []).slice(0, 24)}
              onDraft={onDraft}
            />
          ))}
        </div>
      </div>

      {myRoster.length > 0 && (
        <Card title="Your roster" subtitle="Players you've claimed on this board">
          <div className="flex flex-wrap gap-2 p-4">
            {myRoster.map((player) => (
              <span
                key={player.id}
                className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-sm"
              >
                <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
                {player.name}
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function thinnestPosition(tiers: Map<string, TieredPlayer[]>): string {
  let best: { position: string; count: number } | null = null
  for (const position of BOARD_POSITIONS) {
    const list = tiers.get(position)
    if (!list || list.length === 0) continue
    const topTier = list.filter((entry) => entry.tier === list[0]!.tier).length
    if (!best || topTier < best.count) best = { position, count: topTier }
  }
  return best ? `${best.position} (${best.count})` : '—'
}

function PositionColumn({
  position, tiered, onDraft,
}: {
  position: string
  tiered: TieredPlayer[]
  onDraft: (id: string, isMine: boolean) => void
}) {
  if (tiered.length === 0) {
    return (
      <Card title={position}>
        <Empty>None left.</Empty>
      </Card>
    )
  }

  return (
    <Card title={position} subtitle={`${tiered.length} shown`}>
      <ul className="divide-y divide-ink-800/60">
        {tiered.map((entry, index) => {
          const startsTier = index === 0 || tiered[index - 1]!.tier !== entry.tier
          return (
            <li key={entry.player.id}>
              {startsTier && (
                <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-ink-500 bg-ink-950/40">
                  Tier {entry.tier}
                </div>
              )}
              <div className="group flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="flex-1 min-w-0">
                  <span className="truncate block">
                    {entry.player.name}
                    {entry.player.injury && (
                      <span
                        className={`ml-1.5 text-[10px] font-bold ${injuryTone(entry.player.injury.code)}`}
                        title={entry.player.injury.label}
                      >
                        {entry.player.injury.code}
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] text-ink-500">
                    {entry.player.nflTeam}
                    {entry.player.byeWeek ? ` · bye ${entry.player.byeWeek}` : ''} ·{' '}
                    {points(entry.value)} proj
                  </span>
                </span>
                <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    title="Mark as drafted by someone else"
                    onClick={() => onDraft(entry.player.id, false)}
                    className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-400 hover:bg-ink-700 hover:text-ink-100"
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    title="I drafted this player"
                    onClick={() => onDraft(entry.player.id, true)}
                    className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-turf-400 hover:bg-turf-600 hover:text-ink-950"
                  >
                    Mine
                  </button>
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function Results({ draft }: { draft: ReturnType<typeof useApi<import('../lib/api').DraftResponse>> }) {
  if (draft.loading) return <Loading />
  if (!draft.data || draft.data.picks.length === 0) {
    return (
      <Card title="Draft results">
        <Empty>No draft results yet. They appear here once your league has drafted.</Empty>
      </Card>
    )
  }

  const teamNames = new Map(draft.data.teams.map((t) => [t.id, t.name]))
  const rounds = new Map<number, typeof draft.data.picks>()
  for (const pick of draft.data.picks) {
    const list = rounds.get(pick.round)
    if (list) list.push(pick)
    else rounds.set(pick.round, [pick])
  }

  return (
    <div className="space-y-4">
      {[...rounds.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([round, picks]) => (
          <Card key={round} title={`Round ${round}`}>
            <div className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {picks.map((pick) => (
                <div
                  key={pick.overall}
                  className="rounded-lg border border-ink-800 bg-ink-850/50 px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-600 tabular">{pick.overall}</span>
                    {pick.position && (
                      <span className={`pill ${positionTone(pick.position)}`}>{pick.position}</span>
                    )}
                    <span className="truncate font-medium">{pick.playerName}</span>
                    {pick.cost !== undefined && (
                      <span className="ml-auto text-xs text-flag-400 tabular">${pick.cost}</span>
                    )}
                  </div>
                  <div className="text-xs text-ink-500 truncate mt-0.5">
                    {teamNames.get(pick.teamId) ?? `Team ${pick.teamId}`}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
    </div>
  )
}
