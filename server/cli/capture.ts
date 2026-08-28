import { config } from '../config.js'
import { captureLeague } from '../yahoo/capture.js'

/**
 * Record what Yahoo actually serves: rendered HTML, screenshots, and every JSON
 * payload the Yahoo frontend fetches. This is the tool to reach for when a
 * scraper returns empty results — the captures show whether the page changed,
 * the session lapsed, or the parser is simply looking in the wrong place.
 */
async function main(): Promise<void> {
  if (!config.yahoo.leagueId) {
    console.error('\nYAHOO_LEAGUE_ID is not set. See .env.example.\n')
    process.exitCode = 1
    return
  }

  console.log(`\nCapturing Yahoo league ${config.yahoo.leagueId}…\n`)

  const result = await captureLeague({
    leagueId: config.yahoo.leagueId,
    ...(config.yahoo.teamId ? { teamId: config.yahoo.teamId } : {}),
    headed: !process.argv.includes('--headless'),
    onProgress: (message) => console.log(message),
  })

  const failed = result.targets.filter((t) => !t.ok)

  console.log(`
Captured ${result.targets.length - failed.length}/${result.targets.length} pages
  HTML + screenshots  ${config.cache.rawDir}
  JSON payloads       ${config.cache.netDir} (${result.json.length} recorded)
  Index               ${config.cache.dir}/capture-index.json
`)

  if (result.json.length > 0) {
    console.log('Largest JSON responses Yahoo fetched for itself:')
    for (const entry of [...result.json].sort((a, b) => b.bytes - a.bytes).slice(0, 10)) {
      console.log(`  ${(entry.bytes / 1024).toFixed(0).padStart(6)} KB  ${entry.url.slice(0, 110)}`)
    }
    console.log(
      '\nThese are usually better to parse than the HTML. If one holds your league ' +
        'data, wire it up in server/yahoo/scrape.ts.\n',
    )
  }

  if (failed.length > 0) {
    console.log('Failed:')
    for (const target of failed) console.log(`  ${target.name}: ${target.error}`)
  }
}

main().catch((err: unknown) => {
  console.error(`\nCapture failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
