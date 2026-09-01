// Shared license-minting helpers for tools/ and server/. Mirrors the
// verification logic in src/license.ts exactly:
//   key = "ARK1." + b64url(claimJSON) + "." + b64url(ed25519 signature)
import * as ed from "@noble/ed25519"

export const PRO_TIER = "ARK-PRO"

export function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url")
}

export function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) throw new Error("invalid hex")
  return Uint8Array.from(Buffer.from(clean, "hex"))
}

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex")
}

/** Mint a license key for an email address using a 32-byte private key. */
export async function mintLicense(privateKeyBytes, email, issued = new Date().toISOString().slice(0, 10)) {
  const claim = { email, tier: PRO_TIER, issued }
  const claimBytes = new TextEncoder().encode(JSON.stringify(claim))
  const sig = await ed.signAsync(claimBytes, privateKeyBytes)
  return `ARK1.${b64url(claimBytes)}.${b64url(sig)}`
}

export async function publicKeyFor(privateKeyBytes) {
  return bytesToHex(await ed.getPublicKeyAsync(privateKeyBytes))
}
