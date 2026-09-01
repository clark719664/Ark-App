#!/usr/bin/env node
// Generate the Ed25519 keypair that signs Ark Pro licenses.
//   npm run keygen
// Writes the private key to secrets/license-signing-key.hex (gitignored) and
// prints the public key to paste into src/config.ts. Run once, back up the
// secrets/ directory somewhere safe, never commit it.
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { webcrypto } from "node:crypto"
import { bytesToHex, publicKeyFor } from "./license-lib.mjs"

const KEY_PATH = new URL("../secrets/license-signing-key.hex", import.meta.url)

if (existsSync(KEY_PATH)) {
  console.error(`Refusing to overwrite existing key at ${KEY_PATH.pathname}`)
  console.error("Delete it first if you truly want a new keypair — existing licenses will stop verifying.")
  process.exit(1)
}

const priv = webcrypto.getRandomValues(new Uint8Array(32))
mkdirSync(new URL("../secrets/", import.meta.url), { recursive: true })
writeFileSync(KEY_PATH, bytesToHex(priv) + "\n", { mode: 0o600 })

const pub = await publicKeyFor(priv)
console.log("Ed25519 license keypair generated.\n")
console.log(`  private key → ${KEY_PATH.pathname}   (KEEP SAFE, NEVER COMMIT)`)
console.log(`  public key  → ${pub}\n`)
console.log("Paste the public key into src/config.ts:")
console.log(`  export const LICENSE_PUBLIC_KEY_HEX =\n    "${pub}"`)
