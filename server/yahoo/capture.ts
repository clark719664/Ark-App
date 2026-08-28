import fs from 'node:fs'
import path from 'node:path'
import type { Page } from 'playwright'
import { config } from '../config.js'
import { openSession, isLoginWall, politeDelay, YahooAuthError } from './browser.js'
import { yahooUrls } from './urls.js'

/**
 * Ground truth collector.
 *
 * Ark can't ship parsers written against a Yahoo page nobody has looked at.
 * This walks the league's pages in a logged-in browser and writes down exactly
 * what came back: the rendered HTML, a screenshot, and every JSON payload the
 * Yahoo frontend fetched for itself. Those captures are what the scrapers in
 * ./scrape.ts are calibrated against, and they're the first place to look when
 * a parser starts returning empty results.
 *
 * Everything lands in .cache/ which is gitignored — captures contain your
 * league, your team names and your session's view of Yahoo.
 */

export interface CaptureTarget {
  name: string
  url: string
}

export interface CapturedRequest {
  url: string
  status: number
  contentType: string
  bytes: number
  file: string
}

export interface CaptureResult {
  targets: Array<{ name: string; url: string; finalUrl: string; ok: boolean; error?: string }>
  json: CapturedRequest[]
  outputDir: string
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80).toLowerCase()
}

/** The pages worth recording for a full picture of a league. */
export function defaultTargets(leagueId: string, teamId?: string, week?: number): CaptureTarget[] {
  const targets: CaptureTarget[] = [
    { name: 'home', url: yahooUrls.home(leagueId) },
    { name: 'standings', url: yahooUrls.standings(leagueId) },
    { name: 'settings', url: yahooUrls.settings(leagueId) },
    { name: 'draftresults', url: yahooUrls.draftResults(leagueId) },
    { name: 'players', url: yahooUrls.players(leagueId) },
  ]
  const scoreboardUrl = yahooUrls.scoreboardCandidates(leagueId, week ?? 1)[0]
  if (scoreboardUrl) targets.push({ name: 'scoreboard', url: scoreboardUrl })
  if (teamId) targets.push({ name: `team-${teamId}`, url: yahooUrls.team(leagueId, teamId) })
  return targets
}

/**
 * Attach a recorder that saves every JSON response the page pulls in. Yahoo's
 * frontend fetches a good deal of its own data this way, and a JSON endpoint is
 * far more durable to parse than rendered markup — so if this turns any up,
 * prefer them over the HTML scrapers.
 */
function recordJsonResponses(page: Page, dir: string, sink: CapturedRequest[]): void {
  let seq = 0
  page.on('response', (response) => {
    void (async () => {
      const contentType = response.headers()['content-type'] ?? ''
      if (!contentType.includes('json')) return
      const url = response.url()
      if (!/yahoo/i.test(url)) return

      try {
        const body = await response.body()
        if (body.length === 0) return
        seq += 1
        const file = `${String(seq).padStart(3, '0')}-${slug(new URL(url).pathname)}.json`
        fs.writeFileSync(path.join(dir, file), body)
        sink.push({
          url,
          status: response.status(),
          contentType,
          bytes: body.length,
          file,
        })
      } catch {
        // Bodies of redirects and aborted requests aren't retrievable. Skip.
      }
    })()
  })
}

export interface CaptureOptions {
  leagueId: string
  teamId?: string
  week?: number
  targets?: CaptureTarget[]
  headed?: boolean
  onProgress?: (message: string) => void
}

export async function captureLeague(opts: CaptureOptions): Promise<CaptureResult> {
  const log = opts.onProgress ?? (() => {})
  const targets = opts.targets ?? defaultTargets(opts.leagueId, opts.teamId, opts.week)

  fs.mkdirSync(config.cache.rawDir, { recursive: true })
  fs.mkdirSync(config.cache.netDir, { recursive: true })

  const session = await openSession({ headed: opts.headed ?? true })
  const json: CapturedRequest[] = []
  const results: CaptureResult['targets'] = []

  try {
    recordJsonResponses(session.page, config.cache.netDir, json)

    for (const target of targets) {
      log(`→ ${target.name}: ${target.url}`)
      try {
        await session.page.goto(target.url, { waitUntil: 'domcontentloaded' })
        // Let client-side fetches fire so the JSON recorder can see them.
        await session.page
          .waitForLoadState('networkidle', { timeout: 10_000 })
          .catch(() => {})

        if (await isLoginWall(session.page)) {
          throw new YahooAuthError(
            'Hit a Yahoo login wall. Run `npm run yahoo:login` first.',
          )
        }

        const html = await session.page.content()
        fs.writeFileSync(path.join(config.cache.rawDir, `${target.name}.html`), html)
        await session.page
          .screenshot({
            path: path.join(config.cache.rawDir, `${target.name}.png`),
            fullPage: true,
          })
          .catch(() => {})

        results.push({
          name: target.name,
          url: target.url,
          finalUrl: session.page.url(),
          ok: true,
        })
        log(`   saved ${target.name}.html (${(html.length / 1024).toFixed(0)} KB)`)
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0]! : String(err)
        results.push({ name: target.name, url: target.url, finalUrl: '', ok: false, error: message })
        log(`   FAILED: ${message}`)
        if (err instanceof YahooAuthError) throw err
      }
      await politeDelay()
    }
  } finally {
    await session.close()
  }

  const index = { capturedAt: new Date().toISOString(), targets: results, json }
  fs.writeFileSync(
    path.join(config.cache.dir, 'capture-index.json'),
    JSON.stringify(index, null, 2),
  )

  return { targets: results, json, outputDir: config.cache.dir }
}
