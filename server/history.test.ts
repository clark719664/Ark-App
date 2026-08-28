import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeagueSnapshot } from '../shared/types.js'

/**
 * The archive exists so week-over-week movement reflects a real earlier sync
 * rather than a recomputation of today's roster. These cover the rules that
 * make that comparison meaningful: same league, same season, an earlier week,
 * and a directory that cannot grow forever.
 */

let tempDir: string
let original: string | undefined

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-history-'))
  original = process.env['CACHE_DIR']
  process.env['CACHE_DIR'] = tempDir
  vi.resetModules()
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (original === undefined) delete process.env['CACHE_DIR']
  else process.env['CACHE_DIR'] = original
})

function snapshot(week: number, fetchedAt: string, leagueId = 'L1', season = 2026): LeagueSnapshot {
  return {
    league: {
      id: leagueId, provider: 'yahoo', name: 'League', season,
      numTeams: 2, currentWeek: week, regularSeasonWeeks: 14, playoffTeams: 6,
    },
    teams: [], matchups: [], rosters: {}, players: [], draft: [],
    fetchedAt, warnings: [],
  }
}

describe('snapshot history', () => {
  it('finds the most recent sync from an earlier week', async () => {
    const { archiveSnapshot, previousWeekSnapshot } = await import('./history.js')

    archiveSnapshot(snapshot(8, '2026-10-01T12:00:00.000Z'))
    archiveSnapshot(snapshot(9, '2026-10-08T12:00:00.000Z'))

    const found = previousWeekSnapshot(snapshot(10, '2026-10-15T12:00:00.000Z'))
    expect(found?.league.currentWeek).toBe(9)
  })

  it('ignores an earlier sync of the same week', async () => {
    // Two syncs in one week differ by scrape noise, not by football.
    const { archiveSnapshot, previousWeekSnapshot } = await import('./history.js')

    archiveSnapshot(snapshot(10, '2026-10-15T09:00:00.000Z'))
    const found = previousWeekSnapshot(snapshot(10, '2026-10-15T18:00:00.000Z'))
    expect(found).toBeNull()
  })

  it('never crosses leagues or seasons', async () => {
    const { archiveSnapshot, previousWeekSnapshot } = await import('./history.js')

    archiveSnapshot(snapshot(5, '2026-09-01T12:00:00.000Z', 'OTHER', 2026))
    archiveSnapshot(snapshot(5, '2025-09-01T12:00:00.000Z', 'L1', 2025))

    expect(previousWeekSnapshot(snapshot(10, '2026-10-15T12:00:00.000Z'))).toBeNull()
  })

  it('returns null when nothing has been archived yet', async () => {
    const { previousWeekSnapshot } = await import('./history.js')
    expect(previousWeekSnapshot(snapshot(3, '2026-09-20T12:00:00.000Z'))).toBeNull()
  })

  it('prunes so the archive cannot grow without bound', async () => {
    const { archiveSnapshot, listHistory } = await import('./history.js')

    for (let i = 1; i <= 50; i += 1) {
      archiveSnapshot(snapshot(i, `2026-09-${String(i % 28 + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`))
    }
    expect(listHistory('L1', 2026).length).toBeLessThanOrEqual(40)
  })

  it('skips a corrupt archive rather than failing the lookup', async () => {
    const { archiveSnapshot, previousWeekSnapshot } = await import('./history.js')

    archiveSnapshot(snapshot(7, '2026-09-24T12:00:00.000Z'))
    fs.writeFileSync(path.join(tempDir, 'history', 'L1_2026_w09_corrupt.json'), '{ broken')

    const found = previousWeekSnapshot(snapshot(10, '2026-10-15T12:00:00.000Z'))
    expect(found?.league.currentWeek).toBe(7)
  })

  it('does not throw when the cache directory cannot be written', async () => {
    const { archiveSnapshot } = await import('./history.js')
    // A file where the history directory should go makes mkdir fail.
    fs.writeFileSync(path.join(tempDir, 'history'), 'not a directory')
    expect(() => archiveSnapshot(snapshot(4, '2026-09-15T12:00:00.000Z'))).not.toThrow()
  })
})
