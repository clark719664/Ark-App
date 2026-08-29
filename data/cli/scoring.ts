import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../server/config.js'
import { openSession } from '../../server/yahoo/browser.js'
import { PPR_SCORING, type LeagueScoring } from '../draft/scoring.js'

/**
 * Export a league's own scoring rules so the draft board can price players in
 * the currency the league actually pays out.
 *
 * Yahoo's own frontend reads this from a JSON API rather than the HTML, so
 * this does too: it is the same data the site renders from, already parsed.
 */

const OUT = path.resolve(process.cwd(), 'data/derived/league-scoring.json')

/** Yahoo stat ids are stable; position type disambiguates the reused ones. */
const OFFENSE: Record<number, keyof LeagueScoring> = {
  2: 'completions',
  4: 'passingYards',
  5: 'passingTds',
  6: 'interceptions',
  9: 'rushingYards',
  10: 'rushingTds',
  11: 'receptions',
  12: 'receivingYards',
  13: 'receivingTds',
  15: 'returnTds',
  16: 'twoPointConversions',
  18: 'fumblesLost',
}

const KICKING: Record<number, keyof LeagueScoring['fieldGoals'] | 'patMade'> = {
  19: 'b0',
  20: 'b20',
  21: 'b30',
  22: 'b40',
  23: 'b50',
  29: 'patMade',
}

interface Stat {
  stat_id: number | string
  name?: string
  position_type?: string
  value?: number | string
}

function statList(node: unknown): Stat[] {
  const wrapper = node as { stats?: Array<{ stat?: Stat } | Stat> } | undefined
  if (!wrapper?.stats) return []
  return wrapper.stats.map((entry) => ('stat' in entry ? (entry.stat as Stat) : (entry as Stat)))
}

async function main(): Promise<void> {
  const leagueId = config.yahoo.leagueId
  if (!leagueId) {
    console.error('\nYAHOO_LEAGUE_ID is not set. See .env.example.\n')
    process.exitCode = 1
    return
  }

  const session = await openSession({ headed: false })
  let raw: string
  try {
    await session.page.goto(`https://football.fantasysports.yahoo.com/f1/${leagueId}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.timeoutMs,
    })
    raw = await session.page.evaluate(async (id: string) => {
      const url = `https://pub-api-rw.fantasysports.yahoo.com/fantasy/v2/league/nfl.l.${id}/settings?format=json`
      const response = await fetch(url, { credentials: 'include' })
      if (!response.ok) throw new Error(`settings returned ${response.status}`)
      return await response.text()
    }, leagueId)
  } finally {
    await session.close()
  }

  const parsed = JSON.parse(raw) as { fantasy_content: { league: unknown[] } }
  const league = parsed.fantasy_content.league
  const meta = league.find((node) => (node as { name?: string })?.name) as
    | { name?: string; league_key?: string; season?: string }
    | undefined
  const settingsNode = league.find((node) => (node as { settings?: unknown })?.settings) as
    | { settings: unknown }
    | undefined
  if (!settingsNode) throw new Error('No settings block in the Yahoo response')
  const settings = (Array.isArray(settingsNode.settings)
    ? settingsNode.settings[0]
    : settingsNode.settings) as Record<string, unknown>

  const categories = new Map<number, Stat>()
  for (const stat of statList(settings['stat_categories'])) {
    categories.set(Number(stat.stat_id), stat)
  }

  const scoring: LeagueScoring = structuredClone(PPR_SCORING)
  // Nothing is paid for unless the league says so, otherwise a rule the league
  // has turned off keeps its full-PPR default and silently inflates the board.
  scoring.completions = 0
  scoring.receptions = 0

  const unmapped: string[] = []
  for (const stat of statList(settings['stat_modifiers'])) {
    const id = Number(stat.stat_id)
    const value = Number(stat.value)
    if (!Number.isFinite(value)) continue
    const type = categories.get(id)?.position_type ?? ''

    if (type === 'O' && OFFENSE[id]) {
      const key = OFFENSE[id] as Exclude<keyof LeagueScoring, 'fieldGoals'>
      ;(scoring[key] as number) = value
    } else if (type === 'K' && KICKING[id]) {
      const key = KICKING[id]
      if (key === 'patMade') scoring.patMade = value
      else scoring.fieldGoals[key] = value
    } else if (value !== 0 && type !== 'DT') {
      unmapped.push(`${id} ${categories.get(id)?.name ?? '?'} = ${value}`)
    }
  }

  // Yahoo has no 50-59/60+ split; the 50+ rate covers both.
  scoring.fieldGoals.b60 = scoring.fieldGoals.b50

  const payload = {
    leagueKey: meta?.league_key ?? `nfl.l.${leagueId}`,
    leagueName: meta?.name ?? leagueId,
    season: meta?.season ?? String(config.yahoo.season),
    generatedAt: new Date().toISOString(),
    source: 'Yahoo league settings (pub-api fantasy/v2)',
    scoring,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)

  console.log(`\nWrote ${OUT}`)
  console.log(`  League      ${payload.leagueName} (${payload.season})`)
  console.log(`  Receptions  ${scoring.receptions}  (1 = full PPR, 0.5 = half)`)
  console.log(`  Completions ${scoring.completions}`)
  console.log(`  Pass yd/TD  ${scoring.passingYards} / ${scoring.passingTds}`)
  console.log(`  Rush yd/TD  ${scoring.rushingYards} / ${scoring.rushingTds}`)
  console.log(`  Rec yd/TD   ${scoring.receivingYards} / ${scoring.receivingTds}`)
  if (unmapped.length > 0) {
    console.log('\nScoring rules with no equivalent in the open data (ignored):')
    for (const entry of unmapped) console.log(`  ${entry}`)
  }
  console.log('\nNext: npm run data:draft\n')
}

main().catch((err: unknown) => {
  console.error(`\nScoring export failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
