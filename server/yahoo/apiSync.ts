import type { Page } from 'playwright'
import type {
  DraftPick, League, LeagueSnapshot, Matchup, Player, PlayerPosition, RosterEntry,
  RosterSlotConfig, Team,
} from '../../shared/types.js'
import { config } from '../config.js'
import { openSession } from './browser.js'
import { API, collection, fetchJson, findBlock, flatten } from './draftFeed.js'
import { fetchProjections, playerKeyId } from './projections.js'
import { assessDataQuality } from './sync.js'

/**
 * Reading a league through Yahoo's own JSON API.
 *
 * The HTML scrapers parse nothing from this league's real pages, and fixing
 * them means chasing a rendered layout that Yahoo can change whenever it likes.
 * The site itself does not read that layout - it calls pub-api.fantasysports
 * and renders the answer. So this does the same. It is the same data, already
 * structured, and a redesign of the page cannot break it.
 *
 * The API does not carry a projection. Yahoo publishes those on the player
 * list instead, rendered into the page, so they are read from there and joined
 * on the player id in each row's own link. If that column ever disappears the
 * snapshot falls back to season form and says so, rather than shipping a
 * ranking built on nothing.
 */

const POSITIONS = new Set<PlayerPosition>([
  'QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB', 'CB', 'S', 'DE', 'DT',
])

function toPosition(value: string): PlayerPosition {
  const upper = value.trim().toUpperCase()
  if (upper === 'D/ST' || upper === 'DST') return 'DEF'
  return POSITIONS.has(upper as PlayerPosition) ? (upper as PlayerPosition) : 'UNKNOWN'
}

const num = (value: unknown): number | undefined => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Yahoo team keys end in `.t.<id>`; Ark keys teams by that id alone. */
function teamId(teamKey: string): string {
  const match = teamKey.match(/\.t\.(\d+)$/)
  return match?.[1] ?? teamKey
}

function playerFrom(entry: unknown): Player | null {
  const flat = flatten(entry)
  const key = String(flat['player_key'] ?? '')
  if (!key) return null

  const eligible = (flat['eligible_positions'] as Array<{ position?: string }> | undefined) ?? []
  const points = flatten(flat['player_points'])
  const ownership = flatten(flat['ownership'])
  const bye = flatten(flat['bye_weeks'])
  const status = String(flat['status'] ?? '')

  const player: Player = {
    id: key,
    name: String((flat['name'] as { full?: string } | undefined)?.full ?? ''),
    position: toPosition(String(flat['display_position'] ?? '')),
    nflTeam: String(flat['editorial_team_abbr'] ?? '').toUpperCase(),
  }

  const secondary = eligible
    .map((slot) => toPosition(String(slot.position ?? '')))
    .filter((position) => position !== 'UNKNOWN')
  if (secondary.length > 0) player.eligiblePositions = [...new Set(secondary)]

  const byeWeek = num(bye['week'])
  if (byeWeek !== undefined) player.byeWeek = byeWeek

  if (status) {
    player.injury = { code: status }
    const label = String(flat['status_full'] ?? '')
    if (label) player.injury.label = label
  }

  const season = num(points['total'])
  if (season !== undefined) player.points = { season }

  const percentOwned = num(flatten(flat['percent_owned'])['value'] ?? ownership['percent_owned'])
  if (percentOwned !== undefined) player.ownership = { percentOwned }

  return player
}

async function paged<T>(
  page: Page,
  url: (start: number) => string,
  member: string,
  block: string,
  map: (entry: unknown) => T | null,
  onProgress?: (count: number) => void,
): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; start < 2000; start += 25) {
    const payload = await fetchJson(page, url(start))
    const raw = collection<unknown>(findBlock(payload, block), member)
    if (raw.length === 0) break
    for (const entry of raw) {
      const value = map(entry)
      if (value !== null) out.push(value)
    }
    onProgress?.(out.length)
  }
  return out
}

export interface ApiSyncOptions {
  leagueId?: string
  teamId?: string
  /** Skip the projection pass, which is the slow part of a sync. */
  skipProjections?: boolean
  onProgress?: (message: string) => void
}

export async function syncLeagueViaApi(opts: ApiSyncOptions = {}): Promise<LeagueSnapshot> {
  const leagueId = opts.leagueId ?? config.yahoo.leagueId
  if (!leagueId) throw new Error('YAHOO_LEAGUE_ID is not set')
  const leagueKey = /^\d+$/.test(leagueId) ? `nfl.l.${leagueId}` : leagueId
  const mineId = opts.teamId ?? config.yahoo.teamId
  const log = opts.onProgress ?? (() => {})
  const warnings: string[] = []

  const session = await openSession({ headed: false })
  try {
    await session.page.goto(`https://football.fantasysports.yahoo.com/f1/${leagueId}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.timeoutMs,
    })
    const page = session.page

    log('Reading league settings...')
    const settingsPayload = await fetchJson(page, `${API}/league/${leagueKey}/settings?format=json`)
    const meta = flatten(
      (settingsPayload as { fantasy_content: { league: unknown[] } }).fantasy_content.league.filter(
        (node) => node && typeof node === 'object' && !(node as Record<string, unknown>)['settings'],
      ),
    )
    const settings = flatten(findBlock(settingsPayload, 'settings'))

    const rosterSlots: RosterSlotConfig[] = []
    for (const holder of (settings['roster_positions'] as Array<{ roster_position?: Record<string, unknown> }>) ?? []) {
      const slot = holder.roster_position ?? (holder as unknown as Record<string, unknown>)
      const count = num(slot['count'])
      if (slot['position'] && count !== undefined) {
        rosterSlots.push({ slot: String(slot['position']), count })
      }
    }

    const currentWeek = num(meta['current_week']) ?? 1
    const regularSeasonWeeks = (num(settings['playoff_start_week']) ?? 15) - 1
    const league: League = {
      id: String(meta['league_id'] ?? leagueId),
      provider: 'yahoo',
      name: String(meta['name'] ?? `League ${leagueId}`),
      season: num(meta['season']) ?? config.yahoo.season,
      numTeams: num(meta['num_teams']) ?? 0,
      currentWeek,
      regularSeasonWeeks,
      playoffTeams: num(settings['num_playoff_teams']) ?? 4,
      scoringType: String(meta['scoring_type'] ?? ''),
      isAuction: String(settings['is_auction_draft'] ?? '0') === '1',
      rosterSlots,
      url: String(meta['url'] ?? ''),
    }
    log(`  ${league.name} (${league.season}), week ${league.currentWeek}`)

    log('Reading standings...')
    const standingsPayload = await fetchJson(page, `${API}/league/${leagueKey}/standings?format=json`)
    const standingsBlock = findBlock(standingsPayload, 'standings')
    const teamsHolder = (standingsBlock?.['0'] ?? standingsBlock) as Record<string, unknown> | undefined
    const teamEntries = collection<unknown>(
      (teamsHolder?.['teams'] ?? standingsBlock?.['teams']) as Record<string, unknown> | undefined,
      'team',
    )
    const teams: Team[] = teamEntries.map((entry) => {
      const flat = flatten(entry)
      const standings = flatten(flat['team_standings'])
      const outcome = flatten(standings['outcome_totals'])
      const points = flatten(flat['team_points'])
      const managers = (flat['managers'] as Array<{ manager?: { nickname?: string } }> | undefined) ?? []
      const id = teamId(String(flat['team_key'] ?? ''))
      const team: Team = {
        id,
        name: String(flat['name'] ?? ''),
        record: {
          wins: num(outcome['wins']) ?? 0,
          losses: num(outcome['losses']) ?? 0,
          ties: num(outcome['ties']) ?? 0,
        },
        pointsFor: num(standings['points_for']) ?? num(points['total']) ?? 0,
        pointsAgainst: num(standings['points_against']) ?? 0,
      }
      const rank = num(standings['rank'])
      if (rank !== undefined) team.rank = rank
      const streak = flatten(standings['streak'])
      if (streak['type']) team.streak = `${String(streak['type']).charAt(0).toUpperCase()}${streak['value'] ?? ''}`
      const waiver = num(flat['waiver_priority'])
      if (waiver !== undefined) team.waiverPriority = waiver
      const moves = num(flat['number_of_moves'])
      if (moves !== undefined) team.movesMade = moves
      const trades = num(flat['number_of_trades'])
      if (trades !== undefined) team.tradesMade = trades
      const manager = managers.map((m) => m.manager?.nickname ?? '').filter(Boolean).join(', ')
      if (manager) team.managerName = manager
      if (mineId && id === mineId) team.isMine = true
      return team
    })
    log(`  ${teams.length} teams`)
    if (teams.length === 0) warnings.push('No teams came back from the standings endpoint.')

    log('Reading rosters...')
    const rosters: Record<string, RosterEntry[]> = {}
    for (const team of teams) {
      const payload = await fetchJson(
        page,
        `${API}/team/${leagueKey}.t.${team.id}/roster;week=${currentWeek}?format=json`,
      )
      const teamNode = flatten((payload as { fantasy_content: { team: unknown } }).fantasy_content.team)
      const roster = teamNode['roster'] as Record<string, unknown> | undefined
      const holder = (roster?.['0'] ?? roster) as Record<string, unknown> | undefined
      const entries = collection<unknown>(
        (holder?.['players'] ?? roster?.['players']) as Record<string, unknown> | undefined,
        'player',
      )
      rosters[team.id] = entries
        .map((entry) => {
          const player = playerFrom(entry)
          if (!player) return null
          player.ownerTeamId = team.id
          const slot = flatten(flatten(entry)['selected_position'])
          const label = String(slot['position'] ?? 'BN')
          const rosterEntry: RosterEntry = {
            slot: label,
            starter: label !== 'BN' && label !== 'IR',
            player,
          }
          const points = player.points?.season
          if (points !== undefined) rosterEntry.points = points
          return rosterEntry
        })
        .filter((entry): entry is RosterEntry => entry !== null)
    }
    const rostered = Object.values(rosters).flat().length
    log(`  ${rostered} rostered players`)
    if (rostered === 0) {
      warnings.push('Rosters are empty. Before a draft this is expected.')
    }

    log('Reading the player pool...')
    const pool = await paged<Player>(
      page,
      (start) =>
        `${API}/league/${leagueKey}/players;start=${start};count=25;out=stats,ownership?format=json`,
      'player',
      'players',
      playerFrom,
      (count) => log(`  ${count} players`),
    )
    // Season points are what the API gives; an average needs games played, and
    // the closest honest stand-in is points over the weeks played so far.
    const weeksPlayed = Math.max(1, currentWeek - 1)
    for (const player of pool) {
      const season = player.points?.season
      if (season !== undefined && season > 0) {
        player.points = { ...player.points, average: Number((season / weeksPlayed).toFixed(2)) }
      }
    }
    const byKey = new Map(pool.map((player) => [player.id, player]))

    if (!opts.skipProjections) {
      log('Reading projections...')
      try {
        const week = await fetchProjections(page, leagueId, { kind: 'week', week: currentWeek }, {
          onProgress: (message) => log(message),
        })
        const season = await fetchProjections(page, leagueId, { kind: 'season' }, {
          onProgress: () => {},
        })
        let attached = 0
        for (const player of pool) {
          const id = playerKeyId(player.id)
          const projected = week.get(id)
          const seasonProjection = season.get(id)
          if (projected === undefined && seasonProjection === undefined) continue
          player.points = { ...player.points }
          if (projected !== undefined) {
            player.points.projected = projected
            attached++
          }
          // A season projection is a better average than points-so-far when the
          // season has barely started, and the only one available before it does.
          if (seasonProjection !== undefined && !player.points.average) {
            player.points.average = Number((seasonProjection / 17).toFixed(2))
          }
        }
        log(`  ${attached} players carry a week ${currentWeek} projection`)
        if (attached === 0) {
          warnings.push('Yahoo returned no projections; rankings fall back to season form.')
        }
      } catch (err) {
        warnings.push(
          `Projections could not be read (${err instanceof Error ? err.message : String(err)}); ` +
            'rankings fall back to season form.',
        )
      }
    }

    // Enriched only now, so roster entries carry the projections too.
    for (const entries of Object.values(rosters)) {
      for (const entry of entries) {
        const enriched = entry.player ? byKey.get(entry.player.id) : undefined
        if (entry.player && enriched?.points) {
          entry.player.points = { ...entry.player.points, ...enriched.points }
          entry.projected = enriched.points.projected ?? entry.projected
        }
      }
    }

    log('Reading matchups...')
    const matchups: Matchup[] = []
    for (let week = 1; week <= Math.max(currentWeek, 1); week++) {
      const payload = await fetchJson(
        page,
        `${API}/league/${leagueKey}/scoreboard;week=${week}?format=json`,
      )
      const scoreboard = findBlock(payload, 'scoreboard')
      const holder = (scoreboard?.['0'] ?? scoreboard) as Record<string, unknown> | undefined
      for (const entry of collection<Record<string, unknown>>(
        holder?.['matchups'] as Record<string, unknown> | undefined,
        'matchup',
      )) {
        const sidesBlock = (entry['0'] ?? entry) as Record<string, unknown>
        const sides = collection<unknown>(sidesBlock['teams'] as Record<string, unknown>, 'team').map(
          (side) => {
            const flat = flatten(side)
            return {
              teamId: teamId(String(flat['team_key'] ?? '')),
              score: num(flatten(flat['team_points'])['total']) ?? 0,
            }
          },
        )
        const [home, away] = sides
        if (!home || !away) continue
        const final = String(entry['status'] ?? '') === 'postevent'
        matchups.push({
          week,
          home,
          away,
          winnerTeamId: final ? (home.score >= away.score ? home.teamId : away.teamId) : null,
          isPlayoff: String(entry['is_playoffs'] ?? '0') === '1',
          isConsolation: String(entry['is_consolation'] ?? '0') === '1',
          final,
        })
      }
    }
    log(`  ${matchups.length} matchups`)

    log('Reading draft results...')
    const draftPayload = await fetchJson(page, `${API}/league/${leagueKey}/draftresults?format=json`)
    const draft: DraftPick[] = collection<Record<string, unknown>>(
      findBlock(draftPayload, 'draft_results'),
      'draft_result',
    )
      .map((entry) => {
        const overall = num(entry['pick']) ?? 0
        const key = String(entry['player_key'] ?? '')
        const player = byKey.get(key)
        const pick: DraftPick = {
          overall,
          round: num(entry['round']) ?? 0,
          pickInRound: league.numTeams > 0 ? ((overall - 1) % league.numTeams) + 1 : overall,
          teamId: teamId(String(entry['team_key'] ?? '')),
          playerName: player?.name ?? key,
        }
        if (key) pick.playerId = key
        if (player) {
          pick.position = player.position
          pick.nflTeam = player.nflTeam
        }
        const cost = num(entry['cost'])
        if (cost !== undefined) pick.cost = cost
        return pick
      })
      .filter((pick) => pick.overall > 0)
    log(`  ${draft.length} picks`)

    const dataQuality = assessDataQuality(rosters)


    return {
      league,
      teams,
      matchups,
      rosters,
      players: pool,
      draft,
      fetchedAt: new Date().toISOString(),
      warnings,
      dataQuality,
    }
  } finally {
    await session.close()
  }
}
