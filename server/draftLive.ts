import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import {
  buildView,
  fillsOpenSlot,
  flexCount,
  positionCliffs,
  remainingNeeds,
  snakePicks,
} from './draftWatch.js'
import type { RankedPlayer, LeagueShape } from './draftPool.js'
import type { DraftPick, YahooPlayer } from './yahoo/draftFeed.js'
import { byeStacks } from '../data/draft/schedule.js'
import { picksUntilGone, severityOf, type MarketEntry, type Severity } from './yahoo/market.js'

/**
 * The live draft, as a file.
 *
 * The hub's rule is that only a sync touches Yahoo and the API never makes a
 * network call, which is what keeps the server fast and the browser session in
 * one place. A live draft does not change that: the watcher polls and writes a
 * snapshot here, and the API serves whatever the last write left behind. A
 * phone hitting refresh cannot start a Yahoo request.
 */

export const LIVE_FILE = path.join(config.cache.dir, 'draft-live.json')

export interface LivePick {
  pick: number
  round: number
  slot: string
  teamKey: string
  teamName: string
  playerName: string
  position: string
  team: string
  onBoard: boolean
  mine: boolean
}

export interface LiveSuggestion {
  playerId: string
  name: string
  position: string
  team: string
  vorp: number
  projectedPpg: number
  fillsNeed: boolean
  byeWeek: number | null
  notes: string[]
  /** Where real drafts take him, null when too few of them do to mean anything. */
  adp: number | null
  /** Positive means he is expected to last that many more picks. */
  lastsPicks: number | null
  injury: string | null
  /** Yahoo's own status, e.g. "Questionable". */
  status: string | null
  /** 'out' is a verdict, 'doubtful' is a flag, null is nothing known. */
  severity: Severity
  headline: string | null
  /** The full written outlook, shown when a player is tapped. */
  note: string | null
  noteAt: number | null
}

export interface LiveCliff {
  position: string
  bestNow: string
  bestLater: string | null
  drop: number
}

export interface LiveDraftState {
  updatedAt: string
  leagueName: string
  draftStatus: string
  teams: number
  rounds: number
  seat: number
  myTeamName: string
  onTheClock: number
  nextPick: number | null
  picksUntilNext: number | null
  /**
   * The pick the cliffs are measured up to. Not always `nextPick`: on the clock
   * that is the pick being made, and what matters is the one after it.
   */
  cliffBeforePick: number | null
  isMyTurn: boolean
  totalPicks: number
  recent: LivePick[]
  myRoster: LiveSuggestion[]
  needs: Record<string, number>
  suggestions: LiveSuggestion[]
  cliffs: LiveCliff[]
  /** Weeks where three or more of the roster are off together. */
  byeStacks: Array<{ week: number; count: number }>
  unmatchedPicks: number
}

function toSuggestion(
  player: RankedPlayer,
  needs: Record<string, number>,
  market: Map<string, MarketEntry>,
  yahooId: string | undefined,
  currentPick: number,
): LiveSuggestion {
  const entry = yahooId ? market.get(yahooId) : undefined
  return {
    playerId: player.playerId,
    name: player.name,
    position: player.position,
    team: player.team ?? '',
    vorp: Number(player.vorp.toFixed(1)),
    projectedPpg: Number(player.projectedPpg.toFixed(1)),
    fillsNeed: fillsOpenSlot(player.position, needs),
    byeWeek: player.byeWeek ?? null,
    notes: player.notes ?? [],
    adp: entry?.averagePick ?? null,
    lastsPicks: picksUntilGone(entry, currentPick),
    injury: entry?.injury ?? null,
    status: entry?.statusFull ?? entry?.status ?? null,
    severity: severityOf(entry),
    headline: entry?.headline ?? null,
    note: entry?.note ?? null,
    noteAt: entry?.noteAt ?? null,
  }
}

export interface ComputeOptions {
  leagueName: string
  draftStatus: string
  shape: LeagueShape
  rounds: number
  seat: number
  myTeamKey: string
  myTeamName: string
  teamNames: Map<string, string>
  yahooIndex: Map<string, YahooPlayer>
  /** Average pick, injuries and notes, keyed by Yahoo's numeric player id. */
  market: Map<string, MarketEntry>
  /** Board player id to Yahoo numeric id, so the two can be joined. */
  yahooIdByPlayer: Map<string, string>
}

export function computeLiveState(
  picks: DraftPick[],
  matched: Map<string, RankedPlayer>,
  board: RankedPlayer[],
  opts: ComputeOptions,
): LiveDraftState {
  const view = buildView(picks, matched, board, {
    myTeamKey: opts.myTeamKey,
    teams: opts.shape.teams,
    position: opts.seat,
    rounds: opts.rounds,
  })
  const needs = remainingNeeds(view.myRoster, opts.shape.starters, flexCount(opts.shape))

  const recent: LivePick[] = picks.slice(-12).reverse().map((pick) => {
    const player = matched.get(pick.playerKey)
    const fallback = opts.yahooIndex.get(pick.playerKey)
    return {
      pick: pick.pick,
      round: pick.round,
      slot: `${pick.round}.${String(((pick.pick - 1) % opts.shape.teams) + 1).padStart(2, '0')}`,
      teamKey: pick.teamKey,
      teamName: opts.teamNames.get(pick.teamKey) ?? pick.teamKey,
      playerName: player?.name ?? fallback?.name ?? pick.playerKey,
      position: player?.position ?? fallback?.position ?? '',
      team: player?.team ?? fallback?.team ?? '',
      onBoard: player !== undefined,
      mine: pick.teamKey === opts.myTeamKey,
    }
  })

  // A player who fills an empty starting slot is worth more than his raw value
  // says, but not so much more that it should override a large gap. Ordering by
  // value and surfacing the need as a flag keeps the judgement with the reader.
  const suggestions = view.available
    .slice(0, 25)
    .map((player) =>
      toSuggestion(player, needs, opts.market, opts.yahooIdByPlayer.get(player.playerId), view.onTheClock),
    )

  const cliffs = positionCliffs(
    view.available,
    // Measured to the pick after the one being made, not to the current one:
    // on the clock those differ, and the current one is the useless answer.
    view.cliffHorizon,
    Object.keys(opts.shape.starters),
  )
    .filter((cliff) => fillsOpenSlot(cliff.position, needs))
    // A position whose best player survives to the next pick has not fallen off
    // anything, and a row saying so pushes the ones that have off the screen.
    .filter((cliff) => cliff.drop > 0.05 && cliff.bestLater?.playerId !== cliff.bestNow.playerId)
    .slice(0, 4)
    .map((cliff) => ({
      position: cliff.position,
      bestNow: cliff.bestNow.name,
      bestLater: cliff.bestLater?.name ?? null,
      drop: Number(cliff.drop.toFixed(1)),
    }))

  return {
    updatedAt: new Date().toISOString(),
    leagueName: opts.leagueName,
    draftStatus: opts.draftStatus,
    teams: opts.shape.teams,
    rounds: opts.rounds,
    seat: opts.seat,
    myTeamName: opts.myTeamName,
    onTheClock: view.onTheClock,
    nextPick: view.nextPick,
    picksUntilNext: view.picksUntilNext,
    cliffBeforePick:
      view.cliffHorizon === null ? null : view.onTheClock + view.cliffHorizon,
    isMyTurn: view.picksUntilNext === 0,
    totalPicks: picks.length,
    recent,
    myRoster: view.myRoster.map((player) =>
      toSuggestion(player, needs, opts.market, opts.yahooIdByPlayer.get(player.playerId), view.onTheClock),
    ),
    needs,
    suggestions,
    cliffs,
    byeStacks: byeStacks(view.myRoster.map((player) => player.byeWeek ?? null)).filter(
      (stack) => stack.count >= 3,
    ),
    unmatchedPicks: picks.filter((pick) => !matched.has(pick.playerKey)).length,
  }
}

export function writeLiveState(state: LiveDraftState): void {
  fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true })
  const temporary = `${LIVE_FILE}.tmp`
  const body = JSON.stringify(state)

  // Written then renamed, so a phone polling mid-write never reads half a file.
  //
  // On Windows that rename fails with EPERM if the server happens to have the
  // file open at that instant, which is a race the API path hits constantly by
  // design. It threw during a live draft and took the watcher down with it, so
  // it retries briefly and then writes in place: a torn read is recoverable on
  // the next poll two seconds later, a dead watcher is not.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(temporary, body)
      fs.renameSync(temporary, LIVE_FILE)
      return
    } catch {
      // Busy-wait rather than await: this runs inside the poll loop and a few
      // milliseconds of blocking is cheaper than restructuring it.
      const until = Date.now() + 40
      while (Date.now() < until) { /* wait for the reader to let go */ }
    }
  }

  try {
    fs.writeFileSync(LIVE_FILE, body)
  } catch {
    // Nothing further to do. Losing one snapshot costs a poll; throwing here
    // costs the rest of the draft.
  }
}

export function readLiveState(): LiveDraftState | null {
  if (!fs.existsSync(LIVE_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')) as LiveDraftState
  } catch {
    return null
  }
}

export function myPickNumbers(teams: number, seat: number, rounds: number): number[] {
  return snakePicks(teams, seat, rounds)
}
