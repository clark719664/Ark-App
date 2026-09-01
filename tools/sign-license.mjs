#!/usr/bin/env node
// Mint an Ark Pro license key by hand — day-one fulfillment needs nothing else:
//   npm run sign-license -- buyer@example.com
// Reads the private key from secrets/license-signing-key.hex (or the
// LICENSE_SIGNING_KEY env var, hex).
import { readFileSync, existsSync } from "node:fs"
import { hexToBytes, mintLicense } from "./license-lib.mjs"

const email = process.argv[2]
if (!email || !email.includes("@")) {
  console.error("Usage: npm run sign-license -- buyer@example.com")
  process.exit(1)
}

const KEY_PATH = new URL("../secrets/license-signing-key.hex", import.meta.url)
const hex = process.env.LICENSE_SIGNING_KEY ?? (existsSync(KEY_PATH) ? readFileSync(KEY_PATH, "utf8") : null)
if (!hex) {
  console.error("No signing key found. Run `npm run keygen` first (or set LICENSE_SIGNING_KEY).")
  process.exit(1)
}

const key = await mintLicense(hexToBytes(hex), email.trim().toLowerCase())
console.log(`\nArk Pro license for ${email}:\n`)
console.log(key)
console.log("\nSend this to the buyer — they paste it under “Ark Pro → Already have a key?”.")
