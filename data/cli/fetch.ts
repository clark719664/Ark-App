import { currentSeason, fetchAll } from '../fetch.js'
import { verifyData } from '../verify.js'

/**
 * Pull the open NFL dataset down. Everything else in data/ reads from the local
 * copy, so this is the only step that touches the network.
 */
async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  console.log(`\nDownloading NFL data through ${currentSeason()}...\n`)

  await fetchAll({ force, onProgress: (message) => console.log(message) })

  // Downloading is not the same as having the data. A file can arrive whole and
  // still be the wrong shape, and every consumer of it then produces something
  // that looks right, so the check belongs here where the fix is a re-download
  // rather than three steps later where the symptom is a plausible board.
  const season = currentSeason()
  const reports = verifyData(season)
  const bad = reports.filter((report) => !report.ok)

  console.log('\nVerifying:')
  for (const report of reports) {
    console.log(`  ${report.ok ? '[ ok ]' : '[FAIL]'} ${report.file.padEnd(26)} ${report.detail}`)
  }

  if (bad.length > 0) {
    console.error(
      `\n${bad.length} file(s) are not usable. A board built from these would ` +
        'score every player too low and still look complete.\n' +
        'Try: npm run data:fetch -- --force\n',
    )
    process.exitCode = 1
    return
  }

  console.log('\nDone. Run `npm run data:analyse` to rebuild the derived constants.\n')
}

main().catch((err: unknown) => {
  console.error(`\nDownload failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
