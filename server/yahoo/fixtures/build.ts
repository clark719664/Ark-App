/**
 * Synthetic Yahoo-shaped pages.
 *
 * Ark's author cannot reach a real Yahoo league, so the scrapers cannot be
 * tested against real markup here. These fixtures stand in: they reproduce the
 * *structure* Yahoo uses — data tables with header rows, team links carrying
 * the team id in the href, player cells packing name, team, position and injury
 * status into one blob — without claiming to be byte-identical to the real page.
 *
 * What they genuinely prove is that the parsing strategy works and, more
 * importantly, that it fails loudly in the ways it is supposed to. Each builder
 * takes options so a test can rename, reorder or delete a column and assert on
 * what happens.
 *
 * To calibrate against the real thing: run `npm run yahoo:capture`, then point
 * a test at the saved HTML in .cache/raw/ instead of a builder here.
 */

export const LEAGUE_ID = '123456'

export interface StandingsRowSpec {
  teamId: string
  name: string
  manager: string
  record: string
  pointsFor: number
  pointsAgainst: number
  streak: string
}

export const DEFAULT_STANDINGS: StandingsRowSpec[] = [
  { teamId: '1', name: 'Gridiron Gulls', manager: 'Riley', record: '8-2-0', pointsFor: 1266.9, pointsAgainst: 1070.5, streak: 'W2' },
  { teamId: '2', name: 'Brunch Money', manager: 'Dana', record: '6-4-0', pointsFor: 1092.2, pointsAgainst: 1069.4, streak: 'L1' },
  { teamId: '3', name: 'Pylon Pirates', manager: 'Sam', record: '2-8-0', pointsFor: 983.0, pointsAgainst: 1199.7, streak: 'L6' },
]

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
  <nav><a href="/f1/${LEAGUE_ID}">League</a></nav>
  <div id="league-name">Test League</div>
  <p>Week 11 of 14</p>
  ${body}
  </body></html>`
}

export interface StandingsOptions {
  rows?: StandingsRowSpec[]
  /** Rename the points-for header, to prove column lookup is by name. */
  pointsForHeader?: string
  /** Drop the points-against column entirely. */
  omitPointsAgainst?: boolean
  /** Put the record in separate W / L / T columns instead of one. */
  splitRecord?: boolean
  /** Reverse the column order, which must not change the parse. */
  reverseColumns?: boolean
}

export function standingsPage(opts: StandingsOptions = {}): string {
  const rows = opts.rows ?? DEFAULT_STANDINGS

  const columns: Array<{ header: string; cell: (r: StandingsRowSpec) => string }> = [
    {
      header: 'Team',
      cell: (r) =>
        `<a href="/f1/${LEAGUE_ID}/${r.teamId}">${r.name}</a><span class="manager">${r.manager}</span>`,
    },
  ]

  if (opts.splitRecord) {
    columns.push(
      { header: 'W', cell: (r) => r.record.split('-')[0]! },
      { header: 'L', cell: (r) => r.record.split('-')[1]! },
      { header: 'T', cell: (r) => r.record.split('-')[2] ?? '0' },
    )
  } else {
    columns.push({ header: 'W-L-T', cell: (r) => r.record })
  }

  columns.push({ header: opts.pointsForHeader ?? 'Pts For', cell: (r) => r.pointsFor.toFixed(2) })
  if (!opts.omitPointsAgainst) {
    columns.push({ header: 'Pts Agnst', cell: (r) => r.pointsAgainst.toFixed(2) })
  }
  columns.push({ header: 'Streak', cell: (r) => r.streak })
  columns.push({ header: 'Moves', cell: () => '14' })

  const ordered = opts.reverseColumns ? [...columns].reverse() : columns

  return page(
    'Standings',
    `<table class="Table">
      <thead><tr>${ordered.map((c) => `<th>${c.header}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map((r) => `<tr>${ordered.map((c) => `<td>${c.cell(r)}</td>`).join('')}</tr>`)
        .join('')}</tbody>
    </table>`,
  )
}

export interface RosterRowSpec {
  slot: string
  playerId: string
  name: string
  nflTeam: string
  position: string
  bye: number
  projected: number
  points: number
  injury?: string
}

export const DEFAULT_ROSTER: RosterRowSpec[] = [
  { slot: 'QB', playerId: '3001', name: 'Xavier Mercado', nflTeam: 'DET', position: 'QB', bye: 9, projected: 26.6, points: 45.9 },
  { slot: 'RB', playerId: '3002', name: 'Zion Halvorsen', nflTeam: 'CLE', position: 'RB', bye: 5, projected: 19.4, points: 11.6 },
  { slot: 'WR', playerId: '3003', name: 'Bo Vance', nflTeam: 'DAL', position: 'WR', bye: 8, projected: 14.4, points: 12.2, injury: 'Q' },
  { slot: 'W/R/T', playerId: '3004', name: 'Emory Sinclair', nflTeam: 'NYJ', position: 'RB', bye: 7, projected: 8.6, points: 8.3 },
  { slot: 'BN', playerId: '3005', name: 'Nico Barrera', nflTeam: 'DAL', position: 'RB', bye: 9, projected: 10.7, points: 12.3 },
]

export interface RosterOptions {
  rows?: RosterRowSpec[]
  /** Remove the projection column — the failure that used to score everyone 0. */
  omitProjection?: boolean
  /** Rename the projection header to something unrecognized. */
  projectionHeader?: string
  /**
   * Emit the player cell with no whitespace between its elements, the way a
   * minified page does. Without it, `<a>Name</a><span>KC - QB</span>` reads as
   * "NameKC - QB" and the team and position are lost.
   */
  tightMarkup?: boolean
}

export function rosterPage(opts: RosterOptions = {}): string {
  const rows = opts.rows ?? DEFAULT_ROSTER

  const headers = ['Pos', 'Player', 'Bye', 'Fan Pts']
  if (!opts.omitProjection) headers.splice(3, 0, opts.projectionHeader ?? 'Proj Pts')

  const gap = opts.tightMarkup ? '' : ' '
  const cellsFor = (r: RosterRowSpec): string[] => {
    const playerCell =
      `<a href="/f1/${LEAGUE_ID}/players/${r.playerId}">${r.name}</a>${gap}` +
      `<span class="Fz-xxs">${r.nflTeam} - ${r.position}</span>` +
      (r.injury ? `${gap}<span class="status-${r.injury}">${r.injury}</span>` : '')

    const cells = [r.slot, playerCell, String(r.bye), r.points.toFixed(2)]
    if (!opts.omitProjection) cells.splice(3, 0, r.projected.toFixed(2))
    return cells
  }

  return page(
    'Team',
    `<table class="Table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map((r) => `<tr>${cellsFor(r).map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody>
    </table>`,
  )
}

export interface PlayerRowSpec {
  playerId: string
  name: string
  nflTeam: string
  position: string
  ownerTeamId?: string
  bye: number
  season: number
  average: number
  projected: number
  owned: number
}

export const DEFAULT_PLAYERS: PlayerRowSpec[] = [
  { playerId: '4001', name: 'Jalen Cardoso', nflTeam: 'ATL', position: 'QB', bye: 11, season: 279.9, average: 28.0, projected: 31.0, owned: 93 },
  { playerId: '4002', name: 'Finn Fontaine', nflTeam: 'DAL', position: 'WR', bye: 5, season: 211.0, average: 21.1, projected: 21.1, owned: 88 },
  { playerId: '4003', name: 'Silas Grady', nflTeam: 'MIA', position: 'WR', ownerTeamId: '2', bye: 5, season: 49.0, average: 4.9, projected: 4.9, owned: 2 },
]

export function playersPage(rows: PlayerRowSpec[] = DEFAULT_PLAYERS): string {
  const headers = ['Players', 'Owner', 'Bye', 'Fan Pts', 'Avg Pts', 'Proj Pts', '% Owned']

  return page(
    'Players',
    `<table class="Table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr>
        <td><a href="/f1/${LEAGUE_ID}/players/${r.playerId}">${r.name}</a> <span>${r.nflTeam} - ${r.position}</span></td>
        <td>${
          r.ownerTeamId
            ? `<a href="/f1/${LEAGUE_ID}/${r.ownerTeamId}">Team ${r.ownerTeamId}</a>`
            : 'FA'
        }</td>
        <td>${r.bye}</td>
        <td>${r.season.toFixed(2)}</td>
        <td>${r.average.toFixed(2)}</td>
        <td>${r.projected.toFixed(2)}</td>
        <td>${r.owned}%</td>
      </tr>`,
        )
        .join('')}</tbody>
    </table>`,
  )
}

/**
 * The scoreboard is matchup cards, not a table — two team links per card, with
 * the status on the card rather than on either team's row. The team name and
 * score sit in adjacent elements with no whitespace between them, exactly as a
 * minified page emits them.
 */
export function scoreboardPage(
  matchups: Array<{ away: string; awayScore: number; home: string; homeScore: number; final?: boolean }>,
): string {
  return page(
    'Scoreboard',
    `<div class="Grid">${matchups
      .map(
        (m) => `<div class="Scoreboard-matchup">` +
        `<div class="team"><a href="/f1/${LEAGUE_ID}/${m.away}">Team ${m.away}</a><span>${m.awayScore.toFixed(2)}</span></div>` +
        `<div class="team"><a href="/f1/${LEAGUE_ID}/${m.home}">Team ${m.home}</a><span>${m.homeScore.toFixed(2)}</span></div>` +
        `<div class="status">${m.final ? 'Final' : 'In progress'}</div>` +
        `</div>`,
      )
      .join('')}</div>`,
  )
}

export function settingsPage(
  entries: Array<[string, string]> = [
    ['League Name', 'Test League'],
    ['Number of Teams', '12'],
    ['Scoring Type', 'Head-to-Head Points'],
    ['Number of Playoff Teams', '6'],
    ['Playoffs Start', 'Week 15'],
    ['Draft Type', 'Live Standard Draft'],
  ],
): string {
  return page(
    'Settings',
    `<table><tbody>${entries
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join('')}</tbody></table>`,
  )
}
