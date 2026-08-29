import os from 'node:os'

/**
 * Serve the hub on the local network, so a phone can read the draft page.
 *
 * The API refuses to start a sync from anywhere but this machine (see
 * routes.ts), which is what makes binding beyond loopback acceptable: the
 * pages are read-only views of files, and the one endpoint that drives a
 * browser holding a Yahoo session checks the caller.
 */

process.env['HOST'] = process.env['HOST'] ?? '0.0.0.0'

function addresses(): string[] {
  const found: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
    }
  }
  return found
}

// index.ts only listens when it is the entry point, so start it here rather
// than importing it and hoping.
const { createApp } = await import('../index.js')
const { config } = await import('../config.js')

createApp().listen(config.port, config.host, () => {
  console.log(`\nArk is serving on ${config.host}:${config.port}`)
  console.log('Reachable on this network at:')
  for (const address of addresses()) console.log(`  http://${address}:${config.port}/live`)
  console.log('\nSync is refused from anywhere but this machine.\n')
})
