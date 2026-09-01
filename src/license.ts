import { verifyAsync } from "@noble/ed25519"
import { base64UrlToBytes, bytesToBase64Url } from "./armor"
import { LICENSE_PUBLIC_KEY_HEX, PRO_TIER } from "./config"
import { hexToBytes } from "./drand"

// Ark Pro licenses are Ed25519 signatures over a tiny JSON claim, verified
// entirely offline against the public key baked into this file. There is no
// license server, no phone-home, nothing to shut down. Format:
//   ARK1.<base64url(claim JSON)>.<base64url(64-byte signature)>
// minted by tools/sign-license.mjs (manually) or server/webhook.mjs (Stripe).

export interface LicenseClaim {
  email: string
  tier: string
  issued: string // ISO date
}

export interface License {
  claim: LicenseClaim
  key: string
}

const STORAGE_KEY = "ark.license.v1"

export async function verifyLicenseKey(
  key: string,
  publicKeyHex: string = LICENSE_PUBLIC_KEY_HEX,
): Promise<LicenseClaim> {
  const trimmed = key.trim()
  const parts = trimmed.split(".")
  if (parts.length !== 3 || parts[0] !== "ARK1") {
    throw new Error("That doesn't look like an Ark license key (expected ARK1.….…)")
  }
  let claim: LicenseClaim
  let claimBytes: Uint8Array
  let sig: Uint8Array
  try {
    claimBytes = base64UrlToBytes(parts[1])
    sig = base64UrlToBytes(parts[2])
    claim = JSON.parse(new TextDecoder().decode(claimBytes)) as LicenseClaim
  } catch {
    throw new Error("License key is malformed")
  }
  if (claim.tier !== PRO_TIER) throw new Error(`Unknown license tier "${claim.tier}"`)
  let publicKey: Uint8Array
  try {
    publicKey = hexToBytes(publicKeyHex)
    if (publicKey.length !== 32) throw new Error()
  } catch {
    throw new Error(
      "This build has no license public key configured — run `npm run keygen` and set LICENSE_PUBLIC_KEY_HEX in src/config.ts",
    )
  }
  const ok = await verifyAsync(sig, claimBytes, publicKey)
  if (!ok) throw new Error("License signature is not valid for this build's public key")
  return claim
}

export async function storedLicense(): Promise<License | null> {
  let key: string | null = null
  try {
    key = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!key) return null
  try {
    return { claim: await verifyLicenseKey(key), key }
  } catch {
    return null
  }
}

export function storeLicense(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key.trim())
  } catch {
    // Private windows may refuse storage; Pro still works for this session.
  }
}

export function clearLicense(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Helper for tools/tests: build the exact bytes that get signed. */
export function claimToSignable(claim: LicenseClaim): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(claim))
}

export function assembleKey(claim: LicenseClaim, signature: Uint8Array): string {
  return `ARK1.${bytesToBase64Url(claimToSignable(claim))}.${bytesToBase64Url(signature)}`
}
