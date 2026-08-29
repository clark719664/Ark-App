import { useState } from 'react'
import { api, useApi, type DraftPoolPlayer, type LeagueShapeInput } from '../lib/api'
import { Card, Empty, ErrorState, Loading, StatTile } from '../components/ui'
import LeagueShapeBar from '../components/LeagueShapeBar'
import { useLocalStorage } from '../lib/useLocalStorage'
import { points, positionTone } from '../lib/format'

/**
 * A live draft board.
 *
 * This is the one screen that has to work before anything else does: a draft
 * happens before a league has any data to sync. So it runs off a pool built
 * from open NFL data — rosters, recent production, depth charts and measured
 * age curves — and needs no league connection at all.
 *
 * Players are ranked by value over replacement rather than projected points,
 * because raw points put nine quarterbacks in the top twenty and none of them
 * is worth an early pick in a one-quarterback league.
 */

/** Every position the board can show, in the order a board is usually read. */
const ALL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'LB', 'DB', 'DL'] as const

/** Which league setting decides how many of a position a roster needs. */
const SHAPE_KEY: Record<string, keyof LeagueShapeInput> = {
  QB: 'qb', RB: 'rb', WR: 'wr', TE: 'te', K: 'k', DEF: 'def', LB: 'lb', DB: 'db', DL: 'dl',
}

/**
 * Only show positions the league actually starts.
 *
 * Most leagues start no individual defensive players, and a board carrying four
 * hundred linebackers nobody can draft is worse than one that leaves them out.
 */
function boardPositions(shape: LeagueShapeInput): string[] {
  return ALL_POSITIONS.filter((position) => {
    const key = SHAPE_KEY[position]
    return key !== undefined && shape[key] > 0
  })
}

interface DraftState {
  drafted: string[]
  mine: string[]
  order: string[]
}

const EMPTY_STATE: DraftState = { drafted: [], mine: [], order: [] }

const DEFAULT_SHAPE: LeagueShapeInput = {
  teams: 12, qb: 1, rb: 2, wr: 3, te: 1, flex: 1, k: 1, def: 1, lb: 0, db: 0, dl: 0,
}

export default function DraftBoard() {
  // v2: the stored shape gained kicker, team defence and IDP slots, and a
  // shape saved before that has none of them.
  const [shape, setShape] = useLocalStorage<LeagueShapeInput>('ark.leagueShape.v2', DEFAULT_SHAPE)
  const [state, setState, reset] = useLocalStorage<DraftState>('ark.draft.v2', EMPTY_STATE)
  const [search, setSearch] = useState('')

  const pool = useApi(() => api.draftPool(shape), [
    shape.teams, shape.qb, shape.rb, shape.wr, shape.te, shape.flex,
    shape.k, shape.def, shape.lb, shape.db, shape.dl,
  ])

  const positions = boardPositions(shape)

  if (pool.error) return <ErrorState error={pool.error} onRetry={pool.reload} />
  if (pool.loading && !pool.data) return <Loading label="Building the board…" />
  if (!pool.data) return null

  const draftedSet = new Set(state.drafted)
  const mineSet = new Set(state.mine)

  const take = (playerId: string, isMine: boolean) => {
    setState((prev) => ({
      drafted: prev.drafted.includes(playerId) ? prev.drafted : [...prev.drafted, playerId],
      mine: isMine && !prev.mine.includes(playerId) ? [...prev.mine, playerId] : prev.mine,
      order: [...prev.order, playerId],
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

  const available = pool.data.players.filter((player) => !draftedSet.has(player.playerId))
  const myRoster = pool.data.players.filter((player) => mineSet.has(player.playerId))

  const query = search.trim().toLowerCase()
  const matching = query
    ? available.filter(
        (player) =>
          player.name.toLowerCase().includes(query) || player.team.toLowerCase().includes(query),
      )
    : available

  const needs = positions.map((position) => {
    const key = SHAPE_KEY[position]
    return {
      position,
      have: myRoster.filter((player) => player.position === position).length,
      need: key === undefined ? 1 : shape[key],
    }
  })

  const best = available[0]

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Draft board</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-400">
            {pool.data.season} projections from open NFL data, ranked by value over replacement for
            your league's settings. Works with no league connected.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input w-44"
            placeholder="Search players…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search players"
          />
          <button type="button" className="btn py-1.5 text-xs" onClick={undo} disabled={state.order.length === 0}>
            Undo
          </button>
          <button
            type="button"
            className="btn py-1.5 text-xs"
            onClick={() => {
              if (window.confirm('Clear the whole board? This cannot be undone.')) reset()
            }}
            disabled={state.drafted.length === 0}
          >
            Reset
          </button>
        </div>
      </header>

      <LeagueShapeBar shape={shape} onChange={setShape} />

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <StatTile label="On the board" value={available.length} hint={`${state.drafted.length} gone`} />
        <StatTile
          label="Your picks"
          value={myRoster.length}
          hint={
            needs.filter((n) => n.have < n.need).length > 0
              ? `Still need ${needs.filter((n) => n.have < n.need).map((n) => n.position).join(', ')}`
              : 'Starting lineup filled'
          }
        />
        <StatTile
          label="Best available"
          value={<span className="block truncate text-lg leading-tight">{best?.name ?? '—'}</span>}
          hint={best ? `${best.position}${best.positionRank} · ${points(best.vorp)} over replacement` : undefined}
        />
        <StatTile
          label="Biggest drop-off"
          value={cliffPosition(available, positions)}
          hint="Where the next tier falls away fastest"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Sticky, because a league starting individual defenders has nine
            position cards to scroll and the overall board is what you pick
            from. */}
        <Card
          title="Best available"
          subtitle="Ranked by value over replacement"
          className="lg:col-span-1 lg:sticky lg:top-4 lg:self-start"
        >
          {matching.length === 0 ? (
            <Empty>No players match that search.</Empty>
          ) : (
            <ol className="max-h-[560px] divide-y divide-ink-800 overflow-y-auto">
              {matching.slice(0, 60).map((player) => (
                <BoardRow key={player.playerId} player={player} onDraft={take} showRank />
              ))}
            </ol>
          )}
        </Card>

        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
          {positions.map((position) => (
            <Card
              key={position}
              title={position}
              subtitle={`${available.filter((p) => p.position === position).length} left`}
            >
              <ol className="max-h-80 divide-y divide-ink-800/60 overflow-y-auto">
                {available
                  .filter((player) => player.position === position)
                  .slice(0, 20)
                  .map((player) => (
                    <BoardRow key={player.playerId} player={player} onDraft={take} />
                  ))}
              </ol>
            </Card>
          ))}
        </div>
      </div>

      {myRoster.length > 0 && (
        <Card title="Your roster" subtitle="Players you have claimed on this board">
          <div className="flex flex-wrap gap-2 p-4">
            {myRoster.map((player) => (
              <span
                key={player.playerId}
                className="inline-flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1 text-sm"
              >
                <span className={`pill ${positionTone(player.position)}`}>{player.position}</span>
                {player.name}
                <span className="text-xs text-ink-500">{points(player.projectedSeason, 0)}</span>
              </span>
            ))}
          </div>
        </Card>
      )}

      <p className="px-1 text-xs leading-relaxed text-ink-500">
        Projections blend recent per-game production, regressed toward replacement by how many games
        support it, then adjusted by measured age curves and depth chart position. The open data
        leaves fantasy totals blank for kickers and defenders, so both are scored here from the
        underlying events: kickers from field goals by distance, team defences from sacks,
        takeaways, return touchdowns and points allowed, and individual defenders from tackles,
        sacks and turnovers. Defences are regressed harder than players, because a unit carried by a
        takeaway rate that will not repeat looks elite in hindsight. Two caveats worth knowing: IDP
        scoring varies between leagues more than any other position group, so a tackle-heavy
        rulebook should rate linebackers above what is shown; and nothing here models target
        competition, scheme changes or anything reported this week — where this disagrees sharply
        with consensus, consensus is usually right.
      </p>
    </div>
  )
}

/** The position whose next tier falls away fastest, i.e. where to draft now. */
function cliffPosition(available: DraftPoolPlayer[], positions: string[]): string {
  let steepest: { position: string; drop: number } | null = null

  for (const position of positions) {
    const list = available.filter((player) => player.position === position).slice(0, 6)
    if (list.length < 4) continue
    // Compare the best available with the fourth: a big gap means the position
    // is about to get much worse.
    const drop = (list[0]?.projectedSeason ?? 0) - (list[3]?.projectedSeason ?? 0)
    if (!steepest || drop > steepest.drop) steepest = { position, drop }
  }

  return steepest ? `${steepest.position} −${steepest.drop.toFixed(0)}` : '—'
}

function BoardRow({
  player,
  onDraft,
  showRank = false,
}: {
  player: DraftPoolPlayer
  onDraft: (playerId: string, isMine: boolean) => void
  showRank?: boolean
}) {
  return (
    <li className="group flex items-center gap-2 px-3 py-1.5 text-sm">
      {showRank && <span className="w-6 shrink-0 text-xs tabular text-ink-600">{player.overallRank}</span>}
      <span className={`pill shrink-0 ${positionTone(player.position)}`}>{player.position}</span>

      <span className="min-w-0 flex-1">
        <span className="block truncate" title={player.notes.join(' · ')}>
          {player.name}
        </span>
        <span className="block truncate text-[11px] text-ink-500">
          {player.team} · {player.position}
          {player.positionRank} · {points(player.projectedSeason, 0)} proj
          {player.basis !== 'production' && ' · thin history'}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <span className="block text-xs font-semibold tabular text-turf-400">
          +{points(player.vorp, 0)}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          title="Drafted by someone else"
          onClick={() => onDraft(player.playerId, false)}
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-400 hover:bg-ink-700 hover:text-ink-100"
        >
          Off
        </button>
        <button
          type="button"
          title="I drafted this player"
          onClick={() => onDraft(player.playerId, true)}
          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-turf-400 hover:bg-turf-600 hover:text-ink-950"
        >
          Mine
        </button>
      </span>
    </li>
  )
}
