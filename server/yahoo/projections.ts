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

export interface ProjectionResult {
  /** Projected points by Yahoo numeric player id. Partial results are kept. */
  projections: Map<string, number>
  /** True when Yahoo stopped answering before the list was exhausted. */
  rateLimited: boolean
  /** Pages actually read, for the caller to report. */
  pages: number
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
  /** How long to wait out a denial before trying the same page once more. */
  backoffMs?: number
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
): Promise<ProjectionResult> {
  const positions = opts.positions ?? ['O', 'K', 'DEF']
  const limit = opts.limit ?? 300
  const delayMs =
    opts.delayMs ?? (Number.parseInt(process.env['PROJECTION_DELAY_MS'] ?? '', 10) || 2500)
  const backoffMs = opts.backoffMs ?? 45_000
  const stat1 = statParam(period)
  const out = new Map<string, number>()
  let pages = 0
  let rateLimited = false

  for (const position of positions) {
    if (rateLimited) break
    for (let start = 0; start < limit; start += PAGE_SIZE) {
      const url =
        `https://football.fantasysports.yahoo.com/f1/${leagueId}/players?` +
        `status=ALL&pos=${position}&cut_type=9&stat1=${stat1}` +
        `&myteam=0&sort=PTS&sdir=1&count=${start}`

      let response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.timeoutMs,
      })
      pages++

      // Yahoo answers 999 "Request denied" once enough of these have gone
      // through, and it is a window rather than a rate: pacing alone does not
      // avoid it. Wait it out once, then give up and keep what was collected -
      // a partial set of projections is worth far more than none, and throwing
      // it away is what the first version of this did.
      if (response?.status() === 999) {
        opts.onProgress?.(`  Yahoo denied the request; waiting ${Math.round(backoffMs / 1000)}s`)
        await page.waitForTimeout(backoffMs)
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: config.browser.timeoutMs,
        })
        pages++
      }
      if (response?.status() === 999) {
        rateLimited = true
        opts.onProgress?.(`  still denied; keeping the ${out.size} projections already read`)
        break
      }

      // The table is server-rendered, so this is settling the page rather than
      // waiting on a request, and it doubles as the gap between requests.
      await page.waitForTimeout(delayMs)

      // The page hands back raw text and links; deciding which column and
      // which id they mean happens in Node, where it can be tested. The bug
      // that cost the most time here was invisible inside the browser.
      const raw = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('table'))
        return tables.map((table) => {
          const headRows = Array.from(table.querySelectorAll('thead tr'))
          const header = headRows[headRows.length - 1]
          return {
            headers: Array.from(header?.querySelectorAll('th') ?? []).map(
              (th) => th.textContent ?? '',
            ),
            rows: Array.from(table.querySelectorAll('tbody tr')).map((tr) => ({
              hrefs: Array.from(tr.querySelectorAll('a')).map((a) => (a as HTMLAnchorElement).href),
              cells: Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? ''),
            })),
          }
        })
      })

      let column = -1
      let table: (typeof raw)[number] | undefined
      for (const candidate of raw) {
        const found = findFanPointsColumn(candidate.headers)
        if (found >= 0) {
          column = found
          table = candidate
          break
        }
      }

      const rows = {
        column,
        rows:
          table === undefined
            ? []
            : table.rows
                .map((row) => ({ id: rowPlayerId(row.hrefs), value: row.cells[column] ?? '' }))
                .filter((row): row is { id: string; value: string } => row.id !== null),
      }

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

  return { projections: out, rateLimited, pages }
}

/** The numeric id inside a Yahoo player key, e.g. `470.p.32723` -> `32723`. */
export function playerKeyId(playerKey: string): string {
  return playerKey.split('.').pop() ?? playerKey
}

/**
 * Yahoo appends a private-use glyph to every sortable column header, so the
 * header reading "Fan Pts" is really "Fan Pts" followed by U+E002. It renders
 * as nothing, `trim()` does not remove it and `\s` does not match it, so a
 * header compared literally never matches and the column looks absent while
 * printing identically to what it is being compared against.
 *
 * This lives outside the page so it can be tested, which is the whole point:
 * the bug was invisible precisely because every diagnostic went through the
 * same rendering that hid it.
 */
export function normalizeHeader(text: string): string {
  return text
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Which column holds projected points, or -1 when the table has no such column. */
export function findFanPointsColumn(headers: string[]): number {
  return headers.findIndex((header) => normalizeHeader(header) === 'fan pts')
}

/**
 * The player id a row refers to. Skill players link to a player page; a team
 * defence links to its team page instead and only carries its id in the
 * watchlist link.
 */
export function rowPlayerId(hrefs: string[]): string | null {
  for (const href of hrefs) {
    const player = href.match(/\/nfl\/players\/(\d+)/)
    if (player?.[1]) return player[1]
  }
  for (const href of hrefs) {
    const watch = href.match(/[?&]apid=(\d+)/)
    if (watch?.[1]) return watch[1]
  }
  return null
}
