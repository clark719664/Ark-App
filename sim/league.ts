import fs from 'node:fs'
import path from 'node:path'
import type { Agent } from './agents.js'
import { LeagueRival, fitNoise, type ManagerProfile } from './managers.js'
import { runSeason } from './season.js'

/**
 * Play this league, not a generic one.
 *
 * Nine rivals fitted to the people actually in it, and the tenth seat played
 * twice: once by the manager as measured, once by Ark. The difference between
 * those two runs is what the tool is worth to this person in this league.
 */

const PROFILES = path.resolve(process.cwd(), 'data/derived/league-managers.json')

export interface LeagueRun {
  seasons: number
  rows: Array<{
    name: string
    titles: number
    playoffs: number
    wins: number
    pointsFor: number
    benchShare: number
  }>
}

export function loadProfiles(): { season: number; profiles: ManagerProfile[] } {
  if (!fs.existsSync(PROFILES)) {
    throw new Error('No manager profiles. Run: npm run data:managers -- <league_key> <season>')
  }
  return JSON.parse(fs.readFileSync(PROFILES, 'utf8')) as {
    season: number
    profiles: ManagerProfile[]
  }
}

/** One pass over N seasons, rotating seats so nobody keeps a soft schedule. */
export function playLeague(agents: Agent[], seasons: number, baseSeed: number, playoffTeams: number): LeagueRun {
  const totals = new Map<
    string,
    { titles: number; playoffs: number; wins: number; pointsFor: number; bench: number; n: number }
  >()

  for (let season = 0; season < seasons; season++) {
    const rotated = agents.map((_, index) => agents[(index + season) % agents.length] as Agent)
    const results = runSeason({
      seed: baseSeed + season,
      agents: rotated,
      teams: agents.length,
      playoffTeams,
    })
    for (const result of results) {
      const row = totals.get(result.agentName) ?? {
        titles: 0, playoffs: 0, wins: 0, pointsFor: 0, bench: 0, n: 0,
      }
      row.titles += result.wonTitle ? 1 : 0
      row.playoffs += result.madePlayoffs ? 1 : 0
      row.wins += result.wins
      row.pointsFor += result.pointsFor
      row.bench += result.pointsFor > 0 ? result.pointsLeftOnBench / result.pointsFor : 0
      row.n += 1
      totals.set(result.agentName, row)
    }
  }

  return {
    seasons,
    rows: [...totals.entries()]
      .map(([name, row]) => ({
        name,
        titles: row.titles / row.n,
        playoffs: row.playoffs / row.n,
        wins: row.wins / row.n,
        pointsFor: row.pointsFor / row.n,
        benchShare: row.bench / row.n,
      }))
      .sort((a, b) => b.titles - a.titles),
  }
}

/** Fit every rival's lineup noise so simulated bench waste matches measured. */
export function calibrate(profiles: ManagerProfile[], playoffTeams: number): ManagerProfile[] {
  return fitNoise(profiles, (current) => {
    const agents = current.map((profile) => new LeagueRival(profile))
    const run = playLeague(agents, 30, 9000, playoffTeams)
    const observed = new Map<string, number>()
    for (const row of run.rows) observed.set(row.name, row.benchShare)
    return observed
  })
}
