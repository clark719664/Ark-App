#!/usr/bin/env node
// Seal "The First Ark" — the demo capsule embedded in the app so anyone can
// watch a REAL verify-and-decrypt, offline. It is sealed to a round a few
// seconds ahead, then we wait for the League of Entropy to publish that
// round's beacon and record it next to the ciphertext. Nothing is mocked:
// the ciphertext is real tlock output; the beacon is the network's real
// signature; the app verifies it with real BLS pairings on every open.
//   npm run seal-demo
import { writeFileSync } from "node:fs"
import { timelockEncrypt, mainnetClient, roundAt } from "tlock-js"

const CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
const OUT = new URL("../src/demo-generated.json", import.meta.url)

const LETTER = `If you can read this, the mechanism kept its word.

This capsule was sealed on ${new Date().toISOString().slice(0, 10)}, in the same hour Ark itself was built. When it was sealed, the key that just opened it did not exist — not on this machine, not on any server, not anywhere. It was created seconds later by a network of independent organisations who sign the passage of time itself, three seconds at a stride, and who have never missed a beat since 2019.

No one asked them to make your key. They would have made it anyway. That is the whole trick: the lock is addressed to a moment, and moments always arrive.

Whatever you choose to seal — a letter to your children, the truth about something, a promise you intend to keep — the mathematics will hold it exactly as long as you asked, and not one second longer.

The future is a place. You have just watched a message arrive there.

— The First Ark`

const client = mainnetClient()
const info = await client.chain().info()
if (info.hash !== CHAIN_HASH) {
  console.error(`Unexpected chain ${info.hash}`)
  process.exit(1)
}

const sealedAt = Date.now()
const round = roundAt(sealedAt + 8000, info)
console.log(`Sealing demo capsule to round ${round} (~8s out)…`)

const content = { v: 1, letter: LETTER, files: [] }
const armored = await timelockEncrypt(round, Buffer.from(JSON.stringify(content)), client)

// strip armor → raw bytes → base64 (matches src/armor.ts dearmor)
const body = armored.trim().split(/\r?\n/).slice(1, -1).join("")
const ciphertextB64 = body // armor body IS base64 already

console.log("Waiting for the League of Entropy to publish the round…")
await new Promise((r) => setTimeout(r, 11_000))

const res = await fetch(`https://api.drand.sh/${CHAIN_HASH}/public/${round}`)
if (!res.ok) {
  console.error(`Beacon fetch failed: HTTP ${res.status}`)
  process.exit(1)
}
const beacon = await res.json()
if (beacon.round !== round) {
  console.error(`Relay returned round ${beacon.round}, wanted ${round}`)
  process.exit(1)
}

const payload = {
  v: 1,
  title: "The First Ark",
  sealedAt,
  round,
  chainHash: CHAIN_HASH,
  ciphertext: ciphertextB64,
  beacon: { round: beacon.round, randomness: beacon.randomness, signature: beacon.signature },
}

writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n")
console.log(`Demo capsule written to src/demo-generated.json (round ${round}, beacon recorded).`)
console.log("Rebuild the app to embed it.")
