import { describe, expect, it } from "vitest"
import { armor, dearmor, base64ToBytes, base64UrlToBytes, bytesToBase64, bytesToBase64Url } from "../src/armor"

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  return out
}

describe("age armor", () => {
  it("round-trips arbitrary bytes", () => {
    for (const n of [0, 1, 63, 64, 65, 4096, 100_000]) {
      const bytes = randomBytes(n)
      expect(dearmor(armor(bytes))).toEqual(bytes)
    }
  })

  it("wraps base64 at 64 columns like the age spec", () => {
    const lines = armor(randomBytes(1000)).trim().split("\n")
    for (const line of lines.slice(1, -2)) expect(line.length).toBe(64)
  })

  it("rejects non-armored input", () => {
    expect(() => dearmor("hello world")).toThrow()
  })
})

describe("base64 codecs", () => {
  it("base64 round-trips including multi-chunk sizes", () => {
    const big = randomBytes(300_000) // crosses the 32k chunking boundary
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big)
  })

  it("base64url round-trips and is URL-safe", () => {
    for (const n of [1, 2, 3, 4, 5, 1000]) {
      const bytes = randomBytes(n)
      const enc = bytesToBase64Url(bytes)
      expect(enc).not.toMatch(/[+/=]/)
      expect(base64UrlToBytes(enc)).toEqual(bytes)
    }
  })
})
