import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { config } from '../config.js'
import { API, collection, fetchJson, findBlock, flatten } from './draftFeed.js'

/**
 * What Yahoo knows that a projection built from box scores cannot.
 *
 * Three things, all from the same call. Where a player actually goes in real
 * drafts, which is the difference between "he is the best available" and "he
 * will still be there next round" - a board that ranks without it is guessing
 * at the only question that decides whether to take someone now. Whether he is
 * hurt. And what a human wrote about him this week, which is the entire
 * category of information production cannot see: a holdout, a committee, a job
 * won in camp.
 *
 * Yahoo also projects rookies, and does it far better than draft capital alone
 * can. A curve fitted to draft slot says two receivers taken four picks apart
 * are worth the same; Yahoo knows one of them is buried and the other is
 * starting.
 */

const PAGE_SIZE = 25

export interface MarketEntry {
  /** Yahoo's numeric player id, matching the number inside a player key. */
  playerId: string
  name: string
  /** Average pick across real drafts, when enough of them have happened. */
  averagePick: number | null
  averageRound: number | null
  /** Share of drafts the player is taken in, 0 to 1. */
  percentDrafted: number | null
  /** Yahoo's own projection, which covers rookies that have no history. */
  projected: number | null
  /** Short injury descriptor, e.g. "Knee". */
  injury: string | null
  /** Most recent written note, usually a Rotowire outlook. */
  headline: string | null
  note: string | null
  noteAt: number | null
}

const cacheFile = (leagueId: string): string =>
  path.join(config.cache.dir, `market-${leagueId}.json`)

function num(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export interface MarketOptions {
  /** How many players to read, richest first. */
  limit?: number
  onProgress?: (message: string) => void
}

/**
 * Read the market for the players who could plausibly be drafted.
 *
 * Sorted by Yahoo's own rank so the budget is spent on players who matter; the
 * thousandth-ranked receiver has no meaningful average pick anyway.
 */
export async function fetchMarket(
  page: Page,
  leagueKey: string,
  opts: MarketOptions = {},
): Promise<Map<string, MarketEntry>> {
  const limit = opts.limit ?? 400
  const out = new Map<string, MarketEntry>()

  for (let start = 0; start < limit; start += PAGE_SIZE) {
    const url =
      `${API}/league/${leagueKey}/players;start=${start};count=${PAGE_SIZE};sort=AR;` +
      `out=draft_analysis,player_notes?format=json`
    const payload = await fetchJson(page, url)
    const players = collection<unknown>(findBlock(payload, 'players'), 'player')
    if (players.length === 0) break

    for (const entry of players) {
      const flat = flatten(entry)
      const key = String(flat['player_key'] ?? '')
      const playerId = key.split('.').pop() ?? ''
      if (!playerId) continue

      const analysis = flatten(flat['draft_analysis'])
      const notes = (flat['player_notes'] as Array<{ player_note?: Record<string, unknown> }>) ?? []
      const latest = notes[0]?.player_note

      out.set(playerId, {
        playerId,
        name: String((flat['name'] as { full?: string } | undefined)?.full ?? ''),
        averagePick: num(analysis['average_pick']),
        averageRound: num(analysis['average_round']),
        percentDrafted: num(analysis['percent_drafted']),
        projected: num(flatten(flat['player_points'])['total']),
        injury: flat['injury_note'] ? String(flat['injury_note']) : null,
        headline: latest ? String(latest['headline'] ?? '') || null : null,
        note: latest ? String(latest['text'] ?? '') || null : null,
        noteAt: num(flat['player_notes_last_timestamp']),
      })
    }
    opts.onProgress?.(`  ${out.size} players`)
    if (players.length < PAGE_SIZE) break
  }

  return out
}

export function saveMarket(leagueId: string, market: Map<string, MarketEntry>): void {
  fs.mkdirSync(config.cache.dir, { recursive: true })
  fs.writeFileSync(cacheFile(leagueId), JSON.stringify([...market.values()]))
}

/**
 * The cached market, and how old it is. Average pick moves slowly and a note
 * written this morning is still worth reading tonight, so a stale file is used
 * rather than discarded - but the age is returned so it can be said out loud.
 */
export function loadMarket(leagueId: string): { market: Map<string, MarketEntry>; ageSeconds: number } {
  const file = cacheFile(leagueId)
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as MarketEntry[]
    const ageSeconds = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 1000)
    return { market: new Map(entries.map((entry) => [entry.playerId, entry])), ageSeconds }
  } catch {
    return { market: new Map(), ageSeconds: Number.POSITIVE_INFINITY }
  }
}

/**
 * How many picks from now a player is expected to last.
 *
 * Null when too few real drafts have taken him for an average to mean anything,
 * which is honest: a board that invents an average pick for a player nobody
 * drafts would say he is about to be taken, and he never is.
 */
export function picksUntilGone(entry: MarketEntry | undefined, currentPick: number): number | null {
  if (!entry?.averagePick) return null
  if ((entry.percentDrafted ?? 0) < 0.1) return null
  return Math.round(entry.averagePick - currentPick)
}
