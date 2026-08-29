import fs from 'node:fs'
import path from 'node:path'
import { currentSeason } from '../fetch.js'
import { buildProjections } from '../draft/project.js'

/**
 * Emit the draft pool the board uses.
 *
 * This is written to data/derived and committed, so the draft board works on a
 * fresh clone with no league sync and no downloaded dataset — which matters,
 * because a draft board is needed before a league exists.
 */

function main(): void {
  const season = Number.parseInt(process.argv[2] ?? '', 10) || currentSeason() + 1
  console.log(`\nBuilding the ${season} draft pool…\n`)

  const players = buildProjections({ season })
  if (players.length === 0) {
    console.error(
      `No roster data for ${season}. Run \`npm run data:fetch\` first — rosters for the ` +
        'coming season are published before it starts.\n',
    )
    process.exitCode = 1
    return
  }

  // Recorded from what this build actually did rather than what the model can
  // do. Depth charts are not always downloaded, and a pool describing an
  // adjustment it never applied is how two machines shipped different boards
  // while both claiming the same method.
  const usedDepthChart = players.some((player) => player.depthRank != null)

  const output = path.resolve(process.cwd(), 'data', 'derived', `draft-pool-${season}.json`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(
    output,
    `${JSON.stringify(
      {
        season,
        generatedAt: new Date().toISOString(),
        source: usedDepthChart
          ? 'nflverse-data rosters, weekly stats and depth charts'
          : 'nflverse-data rosters and weekly stats',
        usedDepthChart,
        method:
          'Weighted recent per-game production, regressed toward replacement by games of ' +
          'evidence, adjusted by measured within-player age curves' +
          (usedDepthChart
            ? ' and depth chart position. '
            : '. No depth chart data was available, so role is not adjusted for. ') +
          'Does not model target competition, scheme or coaching changes.',
        players,
      },
      null,
      0,
    )}\n`,
  )

  const size = (fs.statSync(output).size / 1024).toFixed(0)
  console.log(`  ${players.length} players`)
  console.log(`  ${output} (${size} KB)\n`)

  const counts = new Map<string, number>()
  for (const player of players) counts.set(player.position, (counts.get(player.position) ?? 0) + 1)
  console.log(`  ${[...counts].map(([k, v]) => `${k}:${v}`).join('  ')}\n`)

  console.log('  Top 10 by projected points:')
  for (const [index, player] of players.slice(0, 10).entries()) {
    console.log(
      `    ${String(index + 1).padStart(2)}. ${player.name.padEnd(22)}` +
        `${player.position.padEnd(4)}${player.team.padEnd(4)}${String(player.projectedSeason).padStart(6)}`,
    )
  }
  console.log('')
}

main()
