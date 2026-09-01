import { describe, expect, it } from "vitest"
import { seal, unseal, unsealWithBeacon, type CapsuleContent } from "../src/tlock"
import { normalizeBeacon, parsePastedBeacon, staticClient, verifyBeaconSignature, roundAt, timeOfRound, roundForUnlock, type Beacon } from "../src/drand"
import fixtureBeacon from "./fixtures/beacon-31806951.json"

// These tests run the REAL cryptography — BLS12-381 pairings, age format,
// ChaCha20-Poly1305 — against a recorded quicknet beacon, fully offline and
// deterministic. Nothing is stubbed below the network layer.

const beacon = fixtureBeacon as Beacon

const content: CapsuleContent = {
  v: 1,
  letter: "To whoever finds this: the mechanism worked.",
  files: [{ name: "note.txt", type: "text/plain", dataB64: btoa("hello from the past") }],
}

describe("timelock seal/unseal (offline, real crypto)", () => {
  it("round-trips through a past round using its recorded beacon", async () => {
    const ciphertext = await seal(content, beacon.round)
    expect(ciphertext.length).toBeGreaterThan(200)
    const opened = await unsealWithBeacon(ciphertext, beacon)
    expect(opened).toEqual(content)
  }, 30_000)

  it("refuses to decrypt before the round arrives", async () => {
    const futureRound = roundAt(Date.now() + 3_600_000)
    const ciphertext = await seal(content, futureRound)
    await expect(unseal(ciphertext, staticClient(beacon))).rejects.toThrow(/too early/i)
  }, 30_000)

  it("rejects a forged beacon even for the correct round", async () => {
    const ciphertext = await seal(content, beacon.round)
    const forged: Beacon = { ...beacon, signature: beacon.signature.replace(/^82fb/, "82fc") }
    await expect(unsealWithBeacon(ciphertext, forged)).rejects.toThrow()
  }, 30_000)
})

describe("beacon verification (explicit BLS)", () => {
  it("accepts the recorded League of Entropy beacon", () => {
    expect(verifyBeaconSignature(beacon)).toBe(true)
  })
  it("rejects tampered signatures and wrong rounds", () => {
    expect(verifyBeaconSignature({ ...beacon, signature: "00".repeat(48) })).toBe(false)
    expect(verifyBeaconSignature({ ...beacon, round: beacon.round + 1 })).toBe(false)
  })
})

describe("beacon normalization", () => {
  it("derives randomness = sha256(signature) when the field is missing", async () => {
    const bare = { round: beacon.round, signature: beacon.signature }
    const normalized = normalizeBeacon(bare)
    expect(normalized.randomness).toBe(beacon.randomness)
    // and the derived beacon actually decrypts (full drand-client validation)
    const ciphertext = await seal(content, beacon.round)
    expect(await unsealWithBeacon(ciphertext, normalized)).toEqual(content)
  }, 30_000)

  it("rejects a randomness field that contradicts the signature", () => {
    expect(() => normalizeBeacon({ ...beacon, randomness: "ab".repeat(32) })).toThrow(/randomness/)
  })

  it("parses a hand-pasted beacon with surrounding noise", () => {
    const pasted = parsePastedBeacon(`response was:\n ${JSON.stringify(beacon)} \nHTTP 200`)
    expect(pasted).toEqual(beacon)
    expect(() => parsePastedBeacon("no json here")).toThrow()
    expect(() => parsePastedBeacon(`{"round": 1e999, "signature": "${beacon.signature}"}`)).toThrow(/round/)
  })
})

describe("round arithmetic", () => {
  it("timeOfRound inverts roundAt on round boundaries", () => {
    const t = timeOfRound(31_806_951)
    expect(roundAt(t)).toBe(31_806_951)
    expect(roundAt(t - 1)).toBe(31_806_950)
  })
  it("roundForUnlock never opens early", () => {
    for (const offset of [0, 1, 1000, 2999, 3000, 4500]) {
      const wanted = timeOfRound(32_000_000) + offset
      const round = roundForUnlock(wanted)
      expect(timeOfRound(round)).toBeGreaterThanOrEqual(wanted)
      expect(timeOfRound(round) - wanted).toBeLessThan(3000)
    }
  })
})
