import fs from 'node:fs'
import path from 'node:path'
import { isDownloaded } from '../fetch.js'
import { loadInjuries, loadPlayers, loadWeeklyStats } from '../load.js'
import { measureVolatility, measureVolatilityByTier } from '../analysis/volatility.js'
import { measureDirectionalPersistence, measurePersistence } from '../analysis/regression.js'
import { measureAgeCurves, measureBreakoutFactors } from '../analysis/careers.js'
import { measureByInjuryType, measureReturns } from '../analysis/injuries.js'

/**
 * Turn 26 seasons of NFL data into the handful of constants the app actually
 * needs at runtime.
 *
 * The raw data is hundreds of megabytes and stays out of the repository. What
 * gets committed is this small derived file, so the app ships with measured
 * numbers instead of guessed ones and does not need the dataset to run.
 */

const OUTPUT = path.resolve(process.cwd(), 'data', 'derived', 'football.json')

function main(): void {
  if (!isDownloaded()) {
    console.error('\nNo data found. Run `npm run data:fetch` first.\n')
    process.exitCode = 1
    return
  }

  console.log('\nLoading…')
  const stats = loadWeeklyStats()
  const players = loadPlayers()
  const injurySeasons = Array.from({ length: 20 }, (_, i) => 2009 + i)
  const reports = loadInjuries(injurySeasons)

  console.log(`  ${stats.length.toLocaleString()} weekly player rows`)
  console.log(`  ${players.size.toLocaleString()} player biographies`)
  console.log(`  ${reports.length.toLocaleString()} injury report rows`)

  const seasons = [...new Set(stats.map((s) => s.season))].sort((a, b) => a - b)

  console.log('\nMeasuring…')
  const volatility = measureVolatility(stats)
  const volatilityByTier = measureVolatilityByTier(stats)
  const persistence = measurePersistence(stats)
  const directional = measureDirectionalPersistence(stats)
  const ageCurves = measureAgeCurves(stats, players)
  const breakouts = measureBreakoutFactors(stats, players)
  const injuryReturns = measureReturns(stats, reports)
  const injuryTypes = measureByInjuryType(stats, reports)

  const derived = {
    generatedAt: new Date().toISOString(),
    source: 'nflverse-data, https://github.com/nflverse/nflverse-data',
    seasons: { from: seasons[0] ?? 0, to: seasons[seasons.length - 1] ?? 0, count: seasons.length },
    weeklyRows: stats.length,

    volatility: {
      note:
        'Weekly standard deviation fitted on weekly mean: sd = intercept + slope x mean. ' +
        'A constant coefficient of variation forces this line through the origin, which the ' +
        'data does not support — the intercepts are large and positive.',
      byPosition: Object.fromEntries(
        volatility.map((v) => [
          v.position,
          {
            slope: round(v.slope, 4),
            intercept: round(v.intercept, 3),
            medianCv: round(v.medianCv, 4),
            rSquared: round(v.rSquared, 3),
            playerSeasons: v.playerSeasons,
          },
        ]),
      ),
      byTier: volatilityByTier.map((t) => ({
        position: t.position,
        tier: t.tier,
        medianCv: round(t.medianCv, 3),
        playerSeasons: t.playerSeasons,
      })),
    },

    persistence: {
      note:
        'Fraction of a deviation from a player\'s own baseline that survives into the next ' +
        'three games. Hot and cold streaks behave differently, so they are reported separately.',
      byPosition: Object.fromEntries(
        persistence.map((p) => [
          p.position,
          { persistence: round(p.persistence, 4), observations: p.observations },
        ]),
      ),
      hot: {
        persistence: round(directional.find((d) => d.direction === 'hot')?.persistence ?? 0, 4),
        observations: directional.find((d) => d.direction === 'hot')?.observations ?? 0,
      },
      cold: {
        persistence: round(directional.find((d) => d.direction === 'cold')?.persistence ?? 0, 4),
        observations: directional.find((d) => d.direction === 'cold')?.observations ?? 0,
      },
    },

    ageCurves: {
      note:
        'Median year-over-year change for the same player, which controls for survivorship. ' +
        'A cross-sectional curve would show receivers peaking at 35 purely because only good ' +
        'ones are still playing.',
      points: ageCurves.map((point) => ({
        position: point.position,
        age: point.age,
        medianChange: round(point.medianChange, 2),
        medianPpg: round(point.medianPpg, 2),
        playerSeasons: point.playerSeasons,
      })),
    },

    breakouts: {
      note:
        'A breakout is a gain of at least 4 points per game that also clears 10 points per ' +
        'game, measured against signals visible beforehand.',
      factors: breakouts.map((factor) => ({
        factor: factor.factor,
        description: factor.description,
        withSignal: round(factor.withSignal, 4),
        withoutSignal: round(factor.withoutSignal, 4),
        lift: round(factor.lift, 3),
        sample: factor.sampleWith,
      })),
    },

    injuryReturns: {
      note:
        'Production after returning, as a fraction of the three games before the absence.',
      byWeeksMissed: injuryReturns.map((profile) => ({
        weeksMissed: profile.weeksMissed,
        firstGameRatio: round(profile.firstGameRatio, 3),
        firstThreeRatio: round(profile.firstThreeRatio, 3),
        returns: profile.returns,
      })),
      byType: injuryTypes.map((type) => ({
        injury: type.injury,
        firstThreeRatio: round(type.firstThreeRatio, 3),
        medianWeeksMissed: type.medianWeeksMissed,
        returns: type.returns,
      })),
    },
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, `${JSON.stringify(derived, null, 2)}\n`)

  console.log(`\nWrote ${OUTPUT}`)
  console.log(`  ${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB, committed to the repo\n`)

  summarise(derived)
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function summarise(derived: ReturnType<typeof buildForTypes>): void {
  console.log('Headlines:')
  for (const [position, v] of Object.entries(derived.volatility.byPosition)) {
    console.log(
      `  ${position.padEnd(3)} sd = ${v.intercept.toFixed(2)} + ${v.slope.toFixed(3)} x mean` +
        `   (median CV ${v.medianCv.toFixed(2)}, n=${v.playerSeasons})`,
    )
  }
  console.log(
    `  hot streaks persist ${(derived.persistence.hot.persistence * 100).toFixed(0)}%, ` +
      `cold streaks ${(derived.persistence.cold.persistence * 100).toFixed(0)}%`,
  )
  console.log('')
}

// Only for the type of the summary argument above.
declare function buildForTypes(): {
  volatility: {
    byPosition: Record<string, { slope: number; intercept: number; medianCv: number; playerSeasons: number }>
  }
  persistence: { hot: { persistence: number }; cold: { persistence: number } }
}

main()
