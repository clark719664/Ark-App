import path from 'node:path'
import fs from 'node:fs'

// Node can load .env natively; no dependency needed. Missing file is fine.
try {
  const envPath = path.resolve(process.cwd(), '.env')
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath)
} catch {
  // A malformed .env shouldn't take the process down — fall back to real env.
}

function str(key: string, fallback = ''): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

function int(key: string, fallback: number): number {
  const v = Number.parseInt(str(key), 10)
  return Number.isFinite(v) ? v : fallback
}

function bool(key: string, fallback: boolean): boolean {
  const v = str(key).toLowerCase()
  if (v === '') return fallback
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * The NFL season a given date belongs to. Seasons are named for the year they
 * start in, and run into January/February, so anything before ~March belongs
 * to the previous season.
 */
export function currentNflSeason(now = new Date()): number {
  const year = now.getUTCFullYear()
  return now.getUTCMonth() < 2 ? year - 1 : year
}

const cacheDir = path.resolve(process.cwd(), str('CACHE_DIR', '.cache'))

export const config = {
  provider: str('FF_PROVIDER', 'demo') as 'yahoo' | 'demo',
  port: int('PORT', 8787),
  isProduction: process.env.NODE_ENV === 'production',

  yahoo: {
    leagueId: str('YAHOO_LEAGUE_ID'),
    season: int('YAHOO_SEASON', currentNflSeason()),
    teamId: str('YAHOO_TEAM_ID'),
  },

  browser: {
    channel: str('BROWSER_CHANNEL', 'chrome'),
    executablePath: str('BROWSER_PATH'),
    profileDir: path.resolve(process.cwd(), str('BROWSER_PROFILE_DIR', '.browser-profile')),
    headed: bool('BROWSER_HEADED', false),
    delayMs: int('SCRAPE_DELAY_MS', 1200),
    timeoutMs: int('SCRAPE_TIMEOUT_MS', 45_000),
  },

  cache: {
    dir: cacheDir,
    snapshotFile: path.join(cacheDir, 'league.json'),
    rawDir: path.join(cacheDir, 'raw'),
    netDir: path.join(cacheDir, 'net'),
    ttlSeconds: int('CACHE_TTL_SECONDS', 900),
  },
} as const

export type Config = typeof config
