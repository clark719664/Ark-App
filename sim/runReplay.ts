import fs from 'node:fs'
import {
  loadByes,
  loadPriorSeason,
  loadRuledOut,
  loadWeekly,
  normName,
  pickLineup,
  projectBefore,
  sum,
  type Candidate,
} from './replay.js'

/**
 * The 2025 season, replayed with only the lineup decisions changed.
 *
 * Same roster every week, same opponents, same scores those opponents put up.
 * The only difference is which of his own players the manager started.
 */

const SEASON = 2025
const REGULAR_WEEKS = 15
const MY_TEAM = process.env['MY_TEAM_KEY'] ?? '461.l.1311998.t.4'

interface Slot { name: string; position: string; slot: string }
interface Game { week: number; a: { teamKey: string; points: number }; b: { teamKey: string; points: number }; playoff: boolean }

function main(): void {
  const rosters = JSON.parse(
    fs.readFileSync('.cache/probe/rosters-2025.json', 'utf8'),
  ) as Record<string, Record<string, Slot[]>>
  const games = JSON.parse(fs.readFileSync('.cache/probe/scoreboard-2025.json', 'utf8')) as Game[]

  const teamsRaw = JSON.parse(fs.readFileSync('.cache/probe/teams-2025.json', 'utf8'))
  const names = new Map<string, string>()
  {
    const block = teamsRaw.fantasy_content.league.find(
      (n: Record<string, unknown>) => n && n['teams'],
    )['teams']
    for (let i = 0; i < Number(block.count); i++) {
      const entry = block[String(i)]?.team
      const flat: Record<string, unknown> = {}
      for (const part of (Array.isArray(entry) ? entry.flat(3) : [entry])) {
        if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(flat, part)
      }
      names.set(String(flat['team_key']), String(flat['name']))
    }
  }

  const weekly = loadWeekly(SEASON)
  const prior = loadPriorSeason(SEASON - 1)
  const ruledOut = loadRuledOut(SEASON)
  const byes = loadByes(SEASON)

  const mine = rosters[MY_TEAM]
  if (!mine) throw new Error(`No roster history for ${MY_TEAM}`)

  let actualWins = 0
  let arkWins = 0
  let actualPoints = 0
  let arkPoints = 0
  const rows: string[] = []
  const replayed = new Map<number, number>()
  let perfectTotal = 0
  let startedTotal = 0
  let arkSkillTotal = 0
  let swaps = 0
  let flippedFor = 0
  let flippedAgainst = 0

  for (let week = 1; week <= REGULAR_WEEKS; week++) {
    const game = games.find(
      (g) => g.week === week && (g.a.teamKey === MY_TEAM || g.b.teamKey === MY_TEAM),
    )
    const slots = mine[String(week)]
    if (!game || !slots) continue

    const meSide = game.a.teamKey === MY_TEAM ? game.a : game.b
    const themSide = game.a.teamKey === MY_TEAM ? game.b : game.a

    const candidates: Candidate[] = []
    for (const entry of slots) {
      const name = normName(entry.name)
      const position = weekly.position.get(name) ?? entry.position
      if (!['QB', 'RB', 'WR', 'TE'].includes(position)) continue
      const team = weekly.team.get(name) ?? ''
      const out = ruledOut.has(`${week}|${name}`)
      const bye = team !== '' && byes.has(`${week}|${team}`)
      candidates.push({
        name,
        position,
        projection: projectBefore(name, position, week, weekly, prior),
        actual: weekly.points.get(`${week}|${name}`) ?? 0,
        available: !out && !bye,
        started: entry.slot !== 'BN' && entry.slot !== 'IR',
      })
    }

    const startedSkill = candidates.filter((c) => c.started)
    const arkSkill = pickLineup(candidates, (c) => c.projection)
    // The ceiling nobody can reach: the best lineup with hindsight. It is here
    // only to say how much of the gap is judgement and how much is luck.
    const perfectSkill = pickLineup(candidates, (c) => c.actual)
    perfectTotal += sum(perfectSkill)
    startedTotal += sum(startedSkill)
    arkSkillTotal += sum(arkSkill)
    swaps += arkSkill.filter((c) => !c.started).length

    // Kickers and defences are not scored here, so hold whatever they produced
    // fixed and move only the skill part of the real total.
    const nonSkill = meSide.points - sum(startedSkill)
    const arkTotal = nonSkill + sum(arkSkill)

    const actualWin = meSide.points > themSide.points
    const arkWin = arkTotal > themSide.points
    if (actualWin) actualWins++
    if (arkWin) arkWins++
    if (!actualWin && arkWin) flippedFor++
    if (actualWin && !arkWin) flippedAgainst++
    replayed.set(week, arkTotal)
    actualPoints += meSide.points
    arkPoints += arkTotal

    rows.push(
      `  ${String(week).padStart(2)}  ${meSide.points.toFixed(1).padStart(6)} ${actualWin ? 'W' : 'L'}` +
        `   ${arkTotal.toFixed(1).padStart(6)} ${arkWin ? 'W' : 'L'}` +
        `   vs ${themSide.points.toFixed(1).padStart(6)}` +
        `   ${(arkTotal - meSide.points >= 0 ? '+' : '') + (arkTotal - meSide.points).toFixed(1)}` +
        `${!actualWin && arkWin ? '   <- flipped to a win' : ''}` +
        `${actualWin && !arkWin ? '   <- lost' : ''}`,
    )
  }

  console.log(`\nReplaying ${SEASON} for ${MY_TEAM}`)
  console.log('Same roster, same opponents, same opponent scores. Only the lineup changes.\n')
  console.log('  wk    actual      with Ark      opponent    diff')
  for (const row of rows) console.log(row)

  console.log('\n' + '='.repeat(60))
  console.log(`  Record        ${actualWins}-${REGULAR_WEEKS - actualWins}   ->   ${arkWins}-${REGULAR_WEEKS - arkWins}`)
  console.log(`  Points for    ${actualPoints.toFixed(1)}   ->   ${arkPoints.toFixed(1)}   (${(arkPoints - actualPoints >= 0 ? '+' : '') + (arkPoints - actualPoints).toFixed(1)})`)
  console.log(`  Games flipped ${flippedFor} won that were lost, ${flippedAgainst} lost that were won`)
  console.log('')
  console.log(`  Skill points started, actual:      ${startedTotal.toFixed(1)}`)
  console.log(`  Skill points, projection lineup:   ${arkSkillTotal.toFixed(1)}`)
  console.log(`  Skill points, hindsight ceiling:   ${perfectTotal.toFixed(1)}`)
  console.log(`  Lineup changes the projection made: ${swaps} over ${REGULAR_WEEKS} weeks`)
  console.log('='.repeat(60) + '\n')

  // Standings recomputed cleanly: every game replayed with the new score
  // substituted for this team, every other result exactly as it happened.
  const records = new Map<string, { wins: number; losses: number; points: number }>()
  const scoreFor = (side: { teamKey: string; points: number }, week: number): number =>
    side.teamKey === MY_TEAM ? (replayed.get(week) ?? side.points) : side.points

  for (const game of games) {
    if (game.week > REGULAR_WEEKS) continue
    const a = scoreFor(game.a, game.week)
    const b = scoreFor(game.b, game.week)
    for (const [key, own, other] of [
      [game.a.teamKey, a, b],
      [game.b.teamKey, b, a],
    ] as const) {
      const row = records.get(key) ?? { wins: 0, losses: 0, points: 0 }
      if (own > other) row.wins += 1
      else row.losses += 1
      row.points += own
      records.set(key, row)
    }
  }

  const table = [...records.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.wins - a.wins || b.points - a.points)

  console.log('  Standings with the replayed season, every other result unchanged')
  table.forEach((row, index) => {
    const mark = row.key === MY_TEAM ? '   <- you' : ''
    const line = index === 3 ? '  ---- playoff line ----' : ''
    console.log(
      `   ${String(index + 1).padStart(2)}. ${(names.get(row.key) ?? row.key).slice(0, 26).padEnd(28)}` +
        `${String(row.wins).padStart(2)}-${String(row.losses).padStart(2)}  ${row.points.toFixed(1).padStart(7)}${mark}`,
    )
    if (line) console.log(line)
  })

  console.log('')
}

main()
