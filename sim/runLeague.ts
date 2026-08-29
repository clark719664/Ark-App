import { ArkAgent, type Agent } from './agents.js'
import { LeagueRival } from './managers.js'
import { calibrate, loadProfiles, playLeague } from './league.js'

/**
 * How often does this manager win, playing these nine people?
 *
 * Answered twice: once with the tenth seat played the way the log says he
 * played last season, once with it playing Ark. Everything else is held
 * identical - same rivals, same seeds, same seat rotation - so the gap between
 * the two runs is the tool and nothing else.
 */

const SEASONS = Number.parseInt(process.argv[2] ?? '', 10) || 2000
const PLAYOFF_TEAMS = 4
const ME = process.env['MY_TEAM_NAME'] ?? "Ja'Marr You Not Entertained?"

function main(): void {
  const { season, profiles } = loadProfiles()
  const mine = profiles.find((p) => p.name === ME)
  const rivals = profiles.filter((p) => p.name !== ME)
  if (!mine) {
    console.error(`\n${ME} is not in the profiles. Set MY_TEAM_NAME.\n`)
    process.exitCode = 1
    return
  }

  console.log(`\nFitting ${profiles.length} managers measured from the ${season} season...`)
  const fitted = calibrate(profiles, PLAYOFF_TEAMS)
  for (const profile of fitted) {
    const target = (profile.benchWasteShare * 100).toFixed(1)
    console.log(
      `  ${profile.name.slice(0, 28).padEnd(30)} noise ${(profile.lineupNoise ?? 0).toFixed(2)}  ` +
        `target waste ${target}%`,
    )
  }

  const fittedRivals = fitted.filter((p) => p.name !== ME).map((p) => new LeagueRival(p))
  const fittedMe = fitted.find((p) => p.name === ME)
  if (!fittedMe) return

  // Named apart so the two runs can be told from each other in the results.
  const asSelf = new LeagueRival({ ...fittedMe, name: 'You (as you played)' })
  // A third arm that keeps the waiver habits and fixes only the lineups, so the
  // gain can be split between "set your lineup" and everything else Ark does.
  const lineupsOnly = new LeagueRival({
    ...fittedMe,
    name: 'You (lineups set properly)',
    lineupNoise: 0,
  })
  const withArk: Agent = new ArkAgent()

  console.log(`\nPlaying ${SEASONS} seasons twice against the same nine managers...\n`)
  const before = playLeague([asSelf, ...fittedRivals], SEASONS, 1, PLAYOFF_TEAMS)
  const middle = playLeague([lineupsOnly, ...fittedRivals], SEASONS, 1, PLAYOFF_TEAMS)
  const after = playLeague([withArk, ...fittedRivals], SEASONS, 1, PLAYOFF_TEAMS)

  const show = (label: string, run: ReturnType<typeof playLeague>) => {
    console.log(`${label}`)
    console.log('  manager                          titles  playoffs   wins   bench')
    for (const row of run.rows) {
      console.log(
        `  ${row.name.slice(0, 30).padEnd(32)}${(row.titles * 100).toFixed(1).padStart(6)}%` +
          `${(row.playoffs * 100).toFixed(1).padStart(9)}%${row.wins.toFixed(2).padStart(8)}` +
          `${(row.benchShare * 100).toFixed(1).padStart(7)}%`,
      )
    }
    console.log('')
  }

  show('AS YOU PLAYED LAST SEASON', before)
  show('SAME HABITS, LINEUPS SET PROPERLY', middle)
  show('WITH ARK', after)

  const you = before.rows.find((r) => r.name === 'You (as you played)')
  const fixed = middle.rows.find((r) => r.name === 'You (lineups set properly)')
  const ark = after.rows.find((r) => r.name === 'Ark')
  if (!you || !ark || !fixed) return

  const baseline = 1 / (rivals.length + 1)
  console.log('='.repeat(64))
  console.log(`  Random baseline in a ${rivals.length + 1} team league: ${(baseline * 100).toFixed(1)}%`)
  console.log(`  You, as measured:  ${(you.titles * 100).toFixed(1)}% titles, ${(you.playoffs * 100).toFixed(1)}% playoffs, ${you.wins.toFixed(2)} wins`)
  console.log(`  Lineups fixed only:${(fixed.titles * 100).toFixed(1)}% titles, ${(fixed.playoffs * 100).toFixed(1)}% playoffs, ${fixed.wins.toFixed(2)} wins`)
  console.log(`  You, with Ark:     ${(ark.titles * 100).toFixed(1)}% titles, ${(ark.playoffs * 100).toFixed(1)}% playoffs, ${ark.wins.toFixed(2)} wins`)
  const share = (fixed.titles - you.titles) / Math.max(ark.titles - you.titles, 1e-9)
  console.log(`  Of the gain, ${(share * 100).toFixed(0)}% is just setting the lineup`)
  const lift = ark.titles / Math.max(you.titles, 1e-9)
  console.log(`  Title rate ${lift >= 1 ? 'up' : 'down'} ${((lift - 1) * 100).toFixed(0)}%, ` +
    `${(ark.playoffs * 100 - you.playoffs * 100).toFixed(1)}pp more playoff appearances`)
  console.log('='.repeat(64))
  console.log('')
}

main()
