import fs from 'node:fs'
import type { DraftPoolPlayer } from '../../server/draftPool.js'

/**
 * Replace a guess about rookies with Yahoo's own number.
 *
 * Draft capital is the only signal available to a projection built from box
 * scores, because a rookie has none. It is a blunt one: fitted to draft slot
 * alone, it says two receivers taken four picks apart are worth the same. Yahoo
 * projects them individually and knows one is buried behind two starters and
 * the other has the job, which is a different and better question answered.
 *
 * Only players with no NFL history are touched. Everyone else has production,
 * which is a stronger basis than anybody's preseason projection, and swapping
 * that out would throw away the part of this model that is actually measured.
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'`’-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((part) => !SUFFIXES.has(part))
    .join(' ')
}

interface SnapshotPlayer {
  name: string
  position: string
  points?: { projected?: number }
}

/** Yahoo's weekly projection by normalised name and position. */
export function loadYahooProjections(snapshotFile: string): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as {
      players?: SnapshotPlayer[]
    }
    for (const player of snapshot.players ?? []) {
      const projected = player.points?.projected
      if (projected === undefined || projected <= 0) continue
      out.set(`${normalize(player.name)}|${player.position}`, projected)
    }
  } catch {
    // No snapshot is normal before a league has been synced.
  }
  return out
}

export interface RookieOverride {
  name: string
  position: string
  from: number
  to: number
}

/**
 * Apply Yahoo's projection to players the pool has no history for.
 *
 * Returns what changed rather than only mutating, because a board that quietly
 * revalues three hundred players should be able to say which ones.
 */
export function applyRookieProjections(
  players: DraftPoolPlayer[],
  projections: Map<string, number>,
): RookieOverride[] {
  const changes: RookieOverride[] = []
  for (const player of players) {
    if (player.basis !== 'no-history') continue
    const projected = projections.get(`${normalize(player.name)}|${player.position}`)
    if (projected === undefined) continue
    if (Math.abs(projected - player.projectedPpg) < 0.05) continue

    changes.push({
      name: player.name,
      position: player.position,
      from: player.projectedPpg,
      to: projected,
    })
    player.projectedPpg = Number(projected.toFixed(2))
    player.projectedSeason = Number((projected * 17).toFixed(1))
    player.notes = [
      ...(player.notes ?? []).filter((note) => !note.startsWith('Rookie, no NFL snaps')),
      "Rookie: Yahoo's own projection, which prices the situation rather than the draft slot",
    ]
  }
  return changes
}
