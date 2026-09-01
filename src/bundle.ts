import { QUICKNET_CHAIN_HASH } from "./config"
import { isEnvelopeColor, isStationery, type EnvelopeColor, type Stationery } from "./moments"

// A bundle is Ark's "open when…" capsule: several sealed envelopes delivered
// as one link or file. Two kinds of seal coexist, honestly labelled:
//   trust    — sealed by promise, like paper. The letter travels as
//              (compressed) plaintext inside the private link; the recipient
//              is trusted to wait for the moment.
//   timelock — sealed by mathematics. The letter is tlock-encrypted to a
//              drand round; the decryption key does not exist until then.

export interface EnvelopeTrust {
  kind: "trust"
  label: string // completes "open when …"
  emoji: string
  color: EnvelopeColor
  paper: Stationery
  letter: string
}

export interface EnvelopeTimelock {
  kind: "timelock"
  label: string
  emoji: string
  color: EnvelopeColor
  paper: Stationery
  round: number
  /** base64 of raw age-format ciphertext (same encoding as single capsules) */
  ciphertext: string
}

export type SealedEnvelope = EnvelopeTrust | EnvelopeTimelock

export interface BundlePayload {
  v: 1
  bundle: true
  to: string
  from: string
  sealedAt: number
  chainHash: string
  envelopes: SealedEnvelope[]
  theme?: { accent?: string; brandless?: boolean }
}

export const BUNDLE_LIMITS = {
  envelopes: 30,
  letterChars: 100_000,
  nameChars: 60,
  labelChars: 90,
  emojiChars: 8,
}

/** Coerce/clamp a string the way Open When's validator did: normalise line
 *  endings, strip control chars except newline and tab, clamp length.
 *  Decoded bundles arrive from URLs anyone could have crafted. */
export function cleanString(v: unknown, max: number): string {
  if (typeof v !== "string") return ""
  const normalized = v
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
  return normalized.length > max ? normalized.slice(0, max) : normalized
}

export function isBundlePayload(p: unknown): p is BundlePayload {
  return typeof p === "object" && p !== null && (p as { bundle?: unknown }).bundle === true
}

/** Returns a sanitised copy of a bundle payload, or throws with a friendly
 *  message. Every field is coerced — nothing from a link is trusted. */
export function validateBundle(b: unknown): BundlePayload {
  if (typeof b !== "object" || b === null) throw new Error("This link does not carry a bundle")
  const raw = b as Record<string, unknown>
  if (raw.v !== 1 || raw.bundle !== true) throw new Error("Unknown bundle version")
  if (raw.chainHash !== QUICKNET_CHAIN_HASH) {
    throw new Error("Bundle targets a different drand chain than this build understands")
  }
  if (!Array.isArray(raw.envelopes) || raw.envelopes.length < 1) throw new Error("The bundle has no envelopes")
  if (raw.envelopes.length > BUNDLE_LIMITS.envelopes) throw new Error("The bundle has too many envelopes")

  const envelopes: SealedEnvelope[] = raw.envelopes.map((e: unknown, i: number) => {
    const env = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>
    const base = {
      label: cleanString(env.label, BUNDLE_LIMITS.labelChars) || "the moment is right",
      emoji: cleanString(env.emoji, BUNDLE_LIMITS.emojiChars),
      color: (isEnvelopeColor(env.color) ? env.color : (["rose", "sage", "dusk", "sand", "plum"] as const)[i % 5]),
      paper: (isStationery(env.paper) ? env.paper : "classic") as Stationery,
    }
    if (env.kind === "timelock") {
      if (!Number.isSafeInteger(env.round) || (env.round as number) < 1) {
        throw new Error(`Envelope ${i + 1} has no valid round`)
      }
      if (typeof env.ciphertext !== "string" || env.ciphertext.length === 0) {
        throw new Error(`Envelope ${i + 1} has no ciphertext`)
      }
      return { kind: "timelock", ...base, round: env.round as number, ciphertext: env.ciphertext }
    }
    const letter = cleanString(env.letter, BUNDLE_LIMITS.letterChars)
    if (!letter.trim()) throw new Error(`Envelope ${i + 1} is empty`)
    return { kind: "trust", ...base, letter }
  })

  const theme = (typeof raw.theme === "object" && raw.theme !== null ? raw.theme : undefined) as
    | { accent?: unknown; brandless?: unknown }
    | undefined

  return {
    v: 1,
    bundle: true,
    to: cleanString(raw.to, BUNDLE_LIMITS.nameChars),
    from: cleanString(raw.from, BUNDLE_LIMITS.nameChars),
    sealedAt: Number.isSafeInteger(raw.sealedAt) ? (raw.sealedAt as number) : 0,
    chainHash: QUICKNET_CHAIN_HASH,
    envelopes,
    ...(theme
      ? {
          theme: {
            ...(typeof theme.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(theme.accent) ? { accent: theme.accent } : {}),
            ...(theme.brandless === true ? { brandless: true } : {}),
          },
        }
      : {}),
  }
}

/** A short stable fingerprint used to remember which envelopes were opened
 *  on this device (localStorage) — derived from content, not identity. */
export async function bundleFingerprint(b: BundlePayload): Promise<string> {
  const material = b.envelopes
    .map((e) => (e.kind === "timelock" ? `t:${e.round}:${e.ciphertext.slice(0, 40)}` : `p:${e.label}:${e.letter.length}`))
    .join("|")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${b.to}|${b.from}|${material}`))
  return Array.from(new Uint8Array(digest).slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("")
}
