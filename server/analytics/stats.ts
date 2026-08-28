/** Small statistics helpers shared by the analytics modules. */

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** Sample standard deviation. Returns 0 for fewer than two observations. */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

/**
 * Scale values onto 0-100 by their position between the league min and max.
 * A flat league (everyone identical) maps to 50 rather than dividing by zero.
 */
export function scaleToPercent(values: number[]): number[] {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return values.map(() => 50)
  }
  return values.map((v) => ((v - min) / (max - min)) * 100)
}

/** Same as scaleToPercent but inverted: the lowest input scores 100. */
export function scaleToPercentInverted(values: number[]): number[] {
  return scaleToPercent(values.map((v) => -v))
}

export function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/**
 * Normal draw via Box-Muller. Used to simulate a team's weekly score from its
 * observed mean and spread.
 */
export function normalSample(rng: () => number, mu: number, sigma: number): number {
  const u = Math.max(rng(), Number.EPSILON)
  const v = rng()
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Deterministic PRNG so a given snapshot always simulates to the same odds. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Standard normal CDF, via Abramowitz & Stegun 7.1.26 applied to erf.
 * Accurate to about 1e-7, which is far beyond what a fantasy projection
 * deserves and cheap enough to call in an inner loop.
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2

  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)

  return 0.5 * (1 + sign * y)
}

/**
 * P(A beats B) when both scores are normal and independent.
 *
 * Two things fall out of this that matter for lineup decisions. When the means
 * are level, variance is irrelevant. When you are behind, *more* variance
 * raises your chance of winning — which is the mathematical form of the
 * long-standing advice to start the boom-or-bust player when you need a
 * miracle, and the steady one when you are protecting a lead.
 */
export function probabilityOfWinning(
  meanA: number,
  varianceA: number,
  meanB: number,
  varianceB: number,
): number {
  const spread = Math.sqrt(varianceA + varianceB)
  if (spread <= 0) return meanA === meanB ? 0.5 : meanA > meanB ? 1 : 0
  return normalCdf((meanA - meanB) / spread)
}

/**
 * A reusable block of standard normal draws.
 *
 * Comparing two scenarios by running two independent simulations buries the
 * difference in simulation noise: with 3,000 seasons, the noise on each
 * estimate is around a percentage point, which is the same size as the effect
 * being measured. Feeding both scenarios the *same* draws — common random
 * numbers — cancels that noise almost entirely, because the two runs differ
 * only by the thing that was actually changed.
 */
export class RandomBlock {
  private readonly values: Float64Array

  constructor(size: number, seed: number) {
    const rng = makeRng(seed)
    this.values = new Float64Array(size)
    for (let i = 0; i < size; i += 1) this.values[i] = normalSample(rng, 0, 1)
  }

  /** Draw at a fixed index, so the same slot means the same draw every run. */
  at(index: number): number {
    return this.values[index % this.values.length] ?? 0
  }

  get size(): number {
    return this.values.length
  }
}
