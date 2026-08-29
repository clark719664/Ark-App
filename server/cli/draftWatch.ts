import { config } from '../config.js'
import { openSession } from '../yahoo/browser.js'
import {
  fetchDraftPicks,
  fetchDraftStatus,
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
  flexCount,
  remainingNeeds,
  shapeFromEnv,
  snakePicks,
} from '../draftWatch.js'
import { computeLiveState, writeLiveState, LIVE_FILE } from '../draftLive.js'

/**
 * Watch a live Yahoo draft and say what to do about it.
 *
 * Polls the same JSON API the draft room reads, so a pick shows up here within
 * a poll of appearing on screen. Read-only throughout: it never makes a pick.
 */

const POLL_MS = Number.parseInt(process.env['DRAFT_POLL_MS'] ?? '', 10) || 5000
const BOARD_SIZE = 12
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']


function line(width = 72): string {
  return '-'.repeat(width)
}

function describe(pick: DraftPick, name: string, teamName: string, teams: number): string {
  const withinRound = ((pick.pick - 1) % teams) + 1
  const slot = `${pick.round}.${String(withinRound).padStart(2, '0')}`
  return `  #${String(pick.pick).padStart(3)}  ${slot.padStart(6)}  ${teamName.slice(0, 22).padEnd(24)} ${name}`
}

async function main(): Promise<void> {
  const leagueId = config.yahoo.leagueId
  const teamId = config.yahoo.teamId
  if (!leagueId) {
    console.error('\nYAHOO_LEAGUE_ID is not set. See .env.example.\n')
    process.exitCode = 1
    return
  }

  const shape = shapeFromEnv()
  const board = loadBoard(shape)
  const rounds = Number.parseInt(process.env['DRAFT_ROUNDS'] ?? '', 10) || 15

  console.log(`\nArk draft watch - league ${leagueId}, polling every ${POLL_MS / 1000}s`)
  console.log(`Board: ${board.length} ranked players, ${shape.teams} teams`)

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
    lastStatus = await fetchDraftStatus(session.page, leagueKey).catch(() => 'unknown')
    statusChecked = true
    leagueName = process.env['LEAGUE_NAME'] ?? `League ${leagueId}`
    teams = await fetchTeams(session.page, leagueKey)
    teamNames = new Map(teams.map((team) => [team.teamKey, team.name]))
    myTeamKey = teams.find((team) => team.teamKey.endsWith(`.t.${teamId}`))?.teamKey ?? ''

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
    if (seatPosition > 0) console.log(`  Draft seat: ${seatPosition}`)
    console.log(`  Your picks: ${snakePicks(shape.teams, seatPosition || 1, rounds).join(', ')}`)
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
      if (picks.length === 0 && lastStatus === 'drafting') {
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

        console.log('\n  BEST AVAILABLE')
        view.available.slice(0, BOARD_SIZE).forEach((player, rank) => {
          const need = (needs[player.position] ?? 0) > 0 ? ' *' : '  '
          console.log(
            `   ${String(rank + 1).padStart(2)}.${need} ${player.name.padEnd(22)} ${player.position.padEnd(4)} ${(player.team ?? '').padEnd(4)} vorp ${player.vorp.toFixed(1)}`,
          )
        })

        const cliffs = positionCliffs(view.available, view.picksUntilNext, POSITIONS).filter(
          (entry) => (needs[entry.position] ?? 0) > 0,
        )
        if (cliffs.length > 0 && view.picksUntilNext) {
          console.log(`\n  WHAT FALLS OFF before pick ${view.nextPick}`)
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
