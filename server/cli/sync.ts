import { config } from '../config.js'
import { syncLeagueViaApi } from '../yahoo/apiSync.js'
import { syncLeague, writeSnapshot } from '../yahoo/sync.js'

/**
 * Pull the league from Yahoo into .cache/league.json. Everything the hub shows
 * comes from that file, so this is the only step that talks to Yahoo.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))

  if (args.has('--help') || args.has('-h')) {
    console.log(`
Usage: npm run yahoo:sync [-- flags]

  --league <key>    Sync a league other than the one in .env
  --scrape          Use the old HTML scrapers instead of Yahoo's JSON API
  --fresh           Start over instead of resuming an interrupted sync
                    (--scrape only)
  --skip-players    Skip the player pool (--scrape only)
  --headed          Show the browser window while it works (--scrape only)
`)
    return
  }

  if (!config.yahoo.leagueId) {
    console.error(
      '\nYAHOO_LEAGUE_ID is not set.\n\n' +
        'Copy .env.example to .env and set it to the number in your league URL:\n' +
        '  https://football.fantasysports.yahoo.com/f1/123456  ->  YAHOO_LEAGUE_ID=123456\n',
    )
    process.exitCode = 1
    return
  }

  const argv = process.argv.slice(2)
  const leagueFlag = argv.indexOf('--league')
  const league = leagueFlag >= 0 ? argv[leagueFlag + 1] : undefined

  console.log(`\nSyncing Yahoo league ${league ?? config.yahoo.leagueId}...\n`)

  // The HTML scrapers parse nothing from this league's real pages, so the API
  // is the default and they are kept behind a flag rather than deleted.
  const snapshot = args.has('--scrape')
    ? await syncLeague({
        skipPlayers: args.has('--skip-players'),
        headed: args.has('--headed') ? true : undefined,
        fresh: args.has('--fresh'),
        onProgress: (message) => console.log(message),
      })
    : await syncLeagueViaApi({
        ...(league ? { leagueId: league } : {}),
        onProgress: (message) => console.log(message),
      })

  if (!args.has('--scrape')) writeSnapshot(snapshot)

  console.log(`
Done.
  Teams     ${snapshot.teams.length}
  Matchups  ${snapshot.matchups.length}
  Players   ${snapshot.players.length}
  Draft     ${snapshot.draft.length} picks
`)

  if (snapshot.warnings.length > 0) {
    console.log('Warnings:')
    for (const warning of snapshot.warnings) console.log(`  ! ${warning}`)
    // The capture tool records rendered HTML, which the API path never reads,
    // so pointing at it here would send anyone debugging in the wrong direction.
    console.log(
      args.has('--scrape')
        ? '\nIf data looks wrong, run `npm run yahoo:capture` and check .cache/raw/ ' +
            'to see what Yahoo actually returned.\n'
        : '',
    )
  }
}

main().catch((err: unknown) => {
  console.error(`\nSync failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
