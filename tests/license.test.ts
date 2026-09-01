import { describe, expect, it } from "vitest"
import * as ed from "@noble/ed25519"
import { verifyLicenseKey } from "../src/license"
// tools/license-lib.mjs is the minting side used by the keygen CLI and the
// Stripe webhook — this test proves mint and verify agree end-to-end.
// @ts-expect-error plain-JS module without type declarations
import { mintLicense, publicKeyFor } from "../tools/license-lib.mjs"

const priv = new Uint8Array(32).fill(7)

describe("license keys", () => {
  it("mints a key the client verifies offline", async () => {
    const pub = (await publicKeyFor(priv)) as string
    const key = (await mintLicense(priv, "buyer@example.com", "2026-09-01")) as string
    expect(key.startsWith("ARK1.")).toBe(true)
    const claim = await verifyLicenseKey(key, pub)
    expect(claim.email).toBe("buyer@example.com")
    expect(claim.tier).toBe("ARK-PRO")
  })

  it("rejects keys signed by a different keypair", async () => {
    const otherPub = Buffer.from(await ed.getPublicKeyAsync(new Uint8Array(32).fill(9))).toString("hex")
    const key = (await mintLicense(priv, "buyer@example.com")) as string
    await expect(verifyLicenseKey(key, otherPub)).rejects.toThrow(/not valid/)
  })

  it("rejects tampered claims", async () => {
    const pub = (await publicKeyFor(priv)) as string
    const key = (await mintLicense(priv, "buyer@example.com")) as string
    const [tag, , sig] = key.split(".")
    const forgedClaim = Buffer.from(JSON.stringify({ email: "thief@example.com", tier: "ARK-PRO", issued: "2026-09-01" })).toString("base64url")
    await expect(verifyLicenseKey(`${tag}.${forgedClaim}.${sig}`, pub)).rejects.toThrow()
  })

  it("rejects garbage", async () => {
    await expect(verifyLicenseKey("ARK1.not.real", "aa".repeat(32))).rejects.toThrow()
    await expect(verifyLicenseKey("hello", "aa".repeat(32))).rejects.toThrow()
  })
})
