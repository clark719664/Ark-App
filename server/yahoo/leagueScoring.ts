import type { Page } from 'playwright'
import { PPR_SCORING, type LeagueScoring } from '../../data/draft/scoring.js'
import { API, fetchJson, flatten, leagueNodes } from './draftFeed.js'

/**
 * A league's scoring rules, read from the league itself.
 *
 * Pricing a board in the wrong currency does not fail: every player still gets
 * a number and the board still ranks. A full-PPR board handed to a half-PPR
 * league overpays high-volume receivers by about three points a game and looks
 * entirely reasonable while doing it. So this is read per league rather than
 * configured once and assumed to still apply.
 */

/** Yahoo stat ids are stable; position type disambiguates the reused ones. */
const OFFENSE: Record<number, keyof LeagueScoring> = {
  2: 'completions',
  4: 'passingYards',
  5: 'passingTds',
  6: 'interceptions',
  9: 'rushingYards',
  10: 'rushingTds',
  11: 'receptions',
  12: 'receivingYards',
  13: 'receivingTds',
  15: 'returnTds',
  16: 'twoPointConversions',
  18: 'fumblesLost',
}

const KICKING: Record<number, keyof LeagueScoring['fieldGoals'] | 'patMade'> = {
  19: 'b0',
  20: 'b20',
  21: 'b30',
  22: 'b40',
  23: 'b50',
  29: 'patMade',
}

interface Stat {
  stat_id: number | string
  name?: string
  position_type?: string
  value?: number | string
}

function statList(node: unknown): Stat[] {
  const wrapper = node as { stats?: Array<{ stat?: Stat } | Stat> } | undefined
  if (!wrapper?.stats) return []
  return wrapper.stats.map((entry) => ('stat' in entry ? (entry.stat as Stat) : (entry as Stat)))
}

export interface LeagueScoringResult {
  scoring: LeagueScoring
  /** Rules the league pays for that the open data cannot express. */
  unmapped: string[]
  /** A short human label, e.g. "half PPR" or "full PPR". */
  label: string
}

function describe(scoring: LeagueScoring): string {
  const perReception = scoring.receptions
  const base =
    perReception >= 0.95
      ? 'full PPR'
      : perReception >= 0.4
        ? 'half PPR'
        : perReception > 0
          ? `${perReception} a reception`
          : 'standard, no reception points'
  return scoring.completions > 0 ? `${base}, ${scoring.completions} a completion` : base
}

export async function fetchLeagueScoring(
  page: Page,
  leagueKey: string,
): Promise<LeagueScoringResult> {
  const payload = await fetchJson(page, `${API}/league/${leagueKey}/settings?format=json`)
  const settingsNode = leagueNodes(payload).find((node) => node && node['settings'] !== undefined)
  if (!settingsNode) throw new Error(`No settings block for ${leagueKey}`)
  const settings = flatten(
    Array.isArray(settingsNode['settings']) ? settingsNode['settings'][0] : settingsNode['settings'],
  )

  const categories = new Map<number, Stat>()
  for (const stat of statList(settings['stat_categories'])) {
    categories.set(Number(stat.stat_id), stat)
  }

  const scoring: LeagueScoring = structuredClone(PPR_SCORING)
  // Nothing is paid for unless the league says so, otherwise a rule the league
  // has turned off keeps its full-PPR default and silently inflates the board.
  scoring.completions = 0
  scoring.receptions = 0

  const unmapped: string[] = []
  for (const stat of statList(settings['stat_modifiers'])) {
    const id = Number(stat.stat_id)
    const value = Number(stat.value)
    if (!Number.isFinite(value)) continue
    const type = categories.get(id)?.position_type ?? ''

    if (type === 'O' && OFFENSE[id]) {
      const key = OFFENSE[id] as Exclude<keyof LeagueScoring, 'fieldGoals'>
      ;(scoring[key] as number) = value
    } else if (type === 'K' && KICKING[id]) {
      const key = KICKING[id]
      if (key === 'patMade') scoring.patMade = value
      else scoring.fieldGoals[key] = value
    } else if (value !== 0 && type !== 'DT') {
      unmapped.push(`${categories.get(id)?.name ?? id} = ${value}`)
    }
  }

  // Yahoo has no 50-59/60+ split; the 50+ rate covers both.
  scoring.fieldGoals.b60 = scoring.fieldGoals.b50

  return { scoring, unmapped, label: describe(scoring) }
}
