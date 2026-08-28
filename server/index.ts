import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import compression from 'compression'
import { config } from './config.js'
import { api, apiErrorHandler } from './routes.js'
import { getStatus } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(here, '..', 'dist')

export function createApp() {
  const app = express()
  app.use(compression())
  app.use(express.json())
  app.use('/api', api)
  app.use('/api', apiErrorHandler)

  // In production the built client is served from the same origin, so there is
  // no CORS surface and nothing to configure.
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }))
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api/')) return next()
      res.sendFile(path.join(distDir, 'index.html'))
    })
  }

  return app
}

function banner(): void {
  const status = getStatus()
  const lines = [
    '',
    '  ╔══════════════════════════════════════════╗',
    '  ║   Ark — Fantasy Football Hub             ║',
    '  ╚══════════════════════════════════════════╝',
    '',
    `  API       http://localhost:${config.port}/api/health`,
    `  Provider  ${status.provider}`,
  ]

  if (status.hasData) {
    lines.push(`  League    ${status.leagueName} (${status.season}, week ${status.currentWeek})`)
    if (status.ageSeconds !== null && config.provider === 'yahoo') {
      lines.push(`  Data      synced ${formatAge(status.ageSeconds)} ago${status.stale ? ' — stale, run `npm run yahoo:sync`' : ''}`)
    }
    if (status.warnings.length > 0) {
      lines.push('', '  Warnings:')
      for (const warning of status.warnings.slice(0, 5)) lines.push(`   ! ${warning}`)
    }
  } else if (config.provider === 'yahoo') {
    lines.push(
      '',
      '  No league data yet. Run:',
      '    npm run yahoo:login   # sign in to Yahoo once',
      '    npm run yahoo:sync    # pull your league',
    )
  }

  lines.push('')
  console.log(lines.join('\n'))
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

// Only listen when run directly, so tests can import createApp() freely.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  createApp().listen(config.port, () => banner())
}
