import type { Page } from 'playwright'
import { config } from '../config.js'

/**
 * Yahoo's own projections.
 *
 * The JSON API carries actual points and no projection, but the site publishes
 * projections on the player list and renders them server-side. That is the only
 * place they exist, so this reads them there.
 *
 * It is deliberately narrow. Rather than parsing a page, it finds one column by
 * its header and takes one number per row, joined on the player id inside the
 * row's own link. A reordered column is a non-event and a renamed one produces
 * an empty result rather than a wrong one, which is the failure mode that
 * matters: a projection that is silently wrong is worse than none, because the
 * snapshot would report it as provider data and every ranking would trust it.
 */

const PAGE_SIZE = 25

export type StatPeriod =
  /** Projected points for a specific week. */
  | { kind: 'week'; week: number }
  /** Projected points for the rest of the season. */
  | { kind: 'season' }

function statParam(period: StatPeriod): string {
  return period.kind === 'week' ? `S_PW_${period.week}` : 'S_PS'
}

export interface ProjectionOptions {
  /** Yahoo position filter: O for offence, plus K and DEF separately. */
  positions?: string[]
  /** How many players to read per position before stopping. */
  limit?: number
  /**
   * Gap between page loads. These are full page requests rather than API calls
   * and Yahoo starts denying them if they arrive too fast, so this is a
   * politeness setting rather than a tuning knob.
   */
  delayMs?: number
  onProgress?: (message: string) => void
}

/**
 * Projected points keyed by Yahoo's numeric player id, which is the same number
 * that appears inside a player_key such as `470.p.32723`.
 */
export async function fetchProjections(
  page: Page,
  leagueId: string,
  period: StatPeriod,
  opts: ProjectionOptions = {},
): Promise<Map<string, number>> {
  const positions = opts.positions ?? ['O', 'K', 'DEF']
  const limit = opts.limit ?? 600
  const delayMs =
    opts.delayMs ?? (Number.parseInt(process.env['PROJECTION_DELAY_MS'] ?? '', 10) || 2500)
  const stat1 = statParam(period)
  const out = new Map<string, number>()

  for (const position of positions) {
    for (let start = 0; start < limit; start += PAGE_SIZE) {
      const url =
        `https://football.fantasysports.yahoo.com/f1/${leagueId}/players?` +
        `status=ALL&pos=${position}&cut_type=9&stat1=${stat1}` +
        `&myteam=0&sort=PTS&sdir=1&count=${start}`

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.timeoutMs,
      })

      // Yahoo answers 999 "Request denied" when these pages are requested too
      // quickly. Reading it as an empty list would quietly ship a snapshot with
      // no projections and no explanation, so stop and say what happened.
      if (response?.status() === 999) {
        throw new Error(
          'Yahoo rate-limited the player list (HTTP 999). Projections are ' +
            'incomplete; wait a few minutes and sync again.',
        )
      }

      // The table is server-rendered, so this is settling the page rather than
      // waiting on a request, and it doubles as the gap between requests.
      await page.waitForTimeout(delayMs)

      const rows = await page.evaluate(() => {
        // The page carries several tables and which one comes first is not
        // stable, so the player table is the one that has the column we want
        // rather than the one that happens to be first in the document.
        let table: HTMLTableElement | null = null
        let column = -1
        for (const candidate of Array.from(document.querySelectorAll('table'))) {
          const headRows = Array.from(candidate.querySelectorAll('thead tr'))
          const header = headRows[headRows.length - 1]
          // Yahoo appends a private-use glyph to every sortable header, so
          // "Fan Pts" is really "Fan Pts". It renders as nothing, trim()
          // does not remove it and \s does not match it, so comparing the
          // header literally never matches and the column looks absent. Strip
          // anything outside printable ASCII before comparing.
          const labels = Array.from(header?.querySelectorAll('th') ?? []).map((th) =>
            (th.textContent ?? '')
              .replace(/[^\x20-\x7e]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase(),
          )
          // By name, never by position: Yahoo moves these columns around.
          const found = labels.findIndex((label) => label === 'fan pts')
          if (found >= 0) {
            table = candidate as HTMLTableElement
            column = found
            break
          }
        }
        if (!table || column < 0) {
          return { column: -1, rows: [] as Array<{ id: string; value: string }> }
        }

        const body = Array.from(table.querySelectorAll('tbody tr'))
        const parsed: Array<{ id: string; value: string }> = []
        for (const tr of body) {
          const player = tr.querySelector('a[href*="/nfl/players/"]') as HTMLAnchorElement | null
          // A team defence links to the team page rather than a player page, so
          // its id has to come from the watchlist link instead.
          const watch = tr.querySelector('a[href*="apid="]') as HTMLAnchorElement | null
          const id =
            player?.href.match(/\/nfl\/players\/(\d+)/)?.[1] ??
            watch?.href.match(/[?&]apid=(\d+)/)?.[1]
          const cells = Array.from(tr.querySelectorAll('td'))
          const cell = cells[column]
          if (!id || !cell) continue
          parsed.push({ id, value: (cell.textContent ?? '').trim() })
        }
        return { column, rows: parsed }
      })

      if (rows.column < 0) {
        opts.onProgress?.(`  no "Fan Pts" column on the ${position} list; skipping projections`)
        break
      }
      if (rows.rows.length === 0) break

      for (const row of rows.rows) {
        const value = Number(row.value)
        if (Number.isFinite(value)) out.set(row.id, value)
      }
      opts.onProgress?.(`  ${out.size} projections`)
      if (rows.rows.length < PAGE_SIZE) break
    }
  }

  return out
}

/** The numeric id inside a Yahoo player key, e.g. `470.p.32723` -> `32723`. */
export function playerKeyId(playerKey: string): string {
  return playerKey.split('.').pop() ?? playerKey
}
