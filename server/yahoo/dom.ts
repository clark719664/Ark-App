import type { Page } from 'playwright'

/**
 * Generic DOM extraction.
 *
 * Ark never reaches into Yahoo's markup with positional selectors like
 * `tr:nth-child(3) td:nth-child(5)`. Those break the moment Yahoo inserts a
 * column, and they break silently — which is worse than breaking loudly.
 *
 * Instead we pull whole tables out generically, keeping each cell's text *and*
 * its links, then address columns by header name with a list of aliases. A
 * renamed column produces a warning naming the header we couldn't find; a
 * reordered column produces no problem at all.
 */

export interface CellLink {
  href: string
  text: string
}

export interface Cell {
  text: string
  links: CellLink[]
  /** Any img in the cell, e.g. a team logo. */
  img?: string
  /** class attribute, occasionally the only signal for injury tags. */
  className?: string
}

export interface TableDump {
  index: number
  id: string
  className: string
  caption: string
  headers: string[]
  rows: Cell[][]
}

/**
 * Serialize every table on the page. Runs inside the browser so it sees the
 * DOM after Yahoo's client-side rendering, not the initial HTML payload.
 */
export async function extractTables(page: Page): Promise<TableDump[]> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

    /**
     * textContent concatenates adjacent elements with nothing between them, so
     * `<a>Team 2</a><span>99.30</span>` reads as "Team 299.30" and a score
     * parses as 299.3. Walk the text nodes and join them with a space so
     * separate elements stay separate words.
     */
    const textOf = (el: Element): string => {
      const parts: string[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const value = clean(walker.currentNode.nodeValue)
        if (value) parts.push(value)
      }
      return parts.join(' ')
    }

    const readCell = (el: Element) => ({
      text: textOf(el),
      links: Array.from(el.querySelectorAll('a'))
        .map((a) => ({ href: (a as HTMLAnchorElement).getAttribute('href') ?? '', text: textOf(a) }))
        .filter((l) => l.href !== ''),
      img: el.querySelector('img')?.getAttribute('src') ?? undefined,
      className: (el as HTMLElement).className || undefined,
    })

    return Array.from(document.querySelectorAll('table')).map((table, index) => {
      // Prefer an explicit thead; fall back to the first row that is all <th>.
      let headerCells = Array.from(table.querySelectorAll('thead th'))
      if (headerCells.length === 0) {
        const firstRow = table.querySelector('tr')
        if (firstRow && firstRow.querySelectorAll('th').length > 0) {
          headerCells = Array.from(firstRow.querySelectorAll('th'))
        }
      }
      const headers = headerCells.map((th) => textOf(th))

      const bodyRows = Array.from(
        table.querySelectorAll('tbody tr').length > 0
          ? table.querySelectorAll('tbody tr')
          : table.querySelectorAll('tr'),
      ).filter((tr) => tr.querySelectorAll('td').length > 0)

      return {
        index,
        id: table.id || '',
        className: (table as HTMLElement).className || '',
        caption: (() => {
          const caption = table.querySelector('caption')
          return caption ? textOf(caption) : ''
        })(),
        headers,
        rows: bodyRows.map((tr) => Array.from(tr.querySelectorAll('td')).map(readCell)),
      }
    })
  })
}

/** Every anchor on the page, in document order, with its DOM depth path. */
export interface AnchorDump {
  href: string
  text: string
  /** Text of the closest block-ish ancestor — the team's own row. */
  contextText: string
  /**
   * Text of the smallest ancestor holding two or more matching anchors: the
   * matchup card. Status markers like "Final" sit here rather than on either
   * team's row, so they are only visible at this level.
   */
  cardText: string
  /** Index of the ancestor container, so anchors can be grouped. */
  groupKey: string
}

export async function extractAnchors(page: Page, hrefPattern: string): Promise<AnchorDump[]> {
  return page.evaluate((pattern: string) => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
    const re = new RegExp(pattern)

    // See extractTables: adjacent elements must not run together, or a team
    // name and its score parse as one number.
    const textOf = (el: Element): string => {
      const parts: string[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const value = clean(walker.currentNode.nodeValue)
        if (value) parts.push(value)
      }
      return parts.join(' ')
    }

    // A stable-ish identifier for an element's position in the tree, so two
    // anchors inside the same matchup card share a prefix.
    const pathOf = (el: Element): string => {
      const parts: string[] = []
      let node: Element | null = el
      while (node && node !== document.body && parts.length < 24) {
        const parent: Element | null = node.parentElement
        if (!parent) break
        parts.unshift(String(Array.prototype.indexOf.call(parent.children, node)))
        node = parent
      }
      return parts.join('/')
    }

    return Array.from(document.querySelectorAll('a'))
      .filter((a) => re.test(a.getAttribute('href') ?? ''))
      .map((a) => {
        const container = a.closest('li, article, section, div') ?? a.parentElement ?? a

        // Climb to the smallest ancestor that holds another matching anchor —
        // that is the matchup card, and where the status text lives.
        let card: Element = container
        for (let hops = 0; hops < 8; hops += 1) {
          const parent: Element | null = card.parentElement
          if (!parent) break
          const matching = Array.from(parent.querySelectorAll('a')).filter((other) =>
            re.test(other.getAttribute('href') ?? ''),
          )
          card = parent
          if (matching.length >= 2) break
        }

        return {
          href: a.getAttribute('href') ?? '',
          text: textOf(a),
          contextText: textOf(container).slice(0, 400),
          cardText: textOf(card).slice(0, 600),
          groupKey: pathOf(container),
        }
      })
  }, hrefPattern)
}

// --- Column addressing ------------------------------------------------------

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Find the index of a column by trying each alias against the table's headers.
 * Matches exactly first, then by prefix, so "Pts For" finds "Pts For (PF)".
 */
export function columnIndex(table: TableDump, aliases: string[]): number {
  const headers = table.headers.map(normalizeHeader)
  for (const alias of aliases) {
    const needle = normalizeHeader(alias)
    const exact = headers.indexOf(needle)
    if (exact !== -1) return exact
  }
  for (const alias of aliases) {
    const needle = normalizeHeader(alias)
    if (needle.length < 2) continue
    const partial = headers.findIndex((h) => h.startsWith(needle) || h.includes(needle))
    if (partial !== -1) return partial
  }
  return -1
}

/** Read a cell by header name. Returns undefined when the column is absent. */
export function cell(table: TableDump, row: Cell[], aliases: string[]): Cell | undefined {
  const idx = columnIndex(table, aliases)
  return idx === -1 ? undefined : row[idx]
}

export function cellText(table: TableDump, row: Cell[], aliases: string[]): string {
  return cell(table, row, aliases)?.text ?? ''
}

/**
 * Pick the table that best matches a set of expected headers. Returns the one
 * with the most matching columns, or undefined if none matches at all.
 */
export function pickTable(tables: TableDump[], expected: string[][]): TableDump | undefined {
  let best: { table: TableDump; hits: number } | undefined
  for (const table of tables) {
    if (table.rows.length === 0) continue
    const hits = expected.filter((aliases) => columnIndex(table, aliases) !== -1).length
    if (hits === 0) continue
    if (!best || hits > best.hits || (hits === best.hits && table.rows.length > best.table.rows.length)) {
      best = { table, hits }
    }
  }
  return best?.table
}

// --- Value parsing ----------------------------------------------------------

/** Parse a number out of messy cell text. Returns undefined when there isn't one. */
export function num(text: string | undefined): number | undefined {
  if (!text) return undefined
  const match = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!match) return undefined
  const value = Number.parseFloat(match[0])
  return Number.isFinite(value) ? value : undefined
}

export function numOr(text: string | undefined, fallback: number): number {
  return num(text) ?? fallback
}

/** Parse "10-3-1", "10-3" or "10 - 3 - 1" into a win/loss/tie record. */
export function parseRecord(text: string | undefined): { wins: number; losses: number; ties: number } {
  const parts = (text ?? '').match(/\d+/g)
  return {
    wins: Number(parts?.[0] ?? 0),
    losses: Number(parts?.[1] ?? 0),
    ties: Number(parts?.[2] ?? 0),
  }
}

/** Pull the team id out of a Yahoo team href: /f1/123456/7 -> "7". */
export function teamIdFromHref(href: string, leagueId: string): string | undefined {
  const match = href.match(new RegExp(`/f1/${leagueId}/(\\d+)(?:[/?#]|$)`))
  return match?.[1]
}

/** Pull a Yahoo player id out of a player href. */
export function playerIdFromHref(href: string): string | undefined {
  const match = href.match(/\/(?:nfl\/)?players\/(\d+)/) ?? href.match(/playerid=(\d+)/i)
  return match?.[1]
}
