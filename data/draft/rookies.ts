import fs from 'node:fs'
import { column, num, optionalColumn, parseCsv, str } from '../csv.js'
import { localPath } from '../fetch.js'
import { offenseColumns, offensePoints, type LeagueScoring } from './scoring.js'

/**
 * What a rookie is worth before he has played.
 *
 * A player with no NFL production was projected at a flat replacement level
 * for his position, which prices the third pick of the NFL draft exactly like
 * an undrafted receiver on a practice squad. Measured over eleven rookie
 * classes that is wrong by about ten points a game at the top: draft capital
 * is the league's own forecast of a player's role, and it is the only signal
 * available for someone with no snaps.
 *
 * The curve is measured here rather than assumed, from every skill-position
 * pick since 2015, scored in the league's own currency.
 *
 * Crucially it counts the ones who never played. Measuring only rookies who
 * got on the field says a seventh-round quarterback is worth thirteen points a
 * game, because the four who reached the field are the four who were good;
 * the thirty-three who did not are exactly the outcome a draft pick is risking.
 * Including them is the difference between what a rookie is worth if he hits
 * and what he is worth when you take him.
 */

const FIRST_SEASON = 2015
const SEASON_GAMES = 17
const POSITIONS = ['QB', 'RB', 'WR', 'TE']

/** Pick numbers the bands are centred on, chosen to match how the draft runs. */
const BANDS: Array<{ upTo: number; centre: number }> = [
  { upTo: 15, centre: 8 },
  { upTo: 32, centre: 24 },
  { upTo: 64, centre: 48 },
  { upTo: 105, centre: 85 },
  { upTo: 160, centre: 132 },
  { upTo: 300, centre: 220 },
]

export interface RookieCurve {
  /** Position to a rising list of (pick, points per game) knots. */
  points: Record<string, Array<{ pick: number; ppg: number }>>
  sampleSize: number
}

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

export function rookieKey(name: string, position: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[.'`-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((part) => !SUFFIXES.has(part))
    .join(' ')
  return `${cleaned}|${position}`
}

interface DraftedPlayer {
  season: number
  pick: number
  name: string
  position: string
}

function loadDraftPicks(): DraftedPlayer[] {
  const file = localPath('draft_picks.csv')
  if (!fs.existsSync(file)) return []
  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const c = {
    season: column(table, 'season'),
    pick: column(table, 'pick'),
    name: optionalColumn(table, 'pfr_player_name') ?? column(table, 'player_name'),
    position: column(table, 'position'),
  }

  const output: DraftedPlayer[] = []
  for (const row of table.rows) {
    const position = str(row, c.position)
    if (!POSITIONS.includes(position)) continue
    const season = num(row, c.season)
    const pick = num(row, c.pick)
    const name = str(row, c.name)
    if (season === undefined || pick === undefined || !name) continue
    output.push({ season, pick, name, position })
  }
  return output
}

/** Every player taken in one NFL draft, by name and position. */
export function loadDraftClass(season: number): Map<string, number> {
  const classOf = new Map<string, number>()
  for (const player of loadDraftPicks()) {
    if (player.season !== season) continue
    classOf.set(rookieKey(player.name, player.position), player.pick)
  }
  return classOf
}

/**
 * Rookie-year production by draft slot, measured from the combined history
 * file. Medians rather than means: a single Justin Jefferson should not lift
 * the expectation for everyone drafted near him.
 */
export function measureRookieCurve(scoring: LeagueScoring, through: number): RookieCurve {
  const file = localPath('player_stats.csv')
  const empty: RookieCurve = { points: {}, sampleSize: 0 }
  if (!fs.existsSync(file)) return empty

  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const c = {
    season: column(table, 'season'),
    name: optionalColumn(table, 'player_display_name') ?? column(table, 'player_name'),
    type: optionalColumn(table, 'season_type'),
    position: optionalColumn(table, 'position'),
  }
  const offense = offenseColumns(table)

  const totals = new Map<string, { games: number; points: number }>()
  for (const row of table.rows) {
    if (c.type !== null && str(row, c.type) !== 'REG') continue
    const season = num(row, c.season)
    const position = c.position === null ? '' : str(row, c.position)
    if (season === undefined || !POSITIONS.includes(position)) continue
    const key = `${season}|${rookieKey(str(row, c.name), position)}`
    const current = totals.get(key) ?? { games: 0, points: 0 }
    current.games += 1
    current.points += offensePoints(row, offense, scoring)
    totals.set(key, current)
  }

  const samples: Record<string, Array<{ pick: number; ppg: number }>> = {}
  let sampleSize = 0
  for (const player of loadDraftPicks()) {
    if (player.season < FIRST_SEASON || player.season > through) continue
    const hit = totals.get(`${player.season}|${rookieKey(player.name, player.position)}`)
    sampleSize++
    const list = samples[player.position] ?? []
    // Spread over a full season rather than games played, so a rookie who
    // never suited up enters the sample as the zero he was.
    list.push({ pick: player.pick, ppg: (hit?.points ?? 0) / SEASON_GAMES })
    samples[player.position] = list
  }

  const points: RookieCurve['points'] = {}
  for (const position of POSITIONS) {
    const rows = samples[position] ?? []
    if (rows.length === 0) continue
    const knots: Array<{ pick: number; ppg: number }> = []
    let ceiling = Number.POSITIVE_INFINITY
    let previousUpTo = 0
    for (const band of BANDS) {
      const inBand = rows.filter((row) => row.pick > previousUpTo && row.pick <= band.upTo)
      previousUpTo = band.upTo
      if (inBand.length < 5) continue
      const sorted = inBand.map((row) => row.ppg).sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0
      // Later picks cannot be worth more than earlier ones. Where the raw
      // medians invert it is sample noise, not a real signal.
      ceiling = Math.min(ceiling, median)
      knots.push({ pick: band.centre, ppg: ceiling })
    }
    if (knots.length > 0) points[position] = knots
  }

  return { points, sampleSize }
}

/** Linear interpolation between measured knots, flat outside them. */
export function rookieBaseline(
  curve: RookieCurve,
  position: string,
  pick: number,
): number | null {
  const knots = curve.points[position]
  if (!knots || knots.length === 0) return null

  const first = knots[0]
  const last = knots[knots.length - 1]
  if (!first || !last) return null
  if (pick <= first.pick) return first.ppg
  if (pick >= last.pick) return last.ppg

  for (let index = 1; index < knots.length; index++) {
    const low = knots[index - 1]
    const high = knots[index]
    if (!low || !high) continue
    if (pick <= high.pick) {
      const span = high.pick - low.pick
      const ratio = span === 0 ? 0 : (pick - low.pick) / span
      return low.ppg + ratio * (high.ppg - low.ppg)
    }
  }
  return last.ppg
}
