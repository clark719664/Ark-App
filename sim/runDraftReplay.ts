import fs from 'node:fs'
import { rankPool, type DraftPool, type RankedPlayer } from '../server/draftPool.js'
import { snakePicks } from '../server/draftWatch.js'
import {
  loadByes, loadPriorSeason, loadRuledOut, loadWeekly, normName, pickLineup, projectBefore, sum,
  type Candidate,
} from './replay.js'

/**
 * Does a better draft survive contact with the season?
 *
 * Takes the roster Ark's board would have drafted in 2025 from the same seat,
 * plays every week with the best lineup a pre-week projection can pick from it,
 * and puts it against the scores the real opponents actually posted.
 */

const WEEKS = 15
const MINE = '461.l.1311998.t.4'
const SHAPE = {
  teams: 10,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
  flexShare: { RB: 0.4, WR: 0.5, TE: 0.1 },
}

const pool = JSON.parse(fs.readFileSync('data/derived/draft-pool-2025.json', 'utf8')) as DraftPool
const board = rankPool(pool, SHAPE)
const weekly = loadWeekly(2025)
const prior = loadPriorSeason(2024)
const ruledOut = loadRuledOut(2025)
const byes = loadByes(2025)

// --- the draft that actually happened ---------------------------------------
const raw = JSON.parse(fs.readFileSync('.cache/probe/draft-461.l.1311998.json', 'utf8'))
const block = raw.fantasy_content.league.find((n: Record<string, unknown>) => n && n['draft_results'])['draft_results']
interface Pick { pick: number; team: string; key: string }
const picks: Pick[] = []
for (let i = 0; i < Number(block.count); i++) {
  const r = block[String(i)]?.draft_result
  if (r) picks.push({ pick: Number(r.pick), team: String(r.team_key), key: String(r.player_key) })
}
picks.sort((a, b) => a.pick - b.pick)

const yahoo = JSON.parse(fs.readFileSync('.cache/yahoo-players.json', 'utf8')) as Array<{
  playerKey: string; name: string; position: string; team: string
}>
const keyToName = new Map<string, string>()
for (const y of yahoo) keyToName.set(y.playerKey.replace(/^470\./, '461.'), y.name)
const boardByName = new Map<string, RankedPlayer>()
for (const p of board) boardByName.set(normName(p.name), p)

const seat = picks.find((p) => p.team === MINE)?.pick ?? 0
const mySlots = new Set(snakePicks(SHAPE.teams, seat, 15))

const arkRoster: RankedPlayer[] = []
const gone = new Set<string>()
const need: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 }
for (const p of picks) {
  if (!mySlots.has(p.pick)) {
    const taken = boardByName.get(normName(keyToName.get(p.key) ?? ''))
    if (taken) gone.add(taken.playerId)
    continue
  }
  const open = board.filter((x) => !gone.has(x.playerId))
  const best = open[0]
  if (!best) continue
  const needed = open.find((x) => (need[x.position] ?? 0) > 0)
  let choice = best
  if (needed && needed.playerId !== best.playerId && best.vorp - needed.vorp < 8) choice = needed
  const remaining = need[choice.position] ?? 0
  if (remaining > 0) need[choice.position] = remaining - 1
  gone.add(choice.playerId)
  arkRoster.push(choice)
}

console.log('\nArk would have drafted (2025, seat ' + seat + '):')
for (const p of arkRoster) console.log(`   ${p.position.padEnd(4)} ${p.name}`)

// --- play the season with that roster ---------------------------------------
interface Game { week: number; a: { teamKey: string; points: number }; b: { teamKey: string; points: number } }
const games = JSON.parse(fs.readFileSync('.cache/probe/scoreboard-2025.json', 'utf8')) as Game[]
const rosters = JSON.parse(fs.readFileSync('.cache/probe/rosters-2025.json', 'utf8')) as Record<
  string, Record<string, Array<{ name: string; position: string; slot: string }>>
>
const mineWeekly = rosters[MINE]!

let actualWins = 0, draftWins = 0, actualPts = 0, draftPts = 0
const rows: string[] = []

for (let week = 1; week <= WEEKS; week++) {
  const game = games.find((g) => g.week === week && (g.a.teamKey === MINE || g.b.teamKey === MINE))
  if (!game) continue
  const me = game.a.teamKey === MINE ? game.a : game.b
  const them = game.a.teamKey === MINE ? game.b : game.a

  // Hold kicker and defence at whatever the real team produced, since neither
  // roster can be scored for them here.
  const realSlots = mineWeekly[String(week)] ?? []
  const realSkill: Candidate[] = []
  for (const e of realSlots) {
    const name = normName(e.name)
    const position = weekly.position.get(name) ?? e.position
    if (!['QB', 'RB', 'WR', 'TE'].includes(position)) continue
    realSkill.push({
      name, position, projection: 0,
      actual: weekly.points.get(`${week}|${name}`) ?? 0,
      available: true,
      started: e.slot !== 'BN' && e.slot !== 'IR',
    })
  }
  const nonSkill = me.points - sum(realSkill.filter((c) => c.started))

  const arkCandidates: Candidate[] = arkRoster
    .filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.position))
    .map((p) => {
      const name = normName(p.name)
      const team = weekly.team.get(name) ?? ''
      return {
        name, position: p.position, projection: projectBefore(name, p.position, week, weekly, prior),
        actual: weekly.points.get(`${week}|${name}`) ?? 0,
        available: !ruledOut.has(`${week}|${name}`) && !(team !== '' && byes.has(`${week}|${team}`)),
        started: false,
      }
    })
  const arkTotal = nonSkill + sum(pickLineup(arkCandidates, (c) => c.projection))

  const aw = me.points > them.points
  const dw = arkTotal > them.points
  if (aw) actualWins++
  if (dw) draftWins++
  actualPts += me.points
  draftPts += arkTotal
  rows.push(
    `  ${String(week).padStart(2)}  ${me.points.toFixed(1).padStart(6)} ${aw ? 'W' : 'L'}` +
      `   ${arkTotal.toFixed(1).padStart(6)} ${dw ? 'W' : 'L'}   vs ${them.points.toFixed(1).padStart(6)}` +
      `   ${(arkTotal - me.points >= 0 ? '+' : '') + (arkTotal - me.points).toFixed(1)}` +
      `${aw !== dw ? (dw ? '   <- flipped to a win' : '   <- lost') : ''}`,
  )
}

console.log('\n  wk    actual    Ark draft      opponent    diff')
for (const r of rows) console.log(r)
console.log('\n' + '='.repeat(58))
console.log(`  Record      ${actualWins}-${WEEKS - actualWins}   ->   ${draftWins}-${WEEKS - draftWins}`)
console.log(`  Points      ${actualPts.toFixed(1)}   ->   ${draftPts.toFixed(1)}   (${(draftPts - actualPts >= 0 ? '+' : '') + (draftPts - actualPts).toFixed(1)})`)
console.log('='.repeat(58))
console.log('  Ark roster never changes all season: no waivers, no trades.\n')
