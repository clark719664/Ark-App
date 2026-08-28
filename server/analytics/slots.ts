import type { PlayerPosition, RosterSlotConfig } from '../../shared/types.js'

/**
 * Lineup slot eligibility.
 *
 * Slot names vary between platforms and even between leagues on the same
 * platform ("W/R/T", "FLEX" and "R/W/T" all mean the same thing), so slots are
 * matched by the set of positions they name rather than by exact string.
 */

const BENCH_SLOTS = new Set(['BN', 'BENCH', 'IR', 'IRR', 'IRPLUS', 'NA', 'TAXI', 'RES'])

const NAMED_SLOTS: Record<string, PlayerPosition[]> = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  PK: ['K'],
  DEF: ['DEF'],
  DST: ['DEF'],
  D: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  DL: ['DL', 'DE', 'DT'],
  LB: ['LB'],
  DB: ['DB', 'CB', 'S'],
  IDP: ['DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S'],
}

const POSITION_TOKENS: Record<string, PlayerPosition[]> = {
  Q: ['QB'],
  QB: ['QB'],
  R: ['RB'],
  RB: ['RB'],
  W: ['WR'],
  WR: ['WR'],
  T: ['TE'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  D: ['DEF'],
}

export function normalizeSlot(slot: string): string {
  return slot.toUpperCase().replace(/[^A-Z/]/g, '')
}

export function isBenchSlot(slot: string): boolean {
  return BENCH_SLOTS.has(normalizeSlot(slot).replace(/\//g, ''))
}

/**
 * Which positions may fill a slot. Returns null for bench and reserve slots,
 * which don't contribute to a lineup.
 */
export function slotEligibility(slot: string): PlayerPosition[] | null {
  const normalized = normalizeSlot(slot)
  if (isBenchSlot(normalized)) return null

  // Composite slots like "W/R/T" or "Q/W/R/T" spell out their own eligibility,
  // and must be read before any name lookup: stripping the slashes from "W/R"
  // would otherwise collide with the plain "WR" slot and lose the RB.
  if (normalized.includes('/')) {
    const positions = new Set<PlayerPosition>()
    for (const token of normalized.split('/')) {
      for (const position of POSITION_TOKENS[token] ?? []) positions.add(position)
    }
    if (positions.size > 0) return [...positions]
  }

  const named = NAMED_SLOTS[normalized] ?? NAMED_SLOTS[normalized.replace(/\//g, '')]
  if (named) return named

  // Unrecognized starting slot: let anyone fill it rather than dropping it.
  return ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
}

export function canFill(slot: string, position: PlayerPosition, eligible?: PlayerPosition[]): boolean {
  const allowed = slotEligibility(slot)
  if (!allowed) return false
  if (allowed.includes(position)) return true
  return (eligible ?? []).some((p) => allowed.includes(p))
}

/** Expand a league's roster configuration into the individual starting slots. */
export function startingSlots(config: RosterSlotConfig[] | undefined): string[] {
  if (!config || config.length === 0) return []
  const slots: string[] = []
  for (const { slot, count } of config) {
    if (isBenchSlot(slot)) continue
    for (let i = 0; i < count; i += 1) slots.push(slot)
  }
  return slots
}
