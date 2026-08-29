import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api, useApi, type HealthResponse } from '../lib/api'
import { relativeTime } from '../lib/format'
import ErrorBoundary from './ErrorBoundary'

/**
 * Navigation is grouped by what you are doing: managing your own team first,
 * because that is what you open on a Sunday morning, then the league view,
 * then research.
 */
const NAV_GROUPS: Array<{
  label: string
  items: Array<{ to: string; label: string; end?: boolean }>
}> = [
  {
    label: 'Your team',
    items: [
      { to: '/', label: 'Dashboard', end: true },
      { to: '/lineup', label: 'Start / Sit' },
      { to: '/waivers', label: 'Waivers' },
      { to: '/trades', label: 'Trades' },
      { to: '/path', label: 'Season path' },
    ],
  },
  {
    label: 'League',
    items: [
      { to: '/standings', label: 'Standings' },
      { to: '/matchups', label: 'Matchups' },
      { to: '/analytics', label: 'Analytics' },
    ],
  },
  {
    label: 'Research',
    items: [
      { to: '/players', label: 'Players' },
      { to: '/draft', label: 'Draft board' },
      { to: '/live', label: 'Live draft' },
    ],
  },
]

export default function Shell() {
  const { data: health, reload } = useApi(() => api.health(), [])
  const location = useLocation()

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4">
          <div className="flex h-14 items-center gap-5">
            <NavLink to="/" className="flex shrink-0 items-center gap-2">
              <span
                className="grid h-7 w-7 place-items-center rounded-md bg-turf-500 text-sm font-black text-ink-950"
                aria-hidden
              >
                A
              </span>
              <span className="font-bold tracking-tight">Ark</span>
            </NavLink>

            <nav
              className="flex min-w-0 items-center gap-5 overflow-x-auto scrollbar-none"
              aria-label="Main navigation"
            >
              {NAV_GROUPS.map((group, index) => (
                <div key={group.label} className="flex items-center gap-1">
                  {index > 0 && <span className="mr-4 h-5 w-px bg-ink-800" aria-hidden />}
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end ?? false}
                      className={({ isActive }) =>
                        `whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors ${
                          isActive
                            ? 'bg-ink-800 text-ink-100'
                            : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200'
                        }`
                      }
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>

            <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-ink-400">
              {health?.hasData && (
                <span className="hidden max-w-[220px] truncate lg:inline">
                  {health.leagueName}
                  {health.currentWeek ? ` · Week ${health.currentWeek}` : ''}
                </span>
              )}
              <SyncBadge health={health} onDone={reload} />
            </div>
          </div>
        </div>
      </header>

      {health?.provider === 'demo' && <DemoBanner />}

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
        {/* Keyed on the route so recovering from an error on one page does not
            leave the boundary latched when navigating to another. */}
        <ErrorBoundary key={location.pathname} label="This page">
          <Outlet />
        </ErrorBoundary>
      </main>

      <footer className="border-t border-ink-800 px-4 py-4 text-center text-xs leading-relaxed text-ink-500">
        Ark reads your league through a browser you sign into yourself. Nothing leaves your machine.
      </footer>
    </div>
  )
}

function DemoBanner() {
  return (
    <div className="border-b border-flag-500/25 bg-flag-500/10 px-4 py-2">
      <p className="mx-auto max-w-[1400px] text-center text-xs leading-relaxed text-flag-400">
        You are looking at generated demo data. To load your own league, set{' '}
        <code className="font-mono font-semibold text-flag-300">FF_PROVIDER=yahoo</code> in{' '}
        <code className="font-mono font-semibold text-flag-300">.env</code>, then run{' '}
        <code className="font-mono font-semibold text-flag-300">npm run yahoo:sync</code>.
      </p>
    </div>
  )
}

function SyncBadge({
  health,
  onDone,
}: {
  health: HealthResponse | null
  onDone: () => void
}) {
  if (!health || health.provider !== 'yahoo') return null

  return (
    <button
      type="button"
      className="btn py-1 text-xs"
      title="Pull the latest data from Yahoo"
      onClick={() => {
        void api
          .startSync()
          .then(() => {
            // The sync drives a browser and takes a while, so poll until it clears.
            const poll = setInterval(() => {
              void api.syncStatus().then((status) => {
                if (status.running) return
                clearInterval(poll)
                onDone()
              })
            }, 3000)
          })
          .catch(() => {
            // A failed start is reported by the sync log; nothing to do here.
          })
      }}
    >
      <span className={health.stale ? 'text-flag-400' : 'text-turf-400'} aria-hidden>
        ●
      </span>
      <span>Synced {relativeTime(health.fetchedAt)}</span>
    </button>
  )
}
