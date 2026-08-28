import fs from 'node:fs'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { config } from '../config.js'

/**
 * Yahoo closed new Fantasy Sports OAuth app registrations, so there is no
 * token-based path to a league any more. Ark instead drives a real browser
 * that the league member logs into by hand, exactly once. The session lives in
 * a persistent profile directory on disk and is reused for every later scrape.
 */

export const YAHOO_FF_HOST = 'https://football.fantasysports.yahoo.com'

/** Where Yahoo sends you when the session has expired. */
const LOGIN_HOST_PATTERN = /(^|\.)login\.yahoo\.com/i

export interface BrowserSession {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

export class YahooAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YahooAuthError'
  }
}

/**
 * Work out which browser binary to drive.
 *
 * Preference order:
 *   1. BROWSER_PATH, if set — an explicit executable.
 *   2. BROWSER_CHANNEL, if set — an installed browser such as real Chrome.
 *      Real Chrome is the most reliable choice for logging into Yahoo.
 *   3. Playwright's bundled Chromium, resolved from PLAYWRIGHT_BROWSERS_PATH
 *      when that layout is present (CI images and sandboxes ship it there).
 */
export function resolveLaunchTarget(): { channel?: string; executablePath?: string } {
  if (config.browser.executablePath) {
    return { executablePath: config.browser.executablePath }
  }
  if (config.browser.channel) {
    return { channel: config.browser.channel }
  }
  const bundled = process.env['PLAYWRIGHT_BROWSERS_PATH']
  if (bundled) {
    const link = path.join(bundled, 'chromium')
    if (fs.existsSync(link)) return { executablePath: link }
  }
  return {}
}

/**
 * Chrome flags. We deliberately do NOT try to defeat bot detection — this is
 * the user's own account and their own league. These flags only keep the
 * automated window from behaving differently than a normal one in ways that
 * break logins (first-run wizards, default-browser prompts, and the automation
 * banner that some sign-in flows react badly to).
 */
const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
]

export interface OpenOptions {
  /** Force a visible window regardless of BROWSER_HEADED. */
  headed?: boolean
}

/** Open (or create) the persistent Yahoo browser profile. */
export async function openSession(opts: OpenOptions = {}): Promise<BrowserSession> {
  fs.mkdirSync(config.browser.profileDir, { recursive: true })

  const headed = opts.headed ?? config.browser.headed
  const target = resolveLaunchTarget()

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(config.browser.profileDir, {
      ...target,
      headless: !headed,
      args: LAUNCH_ARGS,
      viewport: { width: 1440, height: 960 },
      locale: 'en-US',
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  } catch (err) {
    throw describeLaunchFailure(err, target)
  }

  context.setDefaultTimeout(config.browser.timeoutMs)
  context.setDefaultNavigationTimeout(config.browser.timeoutMs)

  const page = context.pages()[0] ?? (await context.newPage())

  return {
    context,
    page,
    close: async () => {
      await context.close().catch(() => {})
    },
  }
}

function describeLaunchFailure(err: unknown, target: ReturnType<typeof resolveLaunchTarget>): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const first = raw.split('\n')[0] ?? raw

  if (target.channel && /channel|executable doesn't exist|not found/i.test(raw)) {
    return new Error(
      `Couldn't start the "${target.channel}" browser.\n` +
        `  - If Chrome isn't installed, set BROWSER_CHANNEL= (empty) in .env to use ` +
        `Playwright's bundled Chromium, then run: npx playwright install chromium\n` +
        `  - Or point BROWSER_PATH at a browser executable.\n` +
        `Original error: ${first}`,
    )
  }
  if (/Executable doesn't exist/i.test(raw)) {
    return new Error(
      `No browser binary available.\n` +
        `  - Run: npx playwright install chromium\n` +
        `  - Or set BROWSER_CHANNEL=chrome in .env to use your installed Chrome.\n` +
        `Original error: ${first}`,
    )
  }
  if (/ProcessSingleton|profile appears to be in use|SingletonLock/i.test(raw)) {
    return new Error(
      `The browser profile at ${config.browser.profileDir} is already in use.\n` +
        `Close any other Ark browser window and try again.\n` +
        `Original error: ${first}`,
    )
  }
  return new Error(`Failed to launch browser: ${first}`)
}

/** True when the current page is a Yahoo sign-in wall rather than real content. */
export async function isLoginWall(page: Page): Promise<boolean> {
  const url = page.url()
  try {
    if (LOGIN_HOST_PATTERN.test(new URL(url).hostname)) return true
  } catch {
    // Not a parseable URL (about:blank etc.) — fall through to DOM checks.
  }
  if (/\/(login|account\/challenge)/i.test(url)) return true

  // Yahoo renders a "Sign in" affordance in the header when logged out.
  const signInCount = await page
    .locator('#login-username, input[name="username"], a[data-ylk*="sign-in"]')
    .count()
    .catch(() => 0)
  return signInCount > 0
}

/**
 * Navigate, then assert we landed on real content rather than a login wall.
 * Throws a YahooAuthError with recovery instructions when the session is gone.
 */
export async function gotoAuthed(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (await isLoginWall(page)) {
    throw new YahooAuthError(
      `Yahoo asked for a login when loading ${url}\n` +
        `Your saved session has expired. Re-authenticate with:\n\n` +
        `    npm run yahoo:login\n`,
    )
  }
}

/**
 * Run an interactive login. Opens a visible window on Yahoo Fantasy and waits
 * for the human to finish signing in (including any 2FA or captcha), then
 * leaves the resulting session in the persistent profile.
 */
export async function interactiveLogin(timeoutMs = 10 * 60_000): Promise<void> {
  const session = await openSession({ headed: true })
  try {
    await session.page.goto(`${YAHOO_FF_HOST}/`, { waitUntil: 'domcontentloaded' })

    const deadline = Date.now() + timeoutMs
    // Poll rather than waiting on a selector: the sign-in flow bounces through
    // several hosts and any single selector would be a guess about which.
    while (Date.now() < deadline) {
      if (!(await isLoginWall(session.page))) {
        // Give Yahoo a moment to finish writing its session cookies.
        await session.page.waitForTimeout(2500)
        if (!(await isLoginWall(session.page))) return
      }
      await session.page.waitForTimeout(1500)
    }
    throw new YahooAuthError('Timed out waiting for the Yahoo login to complete.')
  } finally {
    await session.close()
  }
}

/** Polite pause between page loads, so a sync looks like a person browsing. */
export function politeDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, config.browser.delayMs))
}
