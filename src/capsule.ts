import { base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from "./armor"
import { FRAGMENT_INFLATED_MAX, QUICKNET_CHAIN_HASH } from "./config"
import type { Beacon } from "./drand"
import { isBundlePayload, validateBundle, type BundlePayload } from "./bundle"

/** Everything a fragment or .html capsule can carry: a single sealed capsule
 *  or an "open when…" bundle of envelopes. */
export type AnyPayload = CapsulePayload | BundlePayload

/** Everything a capsule carries besides the ciphertext itself. The title and
 *  timestamps are deliberately plaintext — a capsule should say what it is
 *  and when it opens without giving away a single byte of its contents. */
export interface CapsulePayload {
  v: 1
  title: string
  sealedAt: number // ms epoch
  round: number
  chainHash: string
  /** base64 of raw age-format ciphertext bytes */
  ciphertext: string
  theme?: { accent?: string; brandless?: boolean }
  /** Recorded beacon, present only on demo capsules so they open with zero
   *  network. Real capsules never carry one — the key doesn't exist yet. */
  beacon?: Beacon
}

export function ciphertextBytes(p: CapsulePayload): Uint8Array {
  return base64ToBytes(p.ciphertext)
}

export function makePayload(args: {
  title: string
  round: number
  ciphertext: Uint8Array
  sealedAt: number
  theme?: CapsulePayload["theme"]
}): CapsulePayload {
  return {
    v: 1,
    title: args.title,
    sealedAt: args.sealedAt,
    round: args.round,
    chainHash: QUICKNET_CHAIN_HASH,
    ciphertext: bytesToBase64(args.ciphertext),
    ...(args.theme ? { theme: args.theme } : {}),
  }
}

// ─── Capsule links ────────────────────────────────────────────────────────
// The whole capsule travels in the URL *fragment*, which browsers never send
// to any server: a capsule link on a static host is zero-knowledge hosting.
// Format:  #c1.<base64url(deflate-raw(JSON))>   (c0 = uncompressed fallback)

export async function encodeFragment(payload: AnyPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  if (typeof CompressionStream !== "undefined") {
    const deflated = await pipeThrough(json, new CompressionStream("deflate-raw"))
    return "c1." + bytesToBase64Url(deflated)
  }
  return "c0." + bytesToBase64Url(json)
}

export async function decodeFragment(fragment: string): Promise<AnyPayload | null> {
  const frag = fragment.startsWith("#") ? fragment.slice(1) : fragment
  let jsonBytes: Uint8Array
  if (frag.startsWith("c1.")) {
    jsonBytes = await pipeThrough(base64UrlToBytes(frag.slice(3)), new DecompressionStream("deflate-raw"), FRAGMENT_INFLATED_MAX)
  } else if (frag.startsWith("c0.")) {
    jsonBytes = base64UrlToBytes(frag.slice(3))
  } else {
    return null
  }
  const parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown
  if (isBundlePayload(parsed)) return validateBundle(parsed)
  const payload = parsed as CapsulePayload
  validatePayload(payload)
  return payload
}

export function validatePayload(p: CapsulePayload): void {
  if (p.v !== 1) throw new Error(`Unknown capsule version ${String(p.v)}`)
  if (!Number.isSafeInteger(p.round) || p.round < 1) throw new Error("Capsule has no valid round")
  if (typeof p.ciphertext !== "string" || p.ciphertext.length === 0) {
    throw new Error("Capsule has no ciphertext")
  }
  if (p.chainHash !== QUICKNET_CHAIN_HASH) {
    throw new Error("Capsule targets a different drand chain than this build understands")
  }
}

async function pipeThrough(
  bytes: Uint8Array,
  transform: GenericTransformStream,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(transform).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      void reader.cancel()
      throw new Error("Fragment expands past any plausible capsule size — refusing to inflate it")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// ─── Self-contained .html capsules ────────────────────────────────────────
// The app captures its own pristine HTML at boot; a downloaded capsule is
// that same single file with the payload injected into the marker below.
// Product and output are the same species — a capsule IS an Ark.

export const PAYLOAD_MARKER_ID = "ark-payload"
const MARKER_OPEN = `<script id="${PAYLOAD_MARKER_ID}" type="application/json">`
const MARKER_CLOSE = `</script>`

export function injectCapsule(pristineHtml: string, payload: AnyPayload): string {
  const start = pristineHtml.indexOf(MARKER_OPEN)
  if (start === -1) throw new Error("Payload marker missing from document")
  const bodyStart = start + MARKER_OPEN.length
  const end = pristineHtml.indexOf(MARKER_CLOSE, bodyStart)
  if (end === -1) throw new Error("Payload marker is unterminated")
  // <-escape so the JSON can never terminate its own <script> element.
  const json = JSON.stringify(payload).replace(/</g, "\\u003c")
  return pristineHtml.slice(0, bodyStart) + json + pristineHtml.slice(end)
}

export function readEmbeddedCapsule(doc: Document): AnyPayload | null {
  const el = doc.getElementById(PAYLOAD_MARKER_ID)
  if (!el?.textContent) return null
  const parsed = JSON.parse(el.textContent) as unknown
  if (parsed === null) return null
  if (isBundlePayload(parsed)) return validateBundle(parsed)
  const payload = parsed as CapsulePayload
  validatePayload(payload)
  return payload
}
