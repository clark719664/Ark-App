import { config } from '../config.js'
import { interactiveLogin } from '../yahoo/browser.js'

/**
 * One-time interactive sign-in. Opens a real browser window; you log into
 * Yahoo yourself, including any 2FA. The session is kept in the profile
 * directory and reused by every later sync.
 */
async function main(): Promise<void> {
  console.log(`
Opening a browser window for Yahoo.

  1. Sign in to your Yahoo account.
  2. Once your fantasy page loads, this will detect it and close automatically.

Your session is stored in ${config.browser.profileDir}
Treat that directory like a password — anyone with it can act as you on Yahoo.
`)

  await interactiveLogin()
  console.log('\nSigned in. Next: npm run yahoo:sync\n')
}

main().catch((err: unknown) => {
  console.error(`\nLogin failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
