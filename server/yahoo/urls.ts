import { YAHOO_FF_HOST } from './browser.js'

/**
 * Yahoo Fantasy Football URL patterns.
 *
 * Yahoo has moved these around over the years and query-parameter names differ
 * between sections, so anything uncertain is expressed as a list of candidates
 * that the scraper tries in order. `npm run yahoo:capture` records which ones
 * actually resolved, so the guesswork gets replaced by fact on first run.
 */

export interface LeagueRef {
  leagueId: string
  teamId?: string
}

const base = (leagueId: string) => `${YAHOO_FF_HOST}/f1/${leagueId}`

export const yahooUrls = {
  home: (l: string) => base(l),
  standings: (l: string) => `${base(l)}/standings`,
  settings: (l: string) => `${base(l)}/settings`,
  draftResults: (l: string) => `${base(l)}/draftresults`,
  transactions: (l: string) => `${base(l)}/transactions`,

  /** Team page. Optionally pinned to a specific week's lineup. */
  team: (l: string, teamId: string, week?: number) =>
    week ? `${base(l)}/${teamId}?week=${week}` : `${base(l)}/${teamId}`,

  /**
   * Scoreboard for a week. Yahoo has used both `matchup_week` and `week`
   * depending on the season, so callers should try these in order.
   */
  scoreboardCandidates: (l: string, week: number) => [
    `${base(l)}/scoreboard?matchup_week=${week}`,
    `${base(l)}/scoreboard?week=${week}`,
    `${base(l)}?matchup_week=${week}`,
  ],

  /**
   * Player search. Defaults to all available players at offensive positions,
   * sorted by season points.
   *   status: A=available, ALL=all, FA=free agents, W=waivers, T=taken
   *   pos:    O=offense, QB, RB, WR, TE, K, DEF
   *   stat1:  S_S=season stats, S_PS=projected season
   *   count:  pagination offset, 25 per page
   */
  players: (
    l: string,
    opts: { status?: string; pos?: string; sort?: string; count?: number; stat1?: string } = {},
  ) => {
    const q = new URLSearchParams({
      status: opts.status ?? 'A',
      pos: opts.pos ?? 'O',
      cut_type: '9',
      stat1: opts.stat1 ?? 'S_S',
      myteam: '0',
      sort: opts.sort ?? 'PTS',
      sdir: '1',
      count: String(opts.count ?? 0),
    })
    return `${base(l)}/players?${q.toString()}`
  },
} as const

/** Extract a Yahoo league id from a pasted league URL, or return the input. */
export function parseLeagueId(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/f1\/(\d+)/)
  if (match?.[1]) return match[1]
  const digits = trimmed.match(/^\d+$/)
  if (digits) return trimmed
  throw new Error(
    `Couldn't read a league id from "${input}". ` +
      `Use the number from your league URL, e.g. https://football.fantasysports.yahoo.com/f1/123456 -> 123456`,
  )
}
