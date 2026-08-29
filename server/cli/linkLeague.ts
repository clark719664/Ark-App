import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config, currentNflSeason } from '../config.js'
import { openSession } from '../yahoo/browser.js'
import { API, collection, fetchJson, fetchLeagueSetup, flatten } from '../yahoo/draftFeed.js'
import { fetchLeagueScoring } from '../yahoo/leagueScoring.js'
import { loadLeague, poolFileFor, saveLeague, scoringDiffers, type LinkedLeague } from '../leagues.js'
import { DEFAULT_SHAPE, type DraftPool } from '../draftPool.js'
import {
  applyRookieProjections,
  loadYahooProjections,
} from '../../data/draft/rookieProjections.js'

/**
 * Link a league, and price a board for it.
 *
 * With no argument this finds every league on the account and links all of
 * them, because the useful version of this is not having to know a league id.
 * Everything is read from Yahoo: scoring, roster shape, round count, seat and
 * team. Nothing is configured by hand, so a league added a minute ago is as
 * accurate as one that has been set up for a season.
 */

interface Discovered {
  leagueId: string
  name: string
}

async function discover(page: import('playwright').Page): Promise<Discovered[]> {
  const payload = await fetchJson(page, `${API}/users;use_login=1/games;game_keys=nfl/leagues?format=json`)
  const users = (payload as { fantasy_content?: { users?: Record<string, unknown> } }).fantasy_content
    ?.users
  const user = flatten((users as Record<string, { user?: unknown }> | undefined)?.['0']?.user)
  const found: Discovered[] = []
  for (const game of collection<unknown>(user['games'] as Record<string, unknown>, 'game')) {
    const leagues = flatten(game)['leagues'] as Record<string, unknown> | undefined
    for (const league of collection<unknown>(leagues, 'league')) {
      const entry = flatten(league)
      found.push({ leagueId: String(entry['league_id']), name: String(entry['name']) })
    }
  }
  return found
}

function buildPool(season: number, scoringFile: string, destination: string): void {
  // The pool builder reads whichever scoring file it is pointed at, so a board
  // per league costs one build each rather than a parallel code path.
  execFileSync(
    process.execPath,
    [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), path.join('data', 'cli', 'draft.ts'), String(season)],
    { stdio: 'pipe', env: { ...process.env, LEAGUE_SCORING_FILE: scoringFile } },
  )
  const generic = path.resolve(process.cwd(), 'data', 'derived', `draft-pool-${season}.json`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(generic, destination)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const requested = argv.find((value) => !value.startsWith('--'))
  // The season being drafted, not the one after it. data:draft defaults to
  // next season because that is what an offseason rebuild wants; a league being
  // linked is playing this one, and building the wrong year yields a board of
  // thirty two defences and nothing else.
  const season = currentNflSeason()

  const session = await openSession({ headed: false })
  try {
    const page = session.page
    await page.goto('https://football.fantasysports.yahoo.com/', {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.timeoutMs,
    })

    const leagues = requested
      ? [{ leagueId: requested, name: requested }]
      : await discover(page)

    if (leagues.length === 0) {
      console.log('\nNo leagues found on this account.\n')
      return
    }
    console.log(`\nLinking ${leagues.length} league(s)\n`)

    for (const entry of leagues) {
      const leagueKey = `nfl.l.${entry.leagueId}`
      console.log(`${entry.name} (${entry.leagueId})`)

      const setup = await fetchLeagueSetup(page, leagueKey)
      const { scoring, unmapped, label } = await fetchLeagueScoring(page, leagueKey)

      const flexShare =
        setup.flex > 0
          ? { RB: 0.4 * setup.flex, WR: 0.5 * setup.flex, TE: 0.1 * setup.flex }
          : { RB: 0, WR: 0, TE: 0 }

      const league: LinkedLeague = {
        leagueId: entry.leagueId,
        leagueKey,
        name: setup.leagueName,
        season,
        linkedAt: new Date().toISOString(),
        scoring,
        scoringLabel: label,
        shape: {
          teams: setup.teams || DEFAULT_SHAPE.teams,
          starters: setup.starters,
          flexShare,
        },
        rounds: setup.rounds,
        seat: setup.seat,
        teamId: setup.myTeamId,
        teamName: setup.myTeamName,
        poolFile: poolFileFor(entry.leagueId, season),
        unmapped,
      }

      console.log(`  scoring   ${label}`)
      console.log(
        `  shape     ${setup.teams} teams, ${setup.rounds} rounds, ` +
          `${Object.entries(setup.starters).map(([p, n]) => `${p}x${n}`).join(' ')} flex x${setup.flex}`,
      )
      console.log(
        `  you       ${setup.myTeamName || 'not found'}` +
          `${setup.seat > 0 ? `, seat ${setup.seat}` : ', seat not published yet'}`,
      )
      if (unmapped.length > 0) console.log(`  ignored   ${unmapped.join(', ')}`)

      const previous = loadLeague(entry.leagueId)
      const changed = previous ? scoringDiffers(previous.scoring, scoring) : []
      if (previous && changed.length > 0) {
        console.log(`  changed   ${changed.join('; ')}`)
      }

      const scoringFile = path.resolve(
        process.cwd(),
        'data',
        'derived',
        'leagues',
        `scoring-${entry.leagueId}.json`,
      )
      fs.mkdirSync(path.dirname(scoringFile), { recursive: true })
      fs.writeFileSync(
        scoringFile,
        `${JSON.stringify({ leagueName: league.name, scoring }, null, 2)}\n`,
      )

      const destination = path.resolve(process.cwd(), league.poolFile)
      const needsBuild =
        !fs.existsSync(destination) || !previous || changed.length > 0 || argv.includes('--rebuild')
      if (needsBuild) {
        process.stdout.write('  board     building for this scoring... ')
        buildPool(season, scoringFile, destination)
        const built = JSON.parse(fs.readFileSync(destination, 'utf8')) as {
          players: unknown[]
        }
        // A board that builds but holds nobody is the failure this whole file
        // exists to avoid, so it is caught here rather than on draft night.
        if (built.players.length < 200) {
          throw new Error(
            `built a board with only ${built.players.length} players for ${season}. ` +
              'Run: npm run data:fetch',
          )
        }
        console.log(`${built.players.length} players`)

        // Rookies have no history, so the board prices them from draft capital
        // alone. Yahoo projects them individually, which is a better answer to
        // the same question, so it wins where it exists.
        const projections = loadYahooProjections(config.cache.snapshotFile)
        if (projections.size > 0) {
          const pool = JSON.parse(fs.readFileSync(destination, 'utf8')) as DraftPool
          const changes = applyRookieProjections(pool.players, projections)
          if (changes.length > 0) {
            fs.writeFileSync(destination, `${JSON.stringify(pool)}
`)
            const biggest = [...changes].sort((a, b) => b.to - a.to).slice(0, 3)
            console.log(
              `  rookies   ${changes.length} repriced from Yahoo, e.g. ` +
                biggest.map((c) => `${c.name} ${c.from} to ${c.to}`).join(', '),
            )
          }
        } else {
          console.log('  rookies   no Yahoo projections cached; run npm run yahoo:sync')
        }
      } else {
        console.log('  board     already priced for this league')
      }

      saveLeague(league)
      console.log('')
    }

    console.log('Linked. The watcher and the board use these automatically.\n')
  } finally {
    await session.close()
  }
}

main().catch((err: unknown) => {
  console.error(`\nLink failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
