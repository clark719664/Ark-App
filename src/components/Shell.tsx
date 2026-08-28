import { NavLink, Outlet } from 'react-router-dom'
import { api, useApi } from '../lib/api'
import { relativeTime } from '../lib/format'

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/standings', label: 'Standings' },
  { to: '/matchups', label: 'Matchups' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/players', label: 'Players' },
  { to: '/draft', label: 'Draft Board' },
]

export default function Shell() {
  const { data: health, reload } = useApi(() => api.health(), [])

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4">
          <div className="flex items-center gap-4 h-14">
            <div className="flex items-center gap-2 shrink-0">
              <span
                className="grid h-7 w-7 place-items-center rounded-md bg-turf-500 text-ink-950 font-black text-sm"
                aria-hidden
              >
                A
              </span>
              <span className="font-bold tracking-tight">Ark</span>
            </div>

            <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Main">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end ?? false}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
                      isActive ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200 hover:bg-ink-850'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-3 text-xs text-ink-400 shrink-0">
              {health?.hasData && (
                <span className="hidden sm:inline truncate max-w-[240px]">
                  {health.leagueName}
                  {health.currentWeek ? ` · Wk ${health.currentWeek}` : ''}
                </span>
              )}
              <SyncBadge health={health} onDone={reload} />
            </div>
          </div>
        </div>
      </header>

      {health?.provider === 'demo' && (
        <div className="border-b border-flag-500/25 bg-flag-500/10 px-4 py-2 text-center text-xs text-flag-400">
          Showing generated demo data. Set <code className="font-mono">FF_PROVIDER=yahoo</code> in{' '}
          <code className="font-mono">.env</code> and run{' '}
          <code className="font-mono">npm run yahoo:sync</code> to load your league.
        </div>
      )}

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-ink-800 px-4 py-4 text-center text-xs text-ink-500">
        Ark reads your league through a browser you sign into yourself. Nothing leaves your machine.
      </footer>
    </div>
  )
}

function SyncBadge({
  health,
  onDone,
}: {
  health: { provider: string; fetchedAt: string | null; stale: boolean } | null
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
            // The sync drives a browser and takes a while; poll until it clears.
            const poll = setInterval(() => {
              void api.syncStatus().then((status) => {
                if (status.running) return
                clearInterval(poll)
                onDone()
              })
            }, 3000)
          })
          .catch(() => {})
      }}
    >
      <span className={health.stale ? 'text-flag-400' : 'text-turf-400'}>●</span>
      {relativeTime(health.fetchedAt)}
    </button>
  )
}
