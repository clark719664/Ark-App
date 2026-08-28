import type { PlayerPosition } from '../shared/types.js'

/**
 * The simulated world.
 *
 * The point of this harness is to find out whether Ark's recommendations
 * actually win games, so the world has to be able to prove them wrong. Two
 * design choices matter more than anything else here:
 *
 * 1. Agents never see the truth. Every player has a hidden talent level and a
 *    hidden volatility; what agents get is a noisy weekly projection. A model
 *    that only looks good when handed perfect inputs is not a model.
 *
 * 2. The world is deliberately misspecified against Ark's own assumptions.
 *    Ark's risk model assumes normally distributed scores and uses fixed
 *    per-position volatility priors. This world generates right-skewed scores
 *    from a gamma distribution, and draws each player's true volatility around
 *    position means that do not match Ark's priors. So Ark is working with
 *    approximately-right assumptions, which is the honest case — if it only
 *    won when its own assumptions were exactly true, that would prove nothing.
 */

export interface TruePlayer {
  id: string
  name: string
  position: PlayerPosition
  nflTeam: string
  byeWeek: number
  /** Hidden: expected points in a healthy week. */
  trueMean: number
  /** Hidden: coefficient of variation of that player's weekly score. */
  trueCv: number
}

export type InjuryState =
  | { kind: 'healthy' }
  /** Will probably play. Agents see a "Q" and have to decide. */
  | { kind: 'questionable'; playProbability: number }
  /** Out for a set number of weeks, including this one. */
  | { kind: 'out'; weeksRemaining: number }

export interface PlayerState {
  injury: InjuryState
  /** Rolling estimate agents can see, refreshed weekly. */
  projection: number
  /** Actual points scored so far this season — what a real platform reports. */
  seasonPoints: number
  gamesPlayed: number
}

/**
 * Weekly spread, from the measured fit in data/derived/football.json:
 *
 *     sd = intercept + slope x mean
 *
 * The simulation used to invent these too, which made the whole exercise a
 * test of one guess against another. They are now the real relationship, with
 * per-player noise around it — so Ark faces a world whose *shape* it models
 * correctly and whose individual players it does not, which is the situation a
 * real manager is actually in.
 *
 * Misspecification is preserved where it belongs: scores are drawn from a
 * right-skewed gamma rather than the normal Ark's risk model assumes, and each
 * player's spread is drawn around the fitted line rather than sitting on it.
 */
const SPREAD_MODEL: Record<string, { intercept: number; slope: number }> = {
  QB: { intercept: 5.26, slope: 0.131 },
  RB: { intercept: 2.77, slope: 0.349 },
  WR: { intercept: 2.4, slope: 0.401 },
  TE: { intercept: 1.58, slope: 0.47 },
  K: { intercept: 3.0, slope: 0.45 },
  DEF: { intercept: 3.0, slope: 0.45 },
}

/** How much each player's own spread strays from the fitted line. */
const SPREAD_NOISE = 0.18

/** How wrong a weekly projection is, as a fraction of true talent. */
const PROJECTION_NOISE = 0.18

const WEEKLY_INJURY_RATE = 0.035
const QUESTIONABLE_RATE = 0.09

export interface Rng {
  (): number
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function normal(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(rng(), Number.EPSILON)
  const v = rng()
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * Gamma sample via Marsaglia and Tsang. Used because real fantasy weeks are
 * right-skewed and floored at zero — a normal draw would produce negative
 * scores and understate how often a player quietly busts.
 */
export function gamma(rng: Rng, shape: number, scale: number): number {
  if (shape < 1) {
    // Boost low shapes into the valid range and correct afterwards.
    return gamma(rng, shape + 1, scale) * Math.pow(Math.max(rng(), Number.EPSILON), 1 / shape)
  }

  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)

  for (let attempt = 0; attempt < 200; attempt += 1) {
    let x = 0
    let v = 0
    do {
      x = normal(rng, 0, 1)
      v = 1 + c * x
    } while (v <= 0)

    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale
  }
  return d * scale
}

/** A player's actual score for one week, given they are playing. */
export function drawScore(rng: Rng, player: TruePlayer): number {
  if (player.trueMean <= 0) return 0
  const shape = 1 / (player.trueCv * player.trueCv)
  return gamma(rng, shape, player.trueMean / shape)
}

const FIRST_NAMES = [
  'Marcus', 'Dev', 'Jalen', 'Trey', 'Cam', 'Kai', 'Zion', 'Elijah', 'Rashad', 'Bo',
  'Nico', 'Tariq', 'Silas', 'Emory', 'Deacon', 'Jules', 'Brody', 'Xavier', 'Isaiah',
  'Ronan', 'Amari', 'Cole', 'Dante', 'Finn', 'Gage', 'Hollis', 'Idris', 'Jonah',
]
const LAST_NAMES = [
  'Whitfield', 'Ramsey', 'Okafor', 'Delgado', 'Brennan', 'Sinclair', 'Vance', 'Ashford',
  'Mercado', 'Kingsley', 'Tavares', 'Holloway', 'Boone', 'Castellan', 'Rivas', 'Pruitt',
  'Nakamura', 'Osei', 'Lindqvist', 'Barrera', 'Cardoso', 'Fontaine', 'Grady', 'Ibarra',
]
const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG',
  'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS',
]

/** Position pool sizes and talent curves. */
const POOL: Array<{ position: PlayerPosition; count: number; top: number; floor: number }> = [
  { position: 'QB', count: 30, top: 26, floor: 11 },
  { position: 'RB', count: 62, top: 21, floor: 5 },
  { position: 'WR', count: 78, top: 20, floor: 5 },
  { position: 'TE', count: 30, top: 15, floor: 3 },
  { position: 'K', count: 26, top: 11, floor: 6 },
  { position: 'DEF', count: 26, top: 12, floor: 4 },
]

export function buildPlayerPool(rng: Rng): TruePlayer[] {
  const players: TruePlayer[] = []
  let id = 1

  for (const group of POOL) {
    for (let i = 0; i < group.count; i += 1) {
      // Talent decays down the list, with noise so rank is not destiny.
      const tier = i / group.count
      const base = group.top - (group.top - group.floor) * Math.pow(tier, 0.85)
      const trueMean = Math.max(1, base + normal(rng, 0, 1.3))

      // Spread follows the measured line for the position, then each player
      // is scattered around it so no two are exactly as predictable.
      const model = SPREAD_MODEL[group.position] ?? { intercept: 3, slope: 0.45 }
      const fittedSd = model.intercept + model.slope * trueMean
      const playerSd = Math.max(1, fittedSd * (1 + normal(rng, 0, SPREAD_NOISE)))
      const trueCv = Math.max(0.15, playerSd / trueMean)

      const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!
      const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]!
      const nflTeam = NFL_TEAMS[Math.floor(rng() * NFL_TEAMS.length)]!

      players.push({
        id: `p${id}`,
        name: group.position === 'DEF' ? `${nflTeam} Defense` : `${first} ${last}`,
        position: group.position,
        nflTeam,
        byeWeek: 5 + Math.floor(rng() * 9),
        trueMean,
        trueCv,
      })
      id += 1
    }
  }

  return players
}

/**
 * Refresh what agents can see for a week: a noisy projection, and an injury
 * designation that is itself only a hint about whether the player will play.
 */
export function advanceWeek(
  rng: Rng,
  players: TruePlayer[],
  state: Map<string, PlayerState>,
  week: number,
): void {
  for (const player of players) {
    const current = state.get(player.id) ?? {
      injury: { kind: 'healthy' } as InjuryState,
      projection: 0,
      seasonPoints: 0,
      gamesPlayed: 0,
    }

    let injury = current.injury
    if (injury.kind === 'out') {
      const remaining = injury.weeksRemaining - 1
      injury = remaining > 0 ? { kind: 'out', weeksRemaining: remaining } : { kind: 'healthy' }
    } else {
      const roll = rng()
      if (roll < WEEKLY_INJURY_RATE) {
        injury = { kind: 'out', weeksRemaining: 1 + Math.floor(rng() * 4) }
      } else if (roll < WEEKLY_INJURY_RATE + QUESTIONABLE_RATE) {
        // A questionable tag is a genuine coin-weighted decision, not a formality.
        injury = { kind: 'questionable', playProbability: 0.55 + rng() * 0.35 }
      } else {
        injury = { kind: 'healthy' }
      }
    }

    const onBye = player.byeWeek === week
    const projection = onBye
      ? 0
      : Math.max(0, player.trueMean * (1 + normal(rng, 0, PROJECTION_NOISE)))

    state.set(player.id, {
      injury,
      projection,
      seasonPoints: current.seasonPoints,
      gamesPlayed: current.gamesPlayed,
    })
  }
}

/** Whether a player actually takes the field, resolving questionable tags. */
export function willPlay(rng: Rng, player: TruePlayer, state: PlayerState, week: number): boolean {
  if (player.byeWeek === week) return false
  if (state.injury.kind === 'out') return false
  if (state.injury.kind === 'questionable') return rng() < state.injury.playProbability
  return true
}

/** Record an actual result so agents can see a season average forming. */
export function recordResult(
  state: Map<string, PlayerState>,
  playerId: string,
  points: number,
  played: boolean,
): void {
  const current = state.get(playerId)
  if (!current) return
  state.set(playerId, {
    ...current,
    seasonPoints: current.seasonPoints + points,
    gamesPlayed: current.gamesPlayed + (played ? 1 : 0),
  })
}
