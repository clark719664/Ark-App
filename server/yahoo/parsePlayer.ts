import type { InjuryStatus, Player, PlayerPosition } from '../../shared/types.js'
import { type Cell, playerIdFromHref } from './dom.js'

const KNOWN_POSITIONS = new Set<PlayerPosition>([
  'QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB', 'CB', 'S', 'DE', 'DT',
])

const INJURY_LABELS: Record<string, string> = {
  Q: 'Questionable',
  D: 'Doubtful',
  O: 'Out',
  IR: 'Injured Reserve',
  'IR-R': 'Injured Reserve — designated to return',
  PUP: 'Physically Unable to Perform',
  NA: 'Not Active',
  SUSP: 'Suspended',
  COVID: 'COVID-19 list',
  GTD: 'Game-time decision',
}

export function toPosition(raw: string | undefined): PlayerPosition {
  const value = (raw ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  if (value === 'DST' || value === 'DEFENSE') return 'DEF'
  return KNOWN_POSITIONS.has(value as PlayerPosition) ? (value as PlayerPosition) : 'UNKNOWN'
}

/**
 * Yahoo packs a player's identity into a single cell that reads roughly:
 *
 *   "Patrick Mahomes KC - QB  Q"
 *   "Bills DEF BUF - DEF"
 *
 * with the name as a link and the team/position/injury as trailing text. Parse
 * defensively — every field here is optional in some Yahoo view or another.
 */
export function parsePlayerCell(cell: Cell | undefined): Partial<Player> & { name: string } {
  if (!cell) return { name: '' }

  const playerLink = cell.links.find((l) => /players\/\d+|\/nfl\/players/.test(l.href))
  const name = (playerLink?.text ?? cell.text.split(/\s{2,}/)[0] ?? '').trim()
  const id = playerLink ? playerIdFromHref(playerLink.href) : undefined

  // "KC - QB" / "FA - WR" / "BUF - DEF,DL"
  const teamPos = cell.text.match(/\b([A-Z]{2,4}|FA|Free Agent)\s*-\s*([A-Za-z,/]+)/)
  const nflTeam = (teamPos?.[1] ?? '').replace(/free agent/i, 'FA').toUpperCase()
  const positionsRaw = (teamPos?.[2] ?? '').split(/[,/]/).filter(Boolean)

  const positions = positionsRaw.map(toPosition).filter((p) => p !== 'UNKNOWN')
  const position = positions[0] ?? 'UNKNOWN'

  const injury = parseInjury(cell)

  const player: Partial<Player> & { name: string } = { name, position, nflTeam }
  if (id) player.id = id
  if (positions.length > 1) player.eligiblePositions = positions
  if (injury) player.injury = injury
  return player
}

function parseInjury(cell: Cell): InjuryStatus | undefined {
  // Yahoo marks status both as a trailing token and as a class on the span.
  const classMatch = (cell.className ?? '').match(/status-(\w+)/i)
  const textMatch = cell.text.match(/\b(IR-R|IR|PUP|SUSP|COVID|GTD|NA|Q|D|O)\b(?!\w)/)
  const code = (classMatch?.[1] ?? textMatch?.[1] ?? '').toUpperCase()
  if (!code) return undefined
  const label = INJURY_LABELS[code]
  return label ? { code, label } : { code }
}

/** Bye week is usually its own column but sometimes appears as "Bye 9". */
export function parseBye(text: string | undefined): number | undefined {
  if (!text) return undefined
  const match = text.match(/bye\s*(\d{1,2})/i) ?? text.match(/^(\d{1,2})$/)
  const value = match?.[1] ? Number(match[1]) : NaN
  return Number.isFinite(value) && value >= 1 && value <= 18 ? value : undefined
}
