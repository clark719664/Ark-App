import { useCallback, useState } from 'react'

const STORAGE_KEY = 'ark.team.v1'

/**
 * Remembers which team the manager tools are acting for, so switching pages
 * doesn't reset you back to the default every time.
 */
export function useTeamSelection(): [string, (teamId: string) => void] {
  const [teamId, setTeamId] = useState<string>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) ?? ''
    } catch {
      return ''
    }
  })

  const select = useCallback((next: string) => {
    setTeamId(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage unavailable; the choice still holds for this session.
    }
  }, [])

  return [teamId, select]
}
