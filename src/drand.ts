import type { ChainClient, ChainInfo, ChainOptions } from "drand-client"
import { bls12_381 } from "@noble/curves/bls12-381"
import { sha256 } from "@noble/hashes/sha2"
import {
  DRAND_RELAYS,
  QUICKNET_CHAIN_HASH,
  QUICKNET_GENESIS_TIME,
  QUICKNET_PERIOD,
  QUICKNET_PUBLIC_KEY,
  QUICKNET_SCHEME,
} from "./config"

export interface Beacon {
  round: number
  randomness: string
  signature: string
}

/** The quicknet chain description, embedded so no network is ever needed to
 *  know WHO must sign WHAT for a capsule to open. */
export const QUICKNET_INFO: ChainInfo = {
  public_key: QUICKNET_PUBLIC_KEY,
  period: QUICKNET_PERIOD,
  genesis_time: QUICKNET_GENESIS_TIME,
  hash: QUICKNET_CHAIN_HASH,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: QUICKNET_SCHEME,
  metadata: { beaconID: "quicknet" },
}

const VERIFYING_OPTIONS: ChainOptions = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: {
    chainHash: QUICKNET_CHAIN_HASH,
    publicKey: QUICKNET_PUBLIC_KEY,
  },
}

/** Round number whose randomness is (or will be) published at time `ms`. */
export function roundAt(ms: number): number {
  return Math.max(1, Math.floor((ms / 1000 - QUICKNET_GENESIS_TIME) / QUICKNET_PERIOD) + 1)
}

/** Wall-clock ms at which `round`'s randomness is published. */
export function timeOfRound(round: number): number {
  return (QUICKNET_GENESIS_TIME + (round - 1) * QUICKNET_PERIOD) * 1000
}

/** The round targeted when sealing to a wall-clock time: the FIRST round at
 *  or after `ms`, so a capsule can never open before its chosen moment. */
export function roundForUnlock(ms: number): number {
  const r = Math.ceil((ms / 1000 - QUICKNET_GENESIS_TIME) / QUICKNET_PERIOD) + 1
  return Math.max(1, r)
}

/** BLS12-381 verification of a quicknet beacon, done explicitly with
 *  @noble/curves so the proof panel can show its work. The message is
 *  sha256(round as big-endian u64); the signature lives on G1, the League of
 *  Entropy's aggregate public key on G2. */
export function verifyBeaconSignature(beacon: Beacon): boolean {
  try {
    const roundBuf = new Uint8Array(8)
    new DataView(roundBuf.buffer).setBigUint64(0, BigInt(beacon.round), false)
    const message = sha256(roundBuf)
    return bls12_381.verifyShortSignature(
      hexToBytes(beacon.signature),
      message,
      hexToBytes(QUICKNET_PUBLIC_KEY),
      { DST: "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_" },
    )
  } catch {
    return false
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "")
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) throw new Error("invalid hex")
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Fetch one round's beacon from the public relays, trying each in order.
 *  Returns the first structurally sane response; cryptographic verification
 *  happens in the ChainClient layer (drand-client) AND again explicitly in
 *  the proof panel. */
export async function fetchBeaconFromRelays(
  round: number,
  timeoutMs = 8000,
): Promise<{ beacon: Beacon; relay: string }> {
  const errors: string[] = []
  for (const relay of DRAND_RELAYS) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetch(`${relay}/${QUICKNET_CHAIN_HASH}/public/${round}`, {
        signal: ctrl.signal,
        cache: "no-store",
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const beacon = (await res.json()) as Beacon
      if (typeof beacon.round !== "number" || typeof beacon.signature !== "string") {
        throw new Error("malformed beacon")
      }
      return { beacon, relay }
    } catch (e) {
      errors.push(`${relay}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  throw new BeaconUnreachableError(errors)
}

export class BeaconUnreachableError extends Error {
  constructor(public attempts: string[]) {
    super("No drand relay reachable")
    this.name = "BeaconUnreachableError"
  }
}

/** A ChainClient that answers entirely from memory: embedded chain info plus
 *  one known beacon. This powers airgapped unlocks (paste a beacon by hand)
 *  and the offline demo capsule. drand-client still runs full BLS
 *  verification on what we return — a forged pasted beacon is rejected. */
export function staticClient(beacon: Beacon): ChainClient {
  return {
    options: VERIFYING_OPTIONS,
    chain: () => ({
      baseUrl: "embedded://quicknet",
      info: async () => QUICKNET_INFO,
    }),
    get: async (round: number) => {
      if (round !== beacon.round) {
        throw new Error(
          `This beacon is for round ${beacon.round}, but the capsule needs round ${round}`,
        )
      }
      return beacon as never
    },
    latest: async () => beacon as never,
  }
}

/** A ChainClient backed by the public relays with fallback. Only `get` is
 *  used by the tlock decrypter. */
export function relayClient(): ChainClient {
  return {
    options: VERIFYING_OPTIONS,
    chain: () => ({
      baseUrl: DRAND_RELAYS[0],
      info: async () => QUICKNET_INFO,
    }),
    get: async (round: number) => (await fetchBeaconFromRelays(round)).beacon as never,
    latest: async () => {
      const { beacon } = await fetchBeaconFromRelays(roundAt(Date.now()))
      return beacon as never
    },
  }
}

/** Parse a beacon JSON pasted by a human: tolerant of surrounding text,
 *  quotes and whitespace, strict about the fields themselves. */
export function parsePastedBeacon(text: string): Beacon {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found — paste the whole {…} response")
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Beacon>
  if (typeof parsed.round !== "number") throw new Error("Beacon JSON is missing its round number")
  if (typeof parsed.signature !== "string" || parsed.signature.length !== 96) {
    throw new Error("Beacon JSON is missing a valid 48-byte signature")
  }
  return {
    round: parsed.round,
    randomness: typeof parsed.randomness === "string" ? parsed.randomness : "",
    signature: parsed.signature,
  }
}
