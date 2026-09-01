import { timelockEncrypt, timelockDecrypt, Buffer } from "tlock-js"
import type { ChainClient } from "drand-client"
import { armor, dearmor } from "./armor"
import { fetchBeaconFromRelays, staticClient, type Beacon } from "./drand"

// The contents of a capsule, before encryption / after decryption.
export interface CapsuleContent {
  v: 1
  letter: string
  files: Array<{ name: string; type: string; dataB64: string }>
}

/** Timelock-encrypt capsule contents to a drand round. Runs entirely
 *  client-side; the plaintext never leaves this function's caller. Returns
 *  raw age-format ciphertext bytes. */
export async function seal(content: CapsuleContent, round: number): Promise<Uint8Array> {
  const plaintext = Buffer.from(new TextEncoder().encode(JSON.stringify(content)))
  // Encryption needs no network: the "identity" is derived from the round
  // number and the embedded chain public key. staticClient provides both.
  const client = staticClient({ round: 0, randomness: "", signature: "" })
  const armored = await timelockEncrypt(round, plaintext, client)
  return dearmor(armored)
}

/** Decrypt raw age ciphertext bytes using a beacon supplied by any
 *  ChainClient. Throws if the round hasn't been reached, a relay can't be
 *  reached, or the beacon fails BLS verification. */
export async function unseal(ciphertext: Uint8Array, client: ChainClient): Promise<CapsuleContent> {
  const plaintext = await timelockDecrypt(armor(ciphertext), client)
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as CapsuleContent
  if (parsed.v !== 1 || typeof parsed.letter !== "string" || !Array.isArray(parsed.files)) {
    throw new Error("Capsule decrypted but its contents are not a valid Ark payload")
  }
  return parsed
}

/** Unseal by fetching the beacon from public relays (normal online path).
 *  Returns the beacon and relay used so the proof panel can show its work. */
export async function unsealOnline(
  ciphertext: Uint8Array,
  round: number,
): Promise<{ content: CapsuleContent; beacon: Beacon; relay: string }> {
  const { beacon, relay } = await fetchBeaconFromRelays(round)
  const content = await unseal(ciphertext, staticClient(beacon))
  return { content, beacon, relay }
}

/** Unseal with a manually supplied beacon (airgap / pasted-JSON path). */
export function unsealWithBeacon(ciphertext: Uint8Array, beacon: Beacon): Promise<CapsuleContent> {
  return unseal(ciphertext, staticClient(beacon))
}
