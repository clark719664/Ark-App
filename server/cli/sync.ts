import { config } from '../config.js'
import { syncLeague } from '../yahoo/sync.js'

/**
 * Pull the league from Yahoo into .cache/league.json. Everything the hub shows
 * comes from that file, so this is the only step that talks to Yahoo.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))

  if (!config.yahoo.leagueId) {
    console.error(
      '\nYAHOO_LEAGUE_ID is not set.\n\n' +
        'Copy .env.example to .env and set it to the number in your league URL:\n' +
        '  https://football.fantasysports.yahoo.com/f1/123456  ->  YAHOO_LEAGUE_ID=123456\n',
    )
    process.exitCode = 1
    return
  }

  console.log(`\nSyncing Yahoo league ${config.yahoo.leagueId} (${config.yahoo.season})…\n`)

  const snapshot = await syncLeague({
    skipPlayers: args.has('--skip-players'),
    headed: args.has('--headed') ? true : undefined,
    onProgress: (message) => console.log(message),
  })

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
    console.log(
      '\nIf data looks wrong, run `npm run yahoo:capture` and check .cache/raw/ ' +
        'to see what Yahoo actually returned.\n',
    )
  }
}

main().catch((err: unknown) => {
  console.error(`\nSync failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
