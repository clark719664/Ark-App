import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { config } from '../config.js'
import { openSession } from '../yahoo/browser.js'
import { parseCsv, column, optionalColumn, num, str } from '../../data/csv.js'
import { offenseColumns, offensePoints, loadLeagueScoring } from '../../data/draft/scoring.js'
import { localPath } from '../../data/fetch.js'
import type { ManagerProfile } from '../../sim/managers.js'

/**
 * Measure how each manager in the league actually plays.
 *
 * Two numbers, both from what they did rather than what they say: how often
 * they work the wire, and how much of their roster they leave on the bench.
 * Written to data/derived so the simulation can play against the real league
 * instead of invented archetypes.
 */

const API = 'https://pub-api-rw.fantasysports.yahoo.com/fantasy/v2'
const OUT = path.resolve(process.cwd(), 'data/derived/league-managers.json')
const SKILL = ['QB', 'RB', 'WR', 'TE']
const WEEKS = 17

const normName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[.'`-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => !['jr', 'sr', 'ii', 'iii', 'iv'].includes(word))
    .join(' ')

function merge(entry: unknown): Record<string, unknown> {
  const parts = Array.isArray(entry) ? (entry as unknown[]).flat(3) : [entry]
  const out: Record<string, unknown> = {}
  for (const part of parts) {
    if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(out, part)
  }
  return out
}

function items(block: Record<string, unknown> | undefined, member: string): unknown[] {
  if (!block) return []
  const out: unknown[] = []
  for (let index = 0; index < Number(block['count'] ?? 0); index++) {
    const holder = block[String(index)] as Record<string, unknown> | undefined
    if (holder?.[member] !== undefined) out.push(holder[member])
  }
  return out
}

async function getJson(page: Page, url: string): Promise<Record<string, unknown> | null> {
  const raw = await page.evaluate(async (target: string) => {
    const response = await fetch(target, { credentials: 'include' })
    return response.ok ? await response.text() : ''
  }, url)
  if (!raw) return null
  return JSON.parse(raw) as Record<string, unknown>
}

function leagueBlock(payload: Record<string, unknown> | null, key: string) {
  const content = payload?.['fantasy_content'] as { league?: unknown[] } | undefined
  const node = (content?.league ?? []).find(
    (entry) => entry && (entry as Record<string, unknown>)[key] !== undefined,
  ) as Record<string, unknown> | undefined
  return node?.[key] as Record<string, unknown> | undefined
}

/** Actual weekly production for every player, in this league's scoring. */
function weeklyPoints(season: number): Map<string, number> {
  const file = localPath('stats_player', `${season}.csv`)
  const points = new Map<string, number>()
  if (!fs.existsSync(file)) return points
  const { scoring } = loadLeagueScoring()
  const table = parseCsv(fs.readFileSync(file, 'utf8'))
  const cName = optionalColumn(table, 'player_display_name') ?? column(table, 'player_name')
  const cWeek = column(table, 'week')
  const cType = optionalColumn(table, 'season_type')
  const offense = offenseColumns(table)
  for (const row of table.rows) {
    if (cType !== null && str(row, cType) !== 'REG') continue
    const key = `${num(row, cWeek)}|${normName(str(row, cName))}`
    points.set(key, (points.get(key) ?? 0) + offensePoints(row, offense, scoring))
  }
  return points
}

/** Best legal skill lineup, used as the bar a manager is measured against. */
function bestSkillLineup(players: Array<{ position: string; points: number }>): number {
  const ranked = [...players].sort((a, b) => b.points - a.points)
  const used = new Set<number>()
  let total = 0
  const take = (allowed: string[]) => {
    const index = ranked.findIndex((p, i) => !used.has(i) && allowed.includes(p.position))
    if (index >= 0) {
      used.add(index)
      total += ranked[index]?.points ?? 0
    }
  }
  take(['QB'])
  take(['RB'])
  take(['RB'])
  take(['WR'])
  take(['WR'])
  take(['TE'])
  take(['RB', 'WR', 'TE'])
  return total
}

async function main(): Promise<void> {
  const leagueKey = process.argv[2]
  const season = Number.parseInt(process.argv[3] ?? '', 10)
  if (!leagueKey || !Number.isFinite(season)) {
    console.error('\nUsage: npm run data:managers -- <league_key> <season>')
    console.error('  e.g. npm run data:managers -- 461.l.1311998 2025\n')
    process.exitCode = 1
    return
  }

  const session = await openSession({ headed: false })
  try {
    await session.page.goto(`https://football.fantasysports.yahoo.com/f1/${config.yahoo.leagueId}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.timeoutMs,
    })

    const teamsPayload = await getJson(session.page, `${API}/league/${leagueKey}/teams?format=json`)
    const names = new Map<string, string>()
    for (const entry of items(leagueBlock(teamsPayload, 'teams'), 'team')) {
      const flat = merge(entry)
      names.set(String(flat['team_key']), String(flat['name']))
    }
    console.log(`\n${names.size} teams in ${leagueKey}`)

    const adds = new Map<string, number>()
    const txPayload = await getJson(session.page, `${API}/league/${leagueKey}/transactions?format=json`)
    let transactions = 0
    for (const entry of items(leagueBlock(txPayload, 'transactions'), 'transaction')) {
      const flat = merge(entry)
      if (String(flat['status']) !== 'successful') continue
      transactions++
      for (const player of items(flat['players'] as Record<string, unknown>, 'player')) {
        const rows = merge(player)['transaction_data']
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          if (!row || typeof row !== 'object') continue
          const data = row as Record<string, unknown>
          const destination = String(data['destination_team_key'] ?? '')
          if (String(data['type']) === 'add' && destination.includes('.t.')) {
            adds.set(destination, (adds.get(destination) ?? 0) + 1)
          }
        }
      }
    }
    console.log(`${transactions} successful transactions`)

    const points = weeklyPoints(season)
    if (points.size === 0) {
      console.error(`\nNo ${season} weekly stats. Run npm run data:fetch first.\n`)
      process.exitCode = 1
      return
    }

    const profiles: ManagerProfile[] = []
    for (const [teamKey, name] of names) {
      let started = 0
      let ideal = 0
      for (let week = 1; week <= WEEKS; week++) {
        const payload = await getJson(
          session.page,
          `${API}/team/${teamKey}/roster;week=${week}?format=json`,
        )
        const teamNode = merge((payload?.['fantasy_content'] as { team?: unknown })?.team)
        const roster = teamNode['roster'] as Record<string, unknown> | undefined
        const holder = roster?.['0'] as Record<string, unknown> | undefined
        const list = (holder?.['players'] ?? roster?.['players']) as Record<string, unknown> | undefined

        const scored: Array<{ position: string; points: number; slot: string }> = []
        for (const entry of items(list, 'player')) {
          const flat = merge(entry)
          const selected = merge(flat['selected_position'])
          const player = String((flat['name'] as { full?: string } | undefined)?.full ?? '')
          const position = String(flat['display_position'] ?? '')
          if (!SKILL.includes(position)) continue
          scored.push({
            position,
            points: points.get(`${week}|${normName(player)}`) ?? 0,
            slot: String(selected['position'] ?? ''),
          })
        }
        if (scored.length === 0) continue
        started += scored
          .filter((p) => p.slot !== 'BN' && p.slot !== 'IR')
          .reduce((sum, p) => sum + p.points, 0)
        ideal += bestSkillLineup(scored)
      }

      const waste = Math.max(0, ideal - started)
      profiles.push({
        teamKey,
        name,
        addsPerWeek: (adds.get(teamKey) ?? 0) / WEEKS,
        benchWasteShare: started > 0 ? waste / started : 0,
      })
      process.stdout.write(`\r  measured ${profiles.length}/${names.size}   `)
    }

    profiles.sort((a, b) => a.benchWasteShare - b.benchWasteShare)
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(
      OUT,
      `${JSON.stringify({ leagueKey, season, generatedAt: new Date().toISOString(), profiles }, null, 2)}\n`,
    )

    console.log(`\r  wrote ${OUT}                 \n`)
    console.log('manager                        adds/wk   bench waste')
    for (const profile of profiles) {
      console.log(
        `  ${profile.name.slice(0, 28).padEnd(30)}${profile.addsPerWeek.toFixed(2).padStart(7)}${(profile.benchWasteShare * 100).toFixed(1).padStart(12)}%`,
      )
    }
    console.log('')
  } finally {
    await session.close()
  }
}

main().catch((err: unknown) => {
  console.error(`\nManager profiling failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
