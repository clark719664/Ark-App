import type { License } from "./license"

/** Pristine copy of this document's HTML, captured before the app renders a
 *  single node. This is what makes "download capsule" possible: a capsule
 *  file is this exact HTML with the payload injected — product and output
 *  are the same single file. */
export let pristineHtml = ""

export function capturePristineHtml(): void {
  pristineHtml = "<!doctype html>\n" + document.documentElement.outerHTML
}

export let license: License | null = null

export function setLicense(l: License | null): void {
  license = l
}

export function isPro(): boolean {
  return license !== null
}

// ─── Pro-change broadcast ─────────────────────────────────────────────────
// One keyed slot per interested surface (header, sealer, …) so a license
// change refreshes ALL of them, wherever the Pro modal was opened from, and
// re-mounted views overwrite their slot instead of stacking listeners.
const proChangeListeners = new Map<string, () => void>()

export function setProChangeListener(key: string, fn: () => void): void {
  proChangeListeners.set(key, fn)
}

export function emitProChange(): void {
  for (const fn of proChangeListeners.values()) fn()
}

// ─── View teardown ────────────────────────────────────────────────────────
// The active view registers its cleanup (timers, pending unlock attempts);
// navigation runs it so a dismissed countdown never keeps ticking or firing
// network fetches against detached DOM.
let viewCleanup: (() => void) | null = null

export function setViewCleanup(fn: () => void): void {
  viewCleanup = fn
}

export function runViewCleanup(): void {
  const fn = viewCleanup
  viewCleanup = null
  if (fn) fn()
}
