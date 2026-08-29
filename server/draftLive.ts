import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { buildView, positionCliffs, remainingNeeds, snakePicks } from './draftWatch.js'
import type { RankedPlayer, LeagueShape } from './draftPool.js'
import type { DraftPick, YahooPlayer } from './yahoo/draftFeed.js'

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
  notes: string[]
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
  isMyTurn: boolean
  totalPicks: number
  recent: LivePick[]
  myRoster: LiveSuggestion[]
  needs: Record<string, number>
  suggestions: LiveSuggestion[]
  cliffs: LiveCliff[]
  unmatchedPicks: number
}

function toSuggestion(player: RankedPlayer, needs: Record<string, number>): LiveSuggestion {
  return {
    playerId: player.playerId,
    name: player.name,
    position: player.position,
    team: player.team ?? '',
    vorp: Number(player.vorp.toFixed(1)),
    projectedPpg: Number(player.projectedPpg.toFixed(1)),
    fillsNeed: (needs[player.position] ?? 0) > 0,
    notes: player.notes ?? [],
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
  const needs = remainingNeeds(view.myRoster, opts.shape.starters)

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
  const suggestions = view.available.slice(0, 25).map((player) => toSuggestion(player, needs))

  const cliffs = positionCliffs(
    view.available,
    view.picksUntilNext,
    Object.keys(opts.shape.starters),
  )
    .filter((cliff) => (needs[cliff.position] ?? 0) > 0)
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
    isMyTurn: view.picksUntilNext === 0,
    totalPicks: picks.length,
    recent,
    myRoster: view.myRoster.map((player) => toSuggestion(player, needs)),
    needs,
    suggestions,
    cliffs,
    unmatchedPicks: picks.filter((pick) => !matched.has(pick.playerKey)).length,
  }
}

export function writeLiveState(state: LiveDraftState): void {
  fs.mkdirSync(path.dirname(LIVE_FILE), { recursive: true })
  const temporary = `${LIVE_FILE}.tmp`
  // Written then renamed, so a phone polling mid-write never reads half a file.
  fs.writeFileSync(temporary, JSON.stringify(state))
  fs.renameSync(temporary, LIVE_FILE)
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
