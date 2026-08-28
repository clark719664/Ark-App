import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import Shell from './components/Shell'
import Dashboard from './pages/Dashboard'
import Standings from './pages/Standings'
import Matchups from './pages/Matchups'
import Lineup from './pages/Lineup'
import Waivers from './pages/Waivers'
import Trades from './pages/Trades'
import TeamPage from './pages/TeamPage'
import Players from './pages/Players'
import DraftBoard from './pages/DraftBoard'
import Analytics from './pages/Analytics'
import './index.css'

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
      { path: 'analytics', element: <Analytics /> },
      { path: 'players', element: <Players /> },
      { path: 'draft', element: <DraftBoard /> },
      { path: 'teams/:id', element: <TeamPage /> },
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
