import type {
  DraftPick, League, LeagueSnapshot, Matchup, Player, PlayerPosition,
  RosterEntry, Team,
} from '../../shared/types.js'

/**
 * A complete, deterministic fake league.
 *
 * This exists so the hub, the analytics engine and the UI can all be developed
 * and tested without touching Yahoo — and so a new user can see what Ark does
 * before wiring up their own league. Player names are invented on purpose: the
 * numbers here are simulated, and attaching them to real players would be
 * misleading.
 */

/** Deterministic PRNG (mulberry32) so the demo league is identical every run. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller normal draw, for score distributions that look like football. */
function normal(rng: () => number, mean: number, stdDev: number): number {
  const u = Math.max(rng(), Number.EPSILON)
  const v = rng()
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const TEAM_NAMES = [
  'Gridiron Gulls', 'Third Down Thunder', 'Brunch Money', 'Play Action Heroes',
  'The Hurry Up', 'Couch Commanders', 'Red Zone Rebels', 'Hail Mary Hooligans',
  'Pylon Pirates', 'Blitz Brigade', 'Two Minute Warning', 'Fourth and Goal',
]

const MANAGERS = [
  'Riley', 'Dana', 'Sam', 'Alex', 'Jordan', 'Casey',
  'Morgan', 'Avery', 'Quinn', 'Reese', 'Emerson', 'Rowan',
]

const NFL_TEAMS = [
  'ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN',
  'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA',
  'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB',
  'TEN', 'WAS',
]

const FIRST_NAMES = [
  'Marcus', 'Dev', 'Jalen', 'Trey', 'Cam', 'Kai', 'Zion', 'Elijah', 'Rashad',
  'Bo', 'Nico', 'Tariq', 'Silas', 'Emory', 'Deacon', 'Jules', 'Brody', 'Xavier',
  'Isaiah', 'Ronan', 'Amari', 'Cole', 'Dante', 'Finn', 'Gage', 'Hollis',
]

const LAST_NAMES = [
  'Whitfield', 'Ramsey', 'Okafor', 'Delgado', 'Brennan', 'Sinclair', 'Vance',
  'Ashford', 'Mercado', 'Kingsley', 'Tavares', 'Holloway', 'Boone', 'Castellan',
  'Rivas', 'Pruitt', 'Nakamura', 'Osei', 'Lindqvist', 'Barrera', 'Cardoso',
  'Fontaine', 'Grady', 'Halvorsen', 'Ibarra', 'Jessup',
]

/** Starting slots plus bench, matching a common Yahoo default. */
const ROSTER_SLOTS = [
  { slot: 'QB', count: 1 },
  { slot: 'RB', count: 2 },
  { slot: 'WR', count: 3 },
  { slot: 'TE', count: 1 },
  { slot: 'W/R/T', count: 1 },
  { slot: 'K', count: 1 },
  { slot: 'DEF', count: 1 },
  { slot: 'BN', count: 6 },
]

/** How many players of each position the pool holds, and how they score. */
const POSITION_PROFILE: Array<{
  position: PlayerPosition
  count: number
  meanPpg: number
  spread: number
}> = [
  { position: 'QB', count: 32, meanPpg: 17, spread: 5 },
  { position: 'RB', count: 64, meanPpg: 11, spread: 5 },
  { position: 'WR', count: 80, meanPpg: 11, spread: 4.5 },
  { position: 'TE', count: 32, meanPpg: 8, spread: 3.5 },
  { position: 'K', count: 32, meanPpg: 8, spread: 2 },
  { position: 'DEF', count: 32, meanPpg: 7, spread: 3 },
]

const NUM_TEAMS = 12
const REGULAR_SEASON_WEEKS = 14
const CURRENT_WEEK = 11
const PLAYOFF_TEAMS = 6

/**
 * Round-robin pairings via the circle method: fix team 0 and rotate the rest.
 * With 12 teams this gives 11 unique weeks before the schedule repeats.
 */
export function roundRobin(teamCount: number, weeks: number): Array<Array<[number, number]>> {
  const rotation = Array.from({ length: teamCount }, (_, i) => i)
  const schedule: Array<Array<[number, number]>> = []

  for (let week = 0; week < weeks; week += 1) {
    const pairings: Array<[number, number]> = []
    for (let i = 0; i < teamCount / 2; i += 1) {
      const home = rotation[i]
      const away = rotation[teamCount - 1 - i]
      if (home === undefined || away === undefined) continue
      // Alternate home/away by week so nobody is always the home side.
      pairings.push(week % 2 === 0 ? [home, away] : [away, home])
    }
    schedule.push(pairings)

    // Rotate everything except the first entry.
    const fixed = rotation[0]!
    const rest = rotation.slice(1)
    const last = rest.pop()!
    rotation.splice(0, rotation.length, fixed, last, ...rest)
  }

  return schedule
}

function buildPlayers(rng: () => number): Player[] {
  const players: Player[] = []
  let id = 1

  for (const profile of POSITION_PROFILE) {
    for (let i = 0; i < profile.count; i += 1) {
      // Talent decays down the list, so the pool has a real top and tail.
      const tier = i / profile.count
      const ppg = Math.max(1, profile.meanPpg * (1.55 - tier * 1.25) + normal(rng, 0, 1.4))
      const gamesPlayed = CURRENT_WEEK - 1
      const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]!
      const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]!

      const injuryRoll = rng()
      const injury =
        injuryRoll > 0.94
          ? { code: 'O', label: 'Out' }
          : injuryRoll > 0.85
            ? { code: 'Q', label: 'Questionable' }
            : undefined

      const player: Player = {
        id: `demo-${id}`,
        name: profile.position === 'DEF' ? `${NFL_TEAMS[i % NFL_TEAMS.length]} Defense` : `${first} ${last}`,
        position: profile.position,
        nflTeam: NFL_TEAMS[Math.floor(rng() * NFL_TEAMS.length)]!,
        byeWeek: 5 + Math.floor(rng() * 9),
        ownerTeamId: null,
        rank: id,
        points: {
          season: Number((ppg * gamesPlayed).toFixed(1)),
          average: Number(ppg.toFixed(1)),
          lastWeek: Number(Math.max(0, normal(rng, ppg, ppg * 0.45)).toFixed(1)),
          projected: Number(Math.max(0, normal(rng, ppg, ppg * 0.15)).toFixed(1)),
        },
        ownership: {
          percentOwned: Number(Math.min(100, Math.max(0, 100 - tier * 115 + normal(rng, 0, 6))).toFixed(0)),
          percentStarted: Number(Math.min(100, Math.max(0, 95 - tier * 130 + normal(rng, 0, 8))).toFixed(0)),
        },
        ...(injury ? { injury } : {}),
      }
      players.push(player)
      id += 1
    }
  }

  return players
}

/** Deal the best available players out round by round, snake order. */
function buildRosters(
  teams: Team[],
  players: Player[],
  rng: () => number,
): { rosters: Record<string, RosterEntry[]>; draft: DraftPick[] } {
  const slotPlan = ROSTER_SLOTS.flatMap(({ slot, count }) => Array.from({ length: count }, () => slot))
  const rosters: Record<string, RosterEntry[]> = {}
  const draft: DraftPick[] = []
  for (const team of teams) rosters[team.id] = []

  const available = [...players].sort(
    (a, b) => (b.points?.average ?? 0) - (a.points?.average ?? 0),
  )

  const take = (want: PlayerPosition | 'ANY'): Player | undefined => {
    const index = available.findIndex((p) => {
      if (p.ownerTeamId) return false
      if (want === 'ANY') return ['RB', 'WR', 'TE'].includes(p.position)
      return p.position === want
    })
    if (index === -1) return undefined
    return available.splice(index, 1)[0]
  }

  let overall = 1
  for (const [roundIndex, slot] of slotPlan.entries()) {
    const round = roundIndex + 1
    // Snake: even rounds run in reverse order.
    const order = round % 2 === 1 ? teams : [...teams].reverse()

    for (const [pickIndex, team] of order.entries()) {
      const want: PlayerPosition | 'ANY' =
        slot === 'W/R/T' || slot === 'BN' ? 'ANY' : (slot as PlayerPosition)
      const player = take(want) ?? take('ANY')
      if (!player) continue

      player.ownerTeamId = team.id
      const isStarter = slot !== 'BN'
      rosters[team.id]!.push({
        slot,
        starter: isStarter,
        player,
        points: player.points?.lastWeek ?? 0,
        projected: player.points?.projected ?? 0,
      })

      draft.push({
        overall,
        round,
        pickInRound: pickIndex + 1,
        teamId: team.id,
        playerId: player.id,
        playerName: player.name,
        position: player.position,
        nflTeam: player.nflTeam,
      })
      overall += 1
    }
  }

  // A few late-season waiver adds, so the draft board and rosters disagree the
  // way real ones do.
  for (const team of teams) {
    if (rng() > 0.55) continue
    const pickup = available.find((p) => !p.ownerTeamId)
    if (!pickup) continue
    pickup.ownerTeamId = team.id
    rosters[team.id]!.push({
      slot: 'BN',
      starter: false,
      player: pickup,
      points: pickup.points?.lastWeek ?? 0,
      projected: pickup.points?.projected ?? 0,
    })
  }

  return { rosters, draft }
}

export function buildDemoSnapshot(seed = 20260828): LeagueSnapshot {
  const rng = makeRng(seed)

  // Each team gets a latent strength, which drives both weekly scores and how
  // the standings shake out.
  const strengths = Array.from({ length: NUM_TEAMS }, () => normal(rng, 112, 9))

  const teams: Team[] = TEAM_NAMES.map((name, i) => ({
    id: String(i + 1),
    name,
    abbrev: name.split(' ').map((w) => w[0]).join('').slice(0, 4).toUpperCase(),
    managerName: MANAGERS[i]!,
    record: { wins: 0, losses: 0, ties: 0 },
    pointsFor: 0,
    pointsAgainst: 0,
    movesMade: Math.floor(rng() * 30),
    tradesMade: Math.floor(rng() * 3),
    isMine: i === 0,
  }))

  const schedule = roundRobin(NUM_TEAMS, REGULAR_SEASON_WEEKS)
  const matchups: Matchup[] = []

  // Generate the full regular season, not just the played part: playoff odds
  // and schedule strength both need to know who everyone still has to face.
  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week += 1) {
    const pairings = schedule[(week - 1) % schedule.length] ?? []
    for (const [homeIdx, awayIdx] of pairings) {
      const homeTeam = teams[homeIdx]!
      const awayTeam = teams[awayIdx]!
      const homeScore = Number(Math.max(40, normal(rng, strengths[homeIdx]!, 21)).toFixed(2))
      const awayScore = Number(Math.max(40, normal(rng, strengths[awayIdx]!, 21)).toFixed(2))

      const final = week < CURRENT_WEEK
      const inProgress = week === CURRENT_WEEK
      const played = final || inProgress

      if (final) {
        homeTeam.pointsFor += homeScore
        homeTeam.pointsAgainst += awayScore
        awayTeam.pointsFor += awayScore
        awayTeam.pointsAgainst += homeScore
        if (homeScore > awayScore) {
          homeTeam.record.wins += 1
          awayTeam.record.losses += 1
        } else if (awayScore > homeScore) {
          awayTeam.record.wins += 1
          homeTeam.record.losses += 1
        } else {
          homeTeam.record.ties += 1
          awayTeam.record.ties += 1
        }
      }

      matchups.push({
        week,
        home: {
          teamId: homeTeam.id,
          score: final ? homeScore : inProgress ? Number((homeScore * 0.6).toFixed(2)) : 0,
          ...(played ? { projected: homeScore } : {}),
        },
        away: {
          teamId: awayTeam.id,
          score: final ? awayScore : inProgress ? Number((awayScore * 0.6).toFixed(2)) : 0,
          ...(played ? { projected: awayScore } : {}),
        },
        winnerTeamId: final ? (homeScore > awayScore ? homeTeam.id : awayScore > homeScore ? awayTeam.id : null) : null,
        final,
        ...(week > REGULAR_SEASON_WEEKS ? { isPlayoff: true } : {}),
      })
    }
  }

  for (const team of teams) {
    team.pointsFor = Number(team.pointsFor.toFixed(2))
    team.pointsAgainst = Number(team.pointsAgainst.toFixed(2))
    team.streak = buildStreak(team.id, matchups)
  }

  // Standings order: wins first, points for as the tiebreak.
  const ranked = [...teams].sort(
    (a, b) => b.record.wins - a.record.wins || b.pointsFor - a.pointsFor,
  )
  ranked.forEach((team, i) => {
    team.rank = i + 1
    team.waiverPriority = NUM_TEAMS - i
  })

  const players = buildPlayers(rng)
  const { rosters, draft } = buildRosters(teams, players, rng)

  const league: League = {
    id: 'demo',
    provider: 'demo',
    name: 'The Demo League',
    season: new Date().getUTCFullYear(),
    numTeams: NUM_TEAMS,
    currentWeek: CURRENT_WEEK,
    regularSeasonWeeks: REGULAR_SEASON_WEEKS,
    playoffTeams: PLAYOFF_TEAMS,
    scoringType: 'Head-to-Head Points',
    pprType: 'half-ppr',
    isAuction: false,
    rosterSlots: ROSTER_SLOTS,
  }

  return {
    league,
    teams,
    matchups,
    rosters,
    players,
    draft,
    fetchedAt: new Date().toISOString(),
    warnings: [
      'This is generated demo data, not a real league. Set FF_PROVIDER=yahoo in .env to use yours.',
    ],
  }
}

function buildStreak(teamId: string, matchups: Matchup[]): string {
  const results = matchups
    .filter((m) => m.final && (m.home.teamId === teamId || m.away.teamId === teamId))
    .sort((a, b) => b.week - a.week)
    .map((m) => (m.winnerTeamId === null ? 'T' : m.winnerTeamId === teamId ? 'W' : 'L'))

  const first = results[0]
  if (!first) return '—'
  let run = 0
  for (const result of results) {
    if (result !== first) break
    run += 1
  }
  return `${first}${run}`
}
