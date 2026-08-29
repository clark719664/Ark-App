import fs from 'node:fs'
import path from 'node:path'

/**
 * Downloads open NFL data from nflverse.
 *
 * nflverse publishes automated releases of play-by-play, weekly player stats,
 * injury reports, snap counts and roster data on GitHub. It is the canonical
 * open source for this, it is free to use, and it is what the research
 * community builds on.
 *
 * Coverage is 1999 onward. Weekly, player-level data before that is not openly
 * available — and it would be of limited use anyway: PPR scoring did not exist,
 * passing rates were far lower, and running back usage bears little relation to
 * the modern game. A model of 1978 football would predict 2026 fantasy badly.
 */

const RELEASE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download'

export const DATA_DIR = path.resolve(process.cwd(), '.cache', 'nfl')

export interface Dataset {
  name: string
  /** Path within the release, relative to the release base. */
  remote: string
  local: string
  description: string
}

/** The first season with weekly player data in nflverse. */
export const FIRST_SEASON = 1999

/** Datasets that come as one combined file. */
export const COMBINED_DATASETS: Dataset[] = [
  {
    name: 'player_stats',
    remote: 'player_stats/player_stats.csv',
    local: 'player_stats.csv',
    description: 'Weekly player stats including fantasy points, targets and share metrics',
  },
  {
    name: 'players',
    remote: 'players/players.csv',
    local: 'players.csv',
    description: 'Player biography, including birth date, draft position and college',
  },
  {
    name: 'draft_picks',
    remote: 'draft_picks/draft_picks.csv',
    local: 'draft_picks.csv',
    description: 'Every draft pick, for measuring what draft capital actually predicts',
  },
]

/**
 * Datasets published one file per season.
 *
 * nflverse renamed weekly stats partway through: the combined `player_stats`
 * asset stops at 2024, and anything newer lives under `stats_player`. Both are
 * pulled, because the combined file is the cheapest way to get the deep history
 * the analyses need and the seasonal one is the only way to get current data.
 */
export const SEASONAL_DATASETS = [
  { name: 'stats_player', pattern: 'stats_player/stats_player_week_%s.csv', from: 2022 },
  // Team weeks carry the defensive scoring the player file leaves blank, so
  // without this the draft board silently ships with no defences at all.
  { name: 'stats_team', pattern: 'stats_team/stats_team_week_%s.csv', from: 2022 },
  { name: 'injuries', pattern: 'injuries/injuries_%s.csv', from: 2009 },
  { name: 'snap_counts', pattern: 'snap_counts/snap_counts_%s.csv', from: 2012 },
  { name: 'rosters', pattern: 'rosters/roster_%s.csv', from: FIRST_SEASON },
] as const

export interface FetchOptions {
  /** Latest season to pull seasonal files for. */
  through?: number
  /** Re-download even when a local copy exists. */
  force?: boolean
  onProgress?: (message: string) => void
}

async function download(url: string, destination: string): Promise<number> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`)
  }
  const body = Buffer.from(await response.arrayBuffer())
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, body)
  return body.length
}

export async function fetchAll(opts: FetchOptions = {}): Promise<void> {
  const log = opts.onProgress ?? (() => {})
  // Rosters and depth charts are published for the upcoming season before it
  // starts, which is exactly what a draft needs.
  const through = (opts.through ?? currentSeason()) + 1

  fs.mkdirSync(DATA_DIR, { recursive: true })

  for (const dataset of COMBINED_DATASETS) {
    const destination = path.join(DATA_DIR, dataset.local)
    if (!opts.force && fs.existsSync(destination)) {
      log(`  ${dataset.name}: already downloaded`)
      continue
    }
    log(`  ${dataset.name}: downloading…`)
    const bytes = await download(`${RELEASE_BASE}/${dataset.remote}`, destination)
    log(`  ${dataset.name}: ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  }

  for (const dataset of SEASONAL_DATASETS) {
    let downloaded = 0
    let skipped = 0

    for (let season = dataset.from; season <= through; season += 1) {
      const remote = dataset.pattern.replace('%s', String(season))
      const destination = path.join(DATA_DIR, dataset.name, `${season}.csv`)

      if (!opts.force && fs.existsSync(destination)) {
        skipped += 1
        continue
      }
      try {
        await download(`${RELEASE_BASE}/${remote}`, destination)
        downloaded += 1
      } catch {
        // A season that does not exist yet is normal, not an error.
      }
    }
    log(`  ${dataset.name}: ${downloaded} downloaded, ${skipped} already present`)
  }
}

/** NFL seasons are named for the year they start in. */
export function currentSeason(now = new Date()): number {
  return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()
}

export function localPath(...parts: string[]): string {
  return path.join(DATA_DIR, ...parts)
}

export function isDownloaded(): boolean {
  return fs.existsSync(path.join(DATA_DIR, 'player_stats.csv'))
}
