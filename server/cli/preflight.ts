import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { openSession } from '../yahoo/browser.js'
import { fetchDraftPicks, fetchDraftStatus, fetchTeams, loadPlayerIndex } from '../yahoo/draftFeed.js'
import { loadDraftPool, rankPool, DEFAULT_SHAPE } from '../draftPool.js'
import { matchPlayers, shapeFromEnv, snakePicks } from '../draftWatch.js'
import { loadLeagueScoring } from '../../data/draft/scoring.js'

/**
 * Everything that has to be true before a draft, checked in one go.
 *
 * A draft is a bad time to discover a lapsed session or a board that never
 * loaded, so this touches every part of the path the draft depends on and says
 * plainly which ones are ready.
 */

let failures = 0
let warnings = 0

function ok(label: string, detail = ''): void {
  console.log(`  [ ok ] ${label}${detail ? ` - ${detail}` : ''}`)
}
function warn(label: string, detail: string): void {
  warnings++
  console.log(`  [warn] ${label} - ${detail}`)
}
function fail(label: string, detail: string): void {
  failures++
  console.log(`  [FAIL] ${label} - ${detail}`)
}

function addresses(): string[] {
  const found: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
    }
  }
  return found
}

async function main(): Promise<void> {
  console.log('\nArk draft preflight\n')

  console.log('Configuration')
  if (!config.yahoo.leagueId) fail('league id', 'YAHOO_LEAGUE_ID is not set in .env')
  else ok('league id', config.yahoo.leagueId)
  if (!config.yahoo.teamId) warn('team id', 'YAHOO_TEAM_ID unset, your roster will not be tracked')
  else ok('team id', config.yahoo.teamId)

  const seat = Number.parseInt(process.env['DRAFT_POSITION'] ?? '', 10) || 0
  const teams = Number.parseInt(process.env['LEAGUE_TEAMS'] ?? '', 10) || DEFAULT_SHAPE.teams
  const rounds = Number.parseInt(process.env['DRAFT_ROUNDS'] ?? '', 10) || 15
  if (seat === 0) warn('draft seat', 'DRAFT_POSITION unset, picks cannot be counted down')
  else ok('draft seat', `${seat} of ${teams}, picks ${snakePicks(teams, seat, rounds).join(', ')}`)

  console.log('\nBoard')
  const scoring = loadLeagueScoring()
  if (scoring.source.includes('PPR') && !fs.existsSync('data/derived/league-scoring.json')) {
    warn('scoring', 'no league scoring exported, board is priced in full PPR')
  } else {
    ok('scoring', `${scoring.source}, ${scoring.scoring.receptions} a reception`)
  }

  const shape = shapeFromEnv()
  const pool = loadDraftPool()
  if (!pool) {
    fail('draft pool', 'missing, run: npm run data:draft 2026')
  } else {
    const board = rankPool(pool, shape)
    ok('draft pool', `${pool.players.length} players, ${board.length} ranked for this league`)
    const top = board[0]
    if (top) ok('top of the board', `${top.name} (${top.position}, value ${top.vorp.toFixed(1)})`)
    const rookies = pool.players.filter((p) => p.basis === 'no-history')
    const distinct = new Set(rookies.map((p) => p.projectedPpg)).size
    if (distinct < 5) warn('rookies', 'all priced the same, draft capital was not applied')
    else ok('rookies', `${rookies.length} priced across ${distinct} values`)

    // A pool built from thin stats still produces a full board, just a wrong
    // one, so check the shape of it rather than only that it loaded.
    const established = pool.players.filter(
      (p) => p.basis === 'production' && p.gamesOfData >= 24 && (p.lastSeasonPpg ?? 0) > 8,
    )
    const collapsed = established.filter((p) => p.projectedPpg < 0.5 * (p.lastSeasonPpg ?? 0))
    if (collapsed.length > 0) {
      fail(
        'projections',
        `${collapsed.length} established players projected under half their last season ` +
          `(e.g. ${collapsed[0]?.name} ${collapsed[0]?.lastSeasonPpg} -> ${collapsed[0]?.projectedPpg}). ` +
          'Rebuild with: npm run data:fetch && npm run data:draft 2026',
      )
    } else {
      ok('projections', `${established.length} established players, none collapsed`)
    }

    // The projection model says it adjusts for depth chart position, but the
    // fetch step does not download depth charts, so on a normal clone it never
    // does. Say which of the two happened rather than leaving it implied.
    const charted = pool.players.filter((p) => p.depthRank != null).length
    if (charted === 0) {
      warn('depth chart', 'not applied — no depth chart data, projections use production and age only')
    } else {
      ok('depth chart', `${charted} players carry a depth rank`)
    }

    const withBye = pool.players.filter((p) => p.byeWeek != null).length
    if (withBye === 0) {
      warn('bye weeks', 'none in the pool, run: npm run data:fetch && npm run data:draft 2026')
    } else if (withBye < pool.players.length) {
      warn('bye weeks', `${pool.players.length - withBye} players have no bye`)
    } else {
      const weeks = [...new Set(pool.players.map((p) => p.byeWeek))].sort(
        (a, b) => (a ?? 0) - (b ?? 0),
      )
      ok('bye weeks', `every player, across weeks ${weeks[0]}-${weeks[weeks.length - 1]}`)
    }
  }

  console.log('\nYahoo')
  let session
  try {
    session = await openSession({ headed: false })
  } catch (err) {
    // Playwright allows one process per persistent profile, so a locked profile
    // usually means the watcher already has it - which is the state you want on
    // draft day, not a failure. Verify through what it has written instead.
    const live = await liveSnapshot()
    if (live && !live.stale) {
      ok('session', `profile in use by a running watcher, last report ${live.ageSeconds}s ago`)
      ok('draft feed', `reachable, ${live.totalPicks} picks so far`)
      ok('draft status', live.draftStatus)
      if (live.myTeamName) ok('your team', live.myTeamName)
    } else if (live) {
      fail('watcher', `holding the browser profile but last reported ${live.ageSeconds}s ago`)
    } else {
      const message = err instanceof Error ? err.message : String(err)
      fail('browser profile', message.split(/\r?\n/)[0] ?? message)
    }
    await servingChecks()
    summarise()
    return
  }

  try {
    await session.page.goto(`https://football.fantasysports.yahoo.com/f1/${config.yahoo.leagueId}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.timeoutMs,
    })
    const url = session.page.url()
    if (/login\.yahoo\.com/i.test(url)) {
      fail('session', 'signed out, run: npm run yahoo:login')
    } else {
      ok('session', 'still signed in')
      const leagueKey = `nfl.l.${config.yahoo.leagueId}`

      const status = await fetchDraftStatus(session.page, leagueKey)
      ok('draft status', status)

      const teamList = await fetchTeams(session.page, leagueKey)
      const mine = teamList.find((t) => t.teamKey.endsWith(`.t.${config.yahoo.teamId}`))
      if (!mine) warn('your team', 'not found, check YAHOO_TEAM_ID')
      else ok('your team', mine.name)

      const picks = await fetchDraftPicks(session.page, leagueKey)
      ok('draft feed', `reachable, ${picks.length} picks so far`)

      const index = await loadPlayerIndex(session.page, leagueKey)
      if (index.size < 500) warn('player index', `only ${index.size} players, expected over a thousand`)
      else ok('player index', `${index.size} players cached`)

      if (pool) {
        const board = rankPool(pool, shape)
        const { byPlayerKey } = matchPlayers([...index.values()], board)
        const missing = board.slice(0, 200).filter(
          (p) => ![...byPlayerKey.values()].some((m) => m.playerId === p.playerId),
        )
        if (missing.length > 0) {
          warn('matching', `${missing.length} of the top 200 have no Yahoo entry`)
        } else {
          ok('matching', `${byPlayerKey.size} players matched, none of the top 200 missing`)
        }
      }
    }
  } catch (err) {
    fail('Yahoo API', err instanceof Error ? err.message : String(err))
  } finally {
    await session.close()
  }

  await servingChecks()
  summarise()
}

interface LiveState {
  ageSeconds: number
  stale: boolean
  totalPicks: number
  draftStatus: string
  myTeamName: string
}

async function liveSnapshot(): Promise<LiveState | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/draft-live`)
    if (!response.ok) return null
    return (await response.json()) as LiveState
  } catch {
    return null
  }
}

async function servingChecks(): Promise<void> {
  console.log('\nServing')
  const port = config.port
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/draft-live`)
    if (response.ok) {
      const state = (await response.json()) as { ageSeconds: number; stale: boolean }
      if (state.stale) warn('live snapshot', `${state.ageSeconds}s old, the watcher may have stopped`)
      else ok('live snapshot', `${state.ageSeconds}s old`)
    } else if (response.status === 503) {
      warn('live snapshot', 'none yet, start it with: npm run draft:watch')
    } else {
      warn('live snapshot', `server answered ${response.status}`)
    }
    ok('server', `listening on ${port}`)
    for (const address of addresses()) console.log(`         http://${address}:${port}/live`)
  } catch {
    warn('server', `not running, start it with: npm run draft:serve`)
  }

  const dist = path.resolve(process.cwd(), 'dist', 'index.html')
  if (!fs.existsSync(dist)) fail('built client', 'missing, run: npm run build')
  else ok('built client', 'present')
}

function summarise(): void {
  console.log('')
  if (failures === 0 && warnings === 0) console.log('Ready. Nothing to fix.\n')
  else if (failures === 0) console.log(`Ready, with ${warnings} thing(s) worth a look.\n`)
  else console.log(`${failures} blocking problem(s), ${warnings} warning(s).\n`)
  if (failures > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error(`\nPreflight failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
