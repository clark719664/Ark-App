import { lazy, StrictMode, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import Shell from './components/Shell'
import { Loading } from './components/ui'
import Dashboard from './pages/Dashboard'
import Standings from './pages/Standings'
import Matchups from './pages/Matchups'
import Lineup from './pages/Lineup'
import Waivers from './pages/Waivers'
import Trades from './pages/Trades'
import Path from './pages/Path'
import Players from './pages/Players'
import DraftBoard from './pages/DraftBoard'
import DraftLive from './pages/DraftLive'
import './index.css'

// The charting library is by far the largest dependency and only two pages
// need it, so they load on demand rather than in everyone's first paint.
const Analytics = lazy(() => import('./pages/Analytics'))
const TeamPage = lazy(() => import('./pages/TeamPage'))

function deferred(node: ReactNode): ReactNode {
  return <Suspense fallback={<Loading label="Loading charts…" />}>{node}</Suspense>
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'standings', element: <Standings /> },
      { path: 'matchups', element: <Matchups /> },
      { path: 'lineup', element: <Lineup /> },
      { path: 'waivers', element: <Waivers /> },
      { path: 'trades', element: <Trades /> },
      { path: 'path', element: <Path /> },
      { path: 'analytics', element: deferred(<Analytics />) },
      { path: 'players', element: <Players /> },
      { path: 'draft', element: <DraftBoard /> },
      { path: 'live', element: <DraftLive /> },
      { path: 'teams/:id', element: deferred(<TeamPage />) },
    ],
  },
])

const root = document.getElementById('root')
if (!root) throw new Error('No #root element in index.html')

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
