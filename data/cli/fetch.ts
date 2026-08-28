import { currentSeason, fetchAll } from '../fetch.js'

/**
 * Pull the open NFL dataset down. Everything else in data/ reads from the local
 * copy, so this is the only step that touches the network.
 */
async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  console.log(`\nDownloading NFL data through ${currentSeason()}…\n`)

  await fetchAll({ force, onProgress: (message) => console.log(message) })

  console.log('\nDone. Run `npm run data:analyse` to rebuild the derived constants.\n')
}

main().catch((err: unknown) => {
  console.error(`\nDownload failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
