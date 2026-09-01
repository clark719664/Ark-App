import { describe, expect, it } from "vitest"
import { decodeFragment, encodeFragment, injectCapsule, makePayload, validatePayload, type CapsulePayload } from "../src/capsule"
import { QUICKNET_CHAIN_HASH } from "../src/config"

function samplePayload(): CapsulePayload {
  return makePayload({
    title: "Test capsule",
    round: 123_456,
    ciphertext: new TextEncoder().encode("age-encryption.org/v1 fake bytes for codec testing"),
    sealedAt: 1_756_700_000_000,
  })
}

describe("fragment codec", () => {
  it("round-trips a payload through the compressed fragment", async () => {
    const payload = samplePayload()
    const frag = await encodeFragment(payload)
    expect(frag.startsWith("c1.")).toBe(true)
    expect(frag).not.toMatch(/[+/=#]/)
    const decoded = await decodeFragment("#" + frag)
    expect(decoded).toEqual(payload)
  })

  it("returns null for unrelated fragments", async () => {
    expect(await decodeFragment("#some-anchor")).toBeNull()
    expect(await decodeFragment("")).toBeNull()
  })

  it("rejects a payload aimed at a different chain", async () => {
    const payload = { ...samplePayload(), chainHash: "beef".repeat(16) }
    await expect(async () => {
      const frag = await encodeFragment(payload)
      await decodeFragment(frag)
    }).rejects.toThrow(/different drand chain/)
  })
})

describe("validatePayload", () => {
  it("accepts a well-formed payload", () => {
    expect(() => validatePayload(samplePayload())).not.toThrow()
  })
  it("rejects bad rounds and missing ciphertext", () => {
    expect(() => validatePayload({ ...samplePayload(), round: 0 })).toThrow()
    expect(() => validatePayload({ ...samplePayload(), ciphertext: "" })).toThrow()
    expect(() => validatePayload({ ...samplePayload(), v: 2 as never })).toThrow()
  })
})

describe("capsule HTML injection", () => {
  const pristine = `<!doctype html>\n<html><head><script id="ark-payload" type="application/json">null</script><script>app()</script></head><body></body></html>`

  it("injects a payload into the marker and escapes </script>", () => {
    const payload = { ...samplePayload(), title: `sneaky</script><script>alert(1)</script>` }
    const html = injectCapsule(pristine, payload)
    expect(html).toContain(`<script id="ark-payload" type="application/json">{`)
    // the closing tag inside the title must be neutralised
    const markerStart = html.indexOf('id="ark-payload"')
    const injected = html.slice(markerStart, html.indexOf("</script>", markerStart))
    expect(injected).not.toContain("</script>")
    expect(injected).toContain("\\u003c/script>")
    // and the parsed JSON must round-trip the original title
    const jsonText = injected.slice(injected.indexOf(">") + 1)
    expect((JSON.parse(jsonText) as CapsulePayload).title).toBe(payload.title)
  })

  it("keeps the rest of the document byte-identical", () => {
    const html = injectCapsule(pristine, samplePayload())
    expect(html.endsWith(`<script>app()</script></head><body></body></html>`)).toBe(true)
    expect(html.startsWith(`<!doctype html>`)).toBe(true)
  })

  it("throws when the marker is missing", () => {
    expect(() => injectCapsule("<html></html>", samplePayload())).toThrow(/marker/)
  })

  it("produces a payload the chain validator accepts", () => {
    const html = injectCapsule(pristine, samplePayload())
    const m = html.match(/<script id="ark-payload" type="application\/json">(.*?)<\/script>/s)
    expect(m).toBeTruthy()
    const parsed = JSON.parse(m![1]) as CapsulePayload
    expect(parsed.chainHash).toBe(QUICKNET_CHAIN_HASH)
    expect(() => validatePayload(parsed)).not.toThrow()
  })
})
