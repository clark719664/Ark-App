import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { config } from '../config.js'

/**
 * The live draft feed.
 *
 * Yahoo's draft room is a websocket application and its HTML is not worth
 * parsing, but the site also reads its own JSON API, and that API exposes the
 * draft as a plain list of picks. Polling it is far more robust than scraping
 * a page built to be rendered, and it is the same data the room shows.
 *
 * Every request is issued from inside the logged-in page, so Yahoo's session
 * cookies apply without this ever handling a credential.
 */

export const API = 'https://pub-api-rw.fantasysports.yahoo.com/fantasy/v2'

export interface DraftPick {
  pick: number
  round: number
  teamKey: string
  playerKey: string
}

export interface YahooPlayer {
  playerKey: string
  name: string
  position: string
  team: string
}

export async function fetchJson(page: Page, url: string): Promise<unknown> {
  const raw = await page.evaluate(async (target: string) => {
    const response = await fetch(target, { credentials: 'include' })
    return `${response.status} ${await response.text()}`
  }, url)
  const separator = raw.indexOf(' ')
  const status = Number(raw.slice(0, separator))
  const body = raw.slice(separator + 1)
  if (status !== 200) throw new Error(`Yahoo returned ${status} for ${url}`)
  return JSON.parse(body)
}

export function leagueNodes(payload: unknown): Record<string, unknown>[] {
  const content = (payload as { fantasy_content?: { league?: unknown[] } })?.fantasy_content
  return (content?.league ?? []) as Record<string, unknown>[]
}

export function findBlock(payload: unknown, key: string): Record<string, unknown> | undefined {
  const node = leagueNodes(payload).find((entry) => entry && entry[key] !== undefined)
  return node?.[key] as Record<string, unknown> | undefined
}

/**
 * Yahoo returns collections as an object keyed by index with a `count`, not an
 * array, and wraps each member in a single-key object.
 */
export function collection<T>(block: Record<string, unknown> | undefined, member: string): T[] {
  if (!block) return []
  const count = Number(block['count'] ?? 0)
  const items: T[] = []
  for (let index = 0; index < count; index++) {
    const entry = block[String(index)] as Record<string, unknown> | undefined
    const value = entry?.[member]
    if (value !== undefined) items.push(value as T)
  }
  return items
}

/** Yahoo splits one entity across a nested array of partial objects. */
export function flatten(entry: unknown): Record<string, unknown> {
  const parts = Array.isArray(entry) ? entry.flat(2) : [entry]
  const merged: Record<string, unknown> = {}
  for (const part of parts) {
    if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(merged, part)
  }
  return merged
}

export async function fetchDraftPicks(page: Page, leagueKey: string): Promise<DraftPick[]> {
  const payload = await fetchJson(page, `${API}/league/${leagueKey}/draftresults?format=json`)
  const raw = collection<Record<string, unknown>>(findBlock(payload, 'draft_results'), 'draft_result')
  return raw
    .map((entry) => ({
      pick: Number(entry['pick']),
      round: Number(entry['round']),
      teamKey: String(entry['team_key'] ?? ''),
      playerKey: String(entry['player_key'] ?? ''),
    }))
    .filter((entry) => Number.isFinite(entry.pick) && entry.playerKey !== '')
    .sort((a, b) => a.pick - b.pick)
}

export async function fetchDraftStatus(page: Page, leagueKey: string): Promise<string> {
  const payload = await fetchJson(page, `${API}/league/${leagueKey}?format=json`)
  const meta = leagueNodes(payload).find((entry) => entry && entry['draft_status'] !== undefined)
  return String(meta?.['draft_status'] ?? 'unknown')
}

export interface LeagueTeam {
  teamKey: string
  name: string
  managers: string
}

export async function fetchTeams(page: Page, leagueKey: string): Promise<LeagueTeam[]> {
  const payload = await fetchJson(page, `${API}/league/${leagueKey}/teams?format=json`)
  const raw = collection<unknown>(findBlock(payload, 'teams'), 'team')
  return raw.map((entry) => {
    const flat = flatten(entry)
    const managers = (flat['managers'] as Array<{ manager?: { nickname?: string } }> | undefined) ?? []
    return {
      teamKey: String(flat['team_key'] ?? ''),
      name: String(flat['name'] ?? ''),
      managers: managers
        .map((holder) => holder.manager?.nickname ?? '')
        .filter(Boolean)
        .join(', '),
    }
  })
}

const PLAYER_CACHE = path.join(config.cache.dir, 'yahoo-players.json')

/**
 * Every player Yahoo knows for this league, keyed by player_key.
 *
 * Built once and cached: a draft pick names a key, not a player, and looking
 * each one up as it happens would put a network request on the critical path
 * of an update that has sixty seconds to be worth anything.
 */
export async function loadPlayerIndex(
  page: Page,
  leagueKey: string,
  opts: { refresh?: boolean; onProgress?: (message: string) => void } = {},
): Promise<Map<string, YahooPlayer>> {
  if (!opts.refresh && fs.existsSync(PLAYER_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(PLAYER_CACHE, 'utf8')) as YahooPlayer[]
    if (cached.length > 0) return new Map(cached.map((player) => [player.playerKey, player]))
  }

  const players: YahooPlayer[] = []
  const seen = new Set<string>()
  for (let start = 0; start < 2000; start += 25) {
    const url = `${API}/league/${leagueKey}/players;start=${start};count=25?format=json`
    const payload = await fetchJson(page, url)
    const raw = collection<unknown>(findBlock(payload, 'players'), 'player')
    if (raw.length === 0) break
    for (const entry of raw) {
      const flat = flatten(entry)
      const key = String(flat['player_key'] ?? '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      players.push({
        playerKey: key,
        name: String((flat['name'] as { full?: string } | undefined)?.full ?? ''),
        position: String(flat['display_position'] ?? ''),
        team: String(flat['editorial_team_abbr'] ?? ''),
      })
    }
    opts.onProgress?.(`  ${players.length} players indexed`)
  }

  fs.mkdirSync(config.cache.dir, { recursive: true })
  fs.writeFileSync(PLAYER_CACHE, JSON.stringify(players))
  return new Map(players.map((player) => [player.playerKey, player]))
}

/**
 * Picks reconstructed from team rosters.
 *
 * A fallback for one specific failure: `/draftresults` being written only once
 * a draft finishes rather than as it runs. That has not been observed, but it
 * cannot be tested before a real draft either, and finding out at the first
 * pick is not a position worth being in. Rosters fill as players are taken
 * regardless, so they answer the questions that actually drive the board -
 * who is gone and who is mine.
 *
 * Pick numbers are not recoverable this way, so they are assigned in roster
 * order and the count is what matters rather than the sequence.
 */
export async function fetchRosterPicks(
  page: Page,
  leagueKey: string,
  teamIds: string[],
  week: number,
): Promise<DraftPick[]> {
  const picks: DraftPick[] = []
  for (const id of teamIds) {
    const teamKey = `${leagueKey}.t.${id}`
    const payload = await fetchJson(page, `${API}/team/${teamKey}/roster;week=${week}?format=json`)
    const teamNode = flatten((payload as { fantasy_content: { team: unknown } }).fantasy_content.team)
    const roster = teamNode['roster'] as Record<string, unknown> | undefined
    const holder = (roster?.['0'] ?? roster) as Record<string, unknown> | undefined
    const entries = collection<unknown>(
      (holder?.['players'] ?? roster?.['players']) as Record<string, unknown> | undefined,
      'player',
    )
    for (const entry of entries) {
      const key = String(flatten(entry)['player_key'] ?? '')
      if (!key) continue
      picks.push({ pick: picks.length + 1, round: 0, teamKey, playerKey: key })
    }
  }
  return picks.map((pick, index) => ({ ...pick, pick: index + 1 }))
}

export interface LeagueSetup {
  leagueKey: string
  leagueName: string
  teams: number
  /** Draft slots per team: every roster position except injured reserve. */
  rounds: number
  /** This manager's seat in the first round, from Yahoo's own draft order. */
  seat: number
  myTeamId: string
  myTeamName: string
  starters: Record<string, number>
  flex: number
  draftStatus: string
}

/** Slot names Yahoo uses for a spot that takes more than one position. */
const FLEX_SLOTS = new Set(['W/R/T', 'W/R', 'W/T', 'R/W/T', 'Q/W/R/T', 'FLEX'])

/**
 * Everything about a league that the watcher would otherwise be told by hand.
 *
 * Six environment variables had to agree with the league or the board was
 * quietly wrong about somebody's seat. Yahoo knows all of it, so ask: the seat
 * from the draft order, the shape from the roster positions, the round count
 * from how many of them are startable. Anything set explicitly still wins,
 * because a commissioner can change a setting after a draft order is out.
 */
export async function fetchLeagueSetup(page: Page, leagueKey: string): Promise<LeagueSetup> {
  const payload = await fetchJson(page, `${API}/league/${leagueKey}/settings?format=json`)
  const nodes = leagueNodes(payload)
  const meta = flatten(nodes.filter((node) => node && !node['settings']))
  const settings = flatten(findBlock(payload, 'settings'))

  const starters: Record<string, number> = {}
  let flex = 0
  let rounds = 0
  for (const holder of (settings['roster_positions'] as Array<Record<string, unknown>>) ?? []) {
    const slot = (holder['roster_position'] ?? holder) as Record<string, unknown>
    const position = String(slot['position'] ?? '')
    const count = Number(slot['count'] ?? 0)
    if (!position || !Number.isFinite(count)) continue
    // Injured reserve is not a draft slot; the bench is.
    if (position !== 'IR') rounds += count
    if (position === 'BN' || position === 'IR') continue
    if (FLEX_SLOTS.has(position)) flex += count
    else starters[position] = (starters[position] ?? 0) + count
  }

  const teamsPayload = await fetchJson(page, `${API}/league/${leagueKey}/teams?format=json`)
  let myTeamId = ''
  let myTeamName = ''
  for (const entry of collection<unknown>(findBlock(teamsPayload, 'teams'), 'team')) {
    const team = flatten(entry)
    if (String(team['is_owned_by_current_login'] ?? '') !== '1') continue
    myTeamId = String(team['team_key'] ?? '').split('.t.')[1] ?? ''
    myTeamName = String(team['name'] ?? '')
  }

  return {
    leagueKey,
    leagueName: String(meta['name'] ?? leagueKey),
    teams: Number(meta['num_teams'] ?? 0) || 0,
    rounds: rounds || 15,
    seat: Number(meta['draft_position'] ?? 0) || 0,
    myTeamId,
    myTeamName,
    starters,
    flex,
    draftStatus: String(meta['draft_status'] ?? 'unknown'),
  }
}
