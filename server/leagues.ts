import fs from 'node:fs'
import path from 'node:path'
import type { LeagueScoring } from '../data/draft/scoring.js'
import type { LeagueShape } from './draftPool.js'

/**
 * What Ark knows about each league it has been linked to.
 *
 * Everything here was once a single global: one scoring file, one board, one
 * seat in .env. That is fine until a second league exists, and then every one
 * of them is silently about the wrong league - a full-PPR board handed to a
 * half-PPR draft ranks confidently and wrongly, and a seat left over from
 * somewhere else miscounts every pick.
 *
 * So a league is linked once, everything about it is read from Yahoo at that
 * point, and its board is priced in its own currency. Linking a new league is
 * one command and needs no configuration at all.
 */

const ROOT = path.resolve(process.cwd(), 'data', 'derived', 'leagues')

export interface LinkedLeague {
  leagueId: string
  leagueKey: string
  name: string
  season: number
  linkedAt: string
  /** How this league pays, read from its own settings. */
  scoring: LeagueScoring
  /** A short label such as "half PPR, 0.1 a completion". */
  scoringLabel: string
  shape: LeagueShape
  rounds: number
  /** Draft slot in round one, zero when the order has not been published. */
  seat: number
  teamId: string
  teamName: string
  /** Board priced for this league, relative to the repo root. */
  poolFile: string
  /** Scoring rules the open data cannot express, kept so they are not silent. */
  unmapped: string[]
}

function file(leagueId: string): string {
  return path.join(ROOT, `${leagueId}.json`)
}

export function saveLeague(league: LinkedLeague): void {
  fs.mkdirSync(ROOT, { recursive: true })
  fs.writeFileSync(file(league.leagueId), `${JSON.stringify(league, null, 2)}\n`)
}

export function loadLeague(leagueId: string): LinkedLeague | null {
  try {
    return JSON.parse(fs.readFileSync(file(leagueId), 'utf8')) as LinkedLeague
  } catch {
    return null
  }
}

export function listLeagues(): LinkedLeague[] {
  if (!fs.existsSync(ROOT)) return []
  const out: LinkedLeague[] = []
  for (const name of fs.readdirSync(ROOT)) {
    // The directory also holds each league's board and scoring file. Reading
    // those as league records produced entries with no name at all, which took
    // the endpoint down rather than being ignored.
    if (!name.endsWith('.json')) continue
    if (name.startsWith('pool-') || name.startsWith('scoring-')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8')) as LinkedLeague
      if (parsed?.leagueId && parsed?.name) out.push(parsed)
    } catch {
      // A corrupt entry should not hide the rest of them.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Where a league's own board lives, priced in its own scoring. */
export function poolFileFor(leagueId: string, season: number): string {
  return path.join('data', 'derived', 'leagues', `pool-${season}-${leagueId}.json`)
}

/**
 * Whether two scorings differ in a way that changes a ranking. Used to say
 * plainly when a linked league needs its board rebuilt rather than leaving the
 * difference to be discovered on draft night.
 */
export function scoringDiffers(a: LeagueScoring, b: LeagueScoring): string[] {
  const differences: string[] = []
  const compare = (label: string, left: number, right: number) => {
    if (Math.abs(left - right) > 1e-9) differences.push(`${label} ${left} vs ${right}`)
  }
  compare('per reception', a.receptions, b.receptions)
  compare('per completion', a.completions, b.completions)
  compare('passing yards', a.passingYards, b.passingYards)
  compare('passing TD', a.passingTds, b.passingTds)
  compare('rushing yards', a.rushingYards, b.rushingYards)
  compare('receiving yards', a.receivingYards, b.receivingYards)
  compare('receiving TD', a.receivingTds, b.receivingTds)
  return differences
}
