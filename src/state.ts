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
