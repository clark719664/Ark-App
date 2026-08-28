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
