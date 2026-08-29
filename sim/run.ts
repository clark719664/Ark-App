import { buildAgents, type Agent } from './agents.js'
import { runSeason, type TeamResult } from './season.js'

/**
 * Run many seasons and see which manager wins.
 *
 * Seat assignment rotates every season so no strategy keeps a favourable draft
 * slot, and each season draws a fresh player pool. What is left is the effect of
 * the decisions themselves.
 */

export interface StrategyRecord {
  name: string
  description: string
  seasons: number
  titles: number
  playoffs: number
  wins: number
  losses: number
  pointsFor: number
  pointsLeftOnBench: number
  endingTalent: number
  draftedTalent: number
}

export interface SimulationSummary {
  seasons: number
  strategies: StrategyRecord[]
}

export function runSimulation(seasons: number, baseSeed = 1): SimulationSummary {
  const records = new Map<string, StrategyRecord>()
  const template = buildAgents()

  for (const agent of template) {
    if (records.has(agent.name)) continue
    records.set(agent.name, {
      name: agent.name,
      description: agent.description,
      seasons: 0,
      titles: 0,
      playoffs: 0,
      wins: 0,
      losses: 0,
      pointsFor: 0,
      pointsLeftOnBench: 0,
      endingTalent: 0,
      draftedTalent: 0,
    })
  }

  for (let season = 0; season < seasons; season += 1) {
    // Fresh agent instances each season: some hold state across weeks.
    const agents = buildAgents()
    // Rotate seats so draft order cannot favour one strategy over the run.
    const rotated = rotate(agents, season)

    const results = runSeason({ seed: baseSeed + season * 7919, agents: rotated })
    for (const result of results) accumulate(records, result)
  }

  return {
    seasons,
    strategies: [...records.values()].sort(
      (a, b) => b.titles / b.seasons - a.titles / a.seasons,
    ),
  }
}

function rotate<T>(items: T[], by: number): T[] {
  const offset = ((by % items.length) + items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function accumulate(records: Map<string, StrategyRecord>, result: TeamResult): void {
  const record = records.get(result.agentName)
  if (!record) return

  record.seasons += 1
  record.titles += result.wonTitle ? 1 : 0
  record.playoffs += result.madePlayoffs ? 1 : 0
  record.wins += result.wins
  record.losses += result.losses
  record.pointsFor += result.pointsFor
  record.pointsLeftOnBench += result.pointsLeftOnBench
  record.endingTalent += result.endingTalent
  record.draftedTalent += result.draftedTalent
}

export function formatSummary(summary: SimulationSummary): string {
  const lines: string[] = []
  const pct = (value: number, of: number) => (of === 0 ? '—' : `${((value / of) * 100).toFixed(1)}%`)

  lines.push('')
  lines.push(`  ${summary.seasons} seasons, 12 teams each`)
  lines.push('')
  // Eight values print per row, so the header names eight columns. It named
  // five, which left the talent columns — the ones that catch a roster
  // quietly decaying — sitting under no heading at all.
  lines.push(
    `  ${'Strategy'.padEnd(14)}${'Titles'.padStart(8)}${'Playoffs'.padStart(10)}` +
      `${'Wins'.padStart(7)}${'Points'.padStart(9)}${'Bench'.padStart(13)}` +
      `${'Drafted'.padStart(10)}${'Ending'.padStart(9)}${'Drift'.padStart(10)}`,
  )
  lines.push(`  ${'─'.repeat(90)}`)

  for (const strategy of summary.strategies) {
    const seasons = strategy.seasons
    lines.push(
      `  ${strategy.name.padEnd(14)}` +
        `${pct(strategy.titles, seasons).padStart(8)}` +
        `${pct(strategy.playoffs, seasons).padStart(10)}` +
        `${(strategy.wins / seasons).toFixed(2).padStart(7)}` +
        `${(strategy.pointsFor / seasons).toFixed(0).padStart(9)}` +
        `${(strategy.pointsLeftOnBench / seasons).toFixed(0).padStart(13)}` +
        `${(strategy.draftedTalent / seasons).toFixed(1).padStart(10)}` +
        `${(strategy.endingTalent / seasons).toFixed(1).padStart(9)}` +
        `${(((strategy.endingTalent - strategy.draftedTalent) / seasons) >= 0 ? '+' : '') + ((strategy.endingTalent - strategy.draftedTalent) / seasons).toFixed(1)}`.padStart(10),
    )
  }

  lines.push('')
  lines.push('  Each strategy fields a different number of teams, so compare rates, not totals.')
  lines.push('  Wins, points, bench and talent are all per season.')
  lines.push('  "Bench" is points that were sitting on the bench in a lineup the manager')
  lines.push('  could legally have started. "Drafted" and "Ending" are the hidden true')
  lines.push('  weekly value of the ten best players on the roster — invisible to agents —')
  lines.push('  and "Drift" is what a season of roster moves did to it.')
  lines.push('')

  return lines.join('\n')
}

function main(): void {
  const seasons = Number.parseInt(process.argv[2] ?? '', 10) || 200
  console.log(`\nSimulating ${seasons} seasons…`)

  const started = Date.now()
  const summary = runSimulation(seasons)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  console.log(formatSummary(summary))
  console.log(`  Completed in ${elapsed}s`)

  for (const strategy of summary.strategies) {
    console.log(`\n  ${strategy.name}`)
    console.log(`    ${strategy.description}`)
  }
  console.log('')
}

const invokedDirectly = process.argv[1]?.endsWith('run.ts') ?? false
if (invokedDirectly) main()

export type { Agent }
