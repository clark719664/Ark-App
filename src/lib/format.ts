/** Display formatting helpers. Everything here is presentation-only. */

export function points(value: number | undefined | null, places = 1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(places)
}

export function percent(value: number | undefined | null, places = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(places)}%`
}

/** Percent values that arrive already on a 0-100 scale. */
export function percentRaw(value: number | undefined | null, places = 0): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(places)}%`
}

export function record(rec: { wins: number; losses: number; ties: number } | undefined): string {
  if (!rec) return '—'
  return rec.ties > 0 ? `${rec.wins}-${rec.losses}-${rec.ties}` : `${rec.wins}-${rec.losses}`
}

export function signed(value: number | undefined | null, places = 1): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const rounded = value.toFixed(places)
  return value > 0 ? `+${rounded}` : rounded
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds)) return 'unknown'
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

/** Consistent colour language: green good, amber neutral-ish, red bad. */
export function toneForLuck(luckWins: number): string {
  if (luckWins > 0.75) return 'text-flag-400'
  if (luckWins < -0.75) return 'text-chalk-400'
  return 'text-ink-300'
}

export function toneForOdds(probability: number): string {
  if (probability >= 0.75) return 'text-turf-400'
  if (probability >= 0.35) return 'text-flag-400'
  return 'text-blitz-400'
}

const POSITION_TONES: Record<string, string> = {
  QB: 'bg-blitz-500/15 text-blitz-400',
  RB: 'bg-turf-500/15 text-turf-400',
  WR: 'bg-chalk-500/15 text-chalk-400',
  TE: 'bg-flag-500/15 text-flag-400',
  K: 'bg-plum-500/15 text-plum-400',
  // The defensive family shares one treatment: the label tells them apart, and
  // a defender should read as a different kind of pick from a receiver.
  DEF: 'bg-ink-600/40 text-ink-200',
  LB: 'bg-ink-600/40 text-ink-200',
  DB: 'bg-ink-600/40 text-ink-200',
  DL: 'bg-ink-600/40 text-ink-200',
}

export function positionTone(position: string): string {
  return POSITION_TONES[position] ?? 'bg-ink-700/50 text-ink-300'
}

export function injuryTone(code: string | undefined): string {
  if (!code) return ''
  if (['O', 'IR', 'IR-R', 'SUSP', 'PUP', 'NA'].includes(code)) return 'text-blitz-400'
  if (['Q', 'D', 'GTD'].includes(code)) return 'text-flag-400'
  return 'text-ink-400'
}

/**
 * Recharts hands formatters a loosely typed value. Narrow it once here so the
 * chart code stays readable instead of casting at every call site.
 */
export function chartNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
