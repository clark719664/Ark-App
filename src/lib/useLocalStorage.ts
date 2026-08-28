import { useCallback, useEffect, useState } from 'react'

/**
 * State that survives a reload. Used by the draft board so a refresh mid-draft
 * doesn't wipe out which players are already off the table.
 *
 * Every access is guarded: private windows and blocked site data make both
 * reads and writes throw, and losing draft state is much better than a blank
 * screen.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage unavailable or full — the app keeps working in memory.
    }
  }, [key, value])

  const reset = useCallback(() => {
    setValue(initial)
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Nothing to do; state is already reset in memory.
    }
    // `initial` is intentionally not a dependency: callers pass a literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return [value, setValue, reset]
}
