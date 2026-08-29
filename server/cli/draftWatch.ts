import { byeStacks } from '../../data/draft/schedule.js'
import { config } from '../config.js'
import { openSession } from '../yahoo/browser.js'
import {
  fetchDraftPicks,
  fetchDraftStatus,
  fetchLeagueSetup,
  fetchRosterPicks,
  fetchTeams,
  loadPlayerIndex,
  type DraftPick,
  type LeagueTeam,
} from '../yahoo/draftFeed.js'
import {
  buildView,
  loadBoard,
  matchPlayers,
  positionCliffs,
  fillsOpenSlot,
  flexCount,
  remainingNeeds,
  shapeFromEnv,
  snakePicks,
} from '../draftWatch.js'
import { computeLiveState, writeLiveState, LIVE_FILE } from '../draftLive.js'
import { loadLeague } from '../leagues.js'

/**
 * Watch a live Yahoo draft and say what to do about it.
 *
 * Polls the same JSON API the draft room reads, so a pick shows up here within
 * a poll of appearing on screen. Read-only throughout: it never makes a pick.
 */

const POLL_MS = Number.parseInt(process.env['DRAFT_POLL_MS'] ?? '', 10) || 5000
const BOARD_SIZE = 12
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']


/**
 * Yahoo does not use one word for a draft in progress. The configured league
 * reports `predraft`, a public one reports `draft`, and `drafting` appears in
 * the documentation - so this asks whether the draft is not-yet and not-over
 * rather than matching a spelling. Getting it wrong would leave the roster
 * fallback armed for a status that never arrives.
 */
function isDrafting(status: string): boolean {
  const value = status.toLowerCase()
  return value !== 'predraft' && value !== 'postdraft' && value !== 'unknown'
}

function line(width = 72): string {
  return '-'.repeat(width)
}

function describe(pick: DraftPick, name: string, teamName: string, teams: number): string {
  const withinRound = ((pick.pick - 1) % teams) + 1
  const slot = `${pick.round}.${String(withinRound).padStart(2, '0')}`
  return `  #${String(pick.pick).padStart(3)}  ${slot.padStart(6)}  ${teamName.slice(0, 22).padEnd(24)} ${name}`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = argv.indexOf('--league')
  const explicit = flag >= 0 ? argv[flag + 1] : undefined
  const leagueId = explicit ?? config.yahoo.leagueId
  // .env describes one league. Pointing at another one means its seat, shape
  // and team id are about somebody else's draft, so they are dropped rather
  // than silently applied - a wrong seat quietly miscounts every pick.
  const foreign = explicit !== undefined && explicit !== config.yahoo.leagueId
  if (foreign) {
    for (const key of [
      'DRAFT_POSITION', 'LEAGUE_TEAMS', 'DRAFT_ROUNDS', 'LEAGUE_NAME', 'SHAPE_FLEX',
      'SHAPE_QB', 'SHAPE_RB', 'SHAPE_WR', 'SHAPE_TE', 'SHAPE_K', 'SHAPE_DEF',
    ]) delete process.env[key]
  }
  if (!leagueId) {
    console.error('\nNo league. Set YAHOO_LEAGUE_ID in .env or pass --league <id>.\n')
    process.exitCode = 1
    return
  }

  let shape = shapeFromEnv()
  let board = loadBoard(shape)
  let rounds = 15

  console.log(`\nArk draft watch - league ${leagueId}, polling every ${POLL_MS / 1000}s`)

  const session = await openSession({ headed: false })
  let teams: LeagueTeam[] = []
  let teamNames = new Map<string, string>()
  let myTeamKey = ''
  let seatPosition = Number.parseInt(process.env['DRAFT_POSITION'] ?? '', 10) || 0
  const seen = new Set<number>()
  let lastStatus = 'unknown'
  let statusChecked = false
  let emptyWhileDrafting = 0
  let usingRosters = false
  const ROSTER_FALLBACK_AFTER = 3
  let leagueName = ''

  try {
    await session.page.goto(`https://football.fantasysports.yahoo.com/f1/${leagueId}`, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.timeoutMs,
    })

    const leagueKey = `nfl.l.${leagueId}`

    // A linked league already has its shape read and a board priced in its own
    // scoring, which is the difference between a ranking that applies to this
    // draft and one that applies to a different league's rules.
    const linked = loadLeague(leagueId)
    if (linked) {
      console.log(`  Linked league: ${linked.name}, scored ${linked.scoringLabel}`)
    } else {
      console.log('  Not linked yet - using the shared board. Run: npm run league:link')
    }

    // Ask the league what it is rather than trusting six environment variables
    // to still describe it. Anything set explicitly still wins.
    const setup = await fetchLeagueSetup(session.page, leagueKey)
    shape = shapeFromEnv({
      teams: setup.teams || linked?.shape.teams,
      starters: setup.starters ?? linked?.shape.starters,
      flex: setup.flex,
    })
    board = loadBoard(shape, linked?.poolFile)
    rounds = Number.parseInt(process.env['DRAFT_ROUNDS'] ?? '', 10) || setup.rounds
    seatPosition = seatPosition || setup.seat
    lastStatus = setup.draftStatus
    statusChecked = true
    leagueName = process.env['LEAGUE_NAME'] ?? setup.leagueName
    const teamId = foreign
      ? setup.myTeamId || linked?.teamId || ''
      : config.yahoo.teamId || setup.myTeamId || linked?.teamId || ''

    teams = await fetchTeams(session.page, leagueKey)
    teamNames = new Map(teams.map((team) => [team.teamKey, team.name]))
    const mine = teams.find((team) => team.teamKey.endsWith(`.t.${teamId}`))
    myTeamKey = mine?.teamKey ?? ''
    // The league-level draft position is only there once an order is published;
    // the team carries its own, which is the one that is actually right.
    seatPosition = seatPosition || mine?.draftPosition || setup.seat || linked?.seat || 0

    console.log(`  ${setup.leagueName}: ${shape.teams} teams, ${rounds} rounds`)
    console.log(
      `  Starters: ${Object.entries(shape.starters)
        .map(([position, count]) => `${position}x${count}`)
        .join(' ')} flex x${setup.flex}`,
    )
    console.log(`  Board: ${board.length} ranked players`)

    console.log('Indexing the player pool (once, then cached)...')
    const index = await loadPlayerIndex(session.page, leagueKey, {
      onProgress: (message) => process.stdout.write(`\r${message}   `),
    })
    console.log(`\r  ${index.size} players indexed        `)

    const { byPlayerKey, unmatched } = matchPlayers([...index.values()], board)
    console.log(`  ${byPlayerKey.size} matched to the board, ${unmatched.length} unmatched`)
    if (myTeamKey) {
      console.log(`  Your team: ${teamNames.get(myTeamKey) ?? myTeamKey}`)
    } else {
      console.log('  Could not identify your team; set YAHOO_TEAM_ID in .env')
    }
    if (seatPosition > 0) {
      console.log(`  Draft seat: ${seatPosition}`)
      console.log(`  Your picks: ${snakePicks(shape.teams, seatPosition, rounds).join(', ')}`)
    } else {
      console.log('  Draft seat: not published yet, reading it from your first pick')
    }
    console.log(`  Live snapshot: ${LIVE_FILE}`)
    console.log(line())

    let idle = 0
    for (;;) {
      let picks: DraftPick[] = []
      try {
        picks = await fetchDraftPicks(session.page, leagueKey)
      } catch (err) {
        console.log(`  (feed error: ${err instanceof Error ? err.message : String(err)})`)
        await session.page.waitForTimeout(POLL_MS)
        continue
      }

      // If the draft is running and the results endpoint is still empty, it is
      // either genuinely pick one or that endpoint does not fill until the
      // draft ends. Rosters distinguish the two, so ask them rather than sit
      // there showing nothing all night.
      if (picks.length === 0 && isDrafting(lastStatus)) {
        emptyWhileDrafting++
        if (emptyWhileDrafting === ROSTER_FALLBACK_AFTER) {
          console.log('  draft results still empty; falling back to reading rosters')
        }
        if (emptyWhileDrafting >= ROSTER_FALLBACK_AFTER) {
          try {
            picks = await fetchRosterPicks(
              session.page,
              leagueKey,
              teams.map((team) => team.teamKey.split('.t.')[1] ?? ''),
              1,
            )
            usingRosters = picks.length > 0
          } catch (err) {
            console.log(`  (roster fallback failed: ${err instanceof Error ? err.message : String(err)})`)
          }
        }
      } else if (picks.length > 0) {
        emptyWhileDrafting = 0
        usingRosters = false
      }

      // If the order was never published, the seat is whatever slot the first
      // pick of your own landed in. Better to learn it a pick late than to
      // assume one and count every pick against the wrong turn.
      if (seatPosition === 0 && myTeamKey) {
        const first = picks.find((pick) => pick.teamKey === myTeamKey)
        if (first) {
          seatPosition = ((first.pick - 1) % shape.teams) + 1
          console.log(`  Draft seat: ${seatPosition}, read from your pick at ${first.pick}`)
          console.log(`  Your picks: ${snakePicks(shape.teams, seatPosition, rounds).join(', ')}`)
        }
      }

      // Written every poll, not only on a new pick, so a phone can tell the
      // difference between a quiet draft and a watcher that has died.
      const status = statusChecked ? lastStatus : 'unknown'
      writeLiveState(
        computeLiveState(picks, byPlayerKey, board, {
          leagueName,
          draftStatus: status,
          shape,
          rounds,
          seat: seatPosition || 1,
          myTeamKey,
          myTeamName: teamNames.get(myTeamKey) ?? '',
          teamNames,
          yahooIndex: index,
        }),
      )

      const fresh = picks.filter((pick) => !seen.has(pick.pick))
      if (fresh.length > 0) {
        idle = 0
        for (const pick of fresh) {
          seen.add(pick.pick)
          const player = byPlayerKey.get(pick.playerKey)
          // A player Yahoo lists but the board does not rank is still a real
          // pick worth reading, so fall back to Yahoo's own name rather than
          // printing a key at someone watching their draft.
          const yahooEntry = index.get(pick.playerKey)
          const label = player
            ? `${player.name} (${player.position}${player.team ? ' ' + player.team : ''})`
            : yahooEntry
              ? `${yahooEntry.name} (${yahooEntry.position} ${yahooEntry.team}) - not on the board`
              : `[unknown ${pick.playerKey}]`
          console.log(describe(pick, label, teamNames.get(pick.teamKey) ?? pick.teamKey, shape.teams))
        }

        const view = buildView(picks, byPlayerKey, board, {
          myTeamKey,
          teams: shape.teams,
          position: seatPosition || 1,
          rounds,
        })

        const needs = remainingNeeds(view.myRoster, shape.starters, flexCount(shape))
        const openSlots = Object.entries(needs)
          .filter(([, count]) => count > 0)
          .map(([position, count]) => `${position}x${count}`)
          .join(' ')

        console.log(line())
        if (view.picksUntilNext === 0) {
          console.log('  >>> YOU ARE ON THE CLOCK <<<')
        } else if (view.picksUntilNext !== null) {
          console.log(`  Pick ${view.onTheClock} is up. You pick at ${view.nextPick} (${view.picksUntilNext} away).`)
        }
        if (usingRosters) console.log('  (picks read from rosters, order approximate)')
        console.log(`  Your roster (${view.myRoster.length}): ${view.myRoster.map((p) => `${p.name} ${p.position}`).join(', ') || 'empty'}`)
        console.log(`  Still needed: ${openSlots || 'starters full'}`)
        for (const stack of byeStacks(view.myRoster.map((p) => p.byeWeek ?? null))) {
          if (stack.count < 3) continue
          console.log(`  !! Week ${stack.week}: ${stack.count} of your players are on bye`)
        }

        console.log('\n  BEST AVAILABLE')
        view.available.slice(0, BOARD_SIZE).forEach((player, rank) => {
          const need = fillsOpenSlot(player.position, needs) ? ' *' : '  '
          const bye = player.byeWeek == null ? '     ' : `bye${String(player.byeWeek).padStart(2)}`
          console.log(
            `   ${String(rank + 1).padStart(2)}.${need} ${player.name.padEnd(22)} ${player.position.padEnd(4)} ${(player.team ?? '').padEnd(4)} ${bye}  vorp ${player.vorp.toFixed(1)}`,
          )
        })

        // Measured to the pick after the one being made. On the clock those
        // differ, and the current pick is the useless answer: nothing falls
        // away before a pick you are making right now.
        const cliffs = positionCliffs(view.available, view.cliffHorizon, POSITIONS).filter((entry) =>
          fillsOpenSlot(entry.position, needs),
        )
        if (cliffs.length > 0 && view.cliffHorizon !== null) {
          console.log(`\n  WHAT FALLS OFF before pick ${view.onTheClock + view.cliffHorizon}`)
          for (const cliff of cliffs.slice(0, 4)) {
            const later = cliff.bestLater ? `${cliff.bestLater.name} (${cliff.bestLater.vorp.toFixed(1)})` : 'nobody startable'
            console.log(
              `    ${cliff.position.padEnd(4)} now ${cliff.bestNow.name} (${cliff.bestNow.vorp.toFixed(1)})  ->  likely ${later}   drop ${cliff.drop.toFixed(1)}`,
            )
          }
        }
        console.log(line())
      } else {
        idle++
        // Status is what decides whether an empty feed means "not started" or
        // "started and not reporting", so refresh it more often once it matters.
        if (idle % 6 === 1) {
          lastStatus = await fetchDraftStatus(session.page, leagueKey).catch(() => 'unknown')
          statusChecked = true
          console.log(`  ...waiting (${picks.length} picks so far, draft_status=${lastStatus})`)
        }
      }

      if (picks.length >= shape.teams * rounds) {
        console.log('\nDraft complete.\n')
        break
      }
      await session.page.waitForTimeout(POLL_MS)
    }
  } finally {
    await session.close()
  }
}

main().catch((err: unknown) => {
  console.error(`\nDraft watch failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
