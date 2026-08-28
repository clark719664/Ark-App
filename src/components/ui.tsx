import type { ReactNode } from 'react'
import type { ApiError } from '../lib/api'

/** Shared presentational primitives. */

export function Card({
  title, subtitle, actions, children, className = '',
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="min-w-0">
            {title && <h2 className="font-semibold text-ink-100 truncate">{title}</h2>}
            {subtitle && <p className="text-xs text-ink-400 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function StatTile({
  label, value, hint, tone = 'text-ink-100',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: string
}) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-ink-400 font-semibold">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular ${tone}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-400">{hint}</div>}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 p-8 text-ink-400 text-sm">
      <span className="h-4 w-4 rounded-full border-2 border-ink-600 border-t-turf-400 animate-spin" />
      {label}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const isSetup = error.code === 'NO_SNAPSHOT'
  const isAuth = error.code === 'YAHOO_AUTH'

  return (
    <div className="card p-6">
      <h2 className="font-semibold text-lg text-ink-100">
        {isSetup ? 'No league data yet' : isAuth ? 'Yahoo sign-in needed' : 'Something went wrong'}
      </h2>
      <pre className="mt-3 whitespace-pre-wrap text-sm text-ink-300 font-mono leading-relaxed">
        {error.message}
      </pre>
      {onRetry && (
        <button type="button" className="btn mt-4" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-ink-400">{children}</div>
}

export function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`pill ${className}`}>{children}</span>
}

/**
 * A 0-100 bar. Used for power-ranking components and playoff odds, where the
 * relative size of the bar communicates faster than the number alone.
 */
export function Meter({ value, tone = 'bg-turf-500' }: { value: number; tone?: string }) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div className="h-1.5 w-full rounded-full bg-ink-800 overflow-hidden" role="presentation">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  )
}

/** Up/down indicator for week-over-week movement. */
export function Delta({ value }: { value: number | null }) {
  if (value === null || value === 0) return <span className="text-ink-500">—</span>
  const up = value > 0
  return (
    <span className={up ? 'text-turf-400' : 'text-blitz-400'}>
      {up ? '▲' : '▼'} {Math.abs(value)}
    </span>
  )
}
