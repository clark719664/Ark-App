import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Checkpoint behaviour, exercised through the real files sync reads and writes.
 *
 * A sync walks dozens of pages at a polite pace, so losing the whole run to one
 * failure near the end is the difference between a minor retry and a five
 * minute one. These tests cover the rules that make resuming safe: progress is
 * only reused for the same league and season, and a completed sync leaves
 * nothing behind to resume from.
 */

let tempDir: string
let originalCacheDir: string | undefined
let originalLeague: string | undefined
let originalSeason: string | undefined

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-checkpoint-'))
  originalCacheDir = process.env['CACHE_DIR']
  originalLeague = process.env['YAHOO_LEAGUE_ID']
  originalSeason = process.env['YAHOO_SEASON']
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
  restore('CACHE_DIR', originalCacheDir)
  restore('YAHOO_LEAGUE_ID', originalLeague)
  restore('YAHOO_SEASON', originalSeason)
})

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/**
 * config is read once at import, so the checkpoint helpers are re-imported with
 * a fresh module registry per case rather than mutated in place.
 */
async function loadSync(leagueId: string, season: string) {
  process.env['CACHE_DIR'] = tempDir
  process.env['YAHOO_LEAGUE_ID'] = leagueId
  process.env['YAHOO_SEASON'] = season
  vi.resetModules()
  return import('./sync.js')
}

function writeProgressFile(progress: unknown): void {
  fs.writeFileSync(path.join(tempDir, 'sync-progress.json'), JSON.stringify(progress))
}

describe('sync checkpoints', () => {
  it('writes the snapshot where the API expects to read it', async () => {
    const { writeSnapshot, readSnapshot } = await loadSync('123', '2026')

    const snapshot = {
      league: {
        id: '123', provider: 'yahoo' as const, name: 'L', season: 2026, numTeams: 2,
        currentWeek: 1, regularSeasonWeeks: 14, playoffTeams: 6,
      },
      teams: [], matchups: [], rosters: {}, players: [], draft: [],
      fetchedAt: new Date().toISOString(), warnings: [],
    }
    writeSnapshot(snapshot)

    expect(fs.existsSync(path.join(tempDir, 'league.json'))).toBe(true)
    expect(readSnapshot()?.league.id).toBe('123')
  })

  it('returns null rather than throwing when no snapshot exists', async () => {
    const { readSnapshot, snapshotAgeSeconds } = await loadSync('123', '2026')
    expect(readSnapshot()).toBeNull()
    expect(snapshotAgeSeconds()).toBeNull()
  })

  it('survives a corrupt snapshot file instead of crashing the server', async () => {
    const { readSnapshot } = await loadSync('123', '2026')
    fs.writeFileSync(path.join(tempDir, 'league.json'), '{ not json')
    expect(readSnapshot()).toBeNull()
  })

  it('leaves progress from another league alone', async () => {
    // Resuming a different league's partial run would silently mix two leagues
    // into one snapshot.
    writeProgressFile({ leagueId: '999', season: 2026, startedAt: 'x', teams: [{ id: '1' }] })
    const { readSyncProgressForTests } = await loadSync('123', '2026')
    expect(readSyncProgressForTests()).toBeNull()
  })

  it('leaves progress from another season alone', async () => {
    writeProgressFile({ leagueId: '123', season: 2025, startedAt: 'x', teams: [{ id: '1' }] })
    const { readSyncProgressForTests } = await loadSync('123', '2026')
    expect(readSyncProgressForTests()).toBeNull()
  })

  it('resumes progress from the same league and season', async () => {
    writeProgressFile({
      leagueId: '123',
      season: 2026,
      startedAt: 'x',
      matchupsByWeek: { '1': [], '2': [] },
    })
    const { readSyncProgressForTests } = await loadSync('123', '2026')
    const progress = readSyncProgressForTests()
    expect(progress).not.toBeNull()
    expect(Object.keys(progress!.matchupsByWeek ?? {})).toEqual(['1', '2'])
  })

  it('treats a corrupt progress file as no progress', async () => {
    fs.writeFileSync(path.join(tempDir, 'sync-progress.json'), 'not json at all')
    const { readSyncProgressForTests } = await loadSync('123', '2026')
    expect(readSyncProgressForTests()).toBeNull()
  })
})
