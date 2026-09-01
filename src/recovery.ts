import { QUICKNET_CHAIN_HASH, QUICKNET_GENESIS_TIME, QUICKNET_PERIOD, QUICKNET_PUBLIC_KEY } from "./config"
import type { CapsulePayload } from "./capsule"
import type { BundlePayload } from "./bundle"

/** Every capsule ships with a plain-text spec for opening it WITHOUT Ark —
 *  with the official open-source `tle` CLI, in any decade. The file
 *  documents how to open itself even if this app, its author, and every
 *  copy of this website are gone. */
export function recoverySpec(p: CapsulePayload): string {
  const unlockIso = new Date((QUICKNET_GENESIS_TIME + (p.round - 1) * QUICKNET_PERIOD) * 1000).toISOString()
  return `ARK CAPSULE — RECOVERY SPECIFICATION (v1)
==========================================

This capsule is a standard age-format file, timelock-encrypted (tlock) to
round ${p.round} of the drand "quicknet" randomness beacon, operated by the
League of Entropy — independent organisations including Cloudflare, EPFL,
Kudelski Security, UCL and others. The decryption key is the BLS signature
those organisations jointly publish for that round, at approximately:

    ${unlockIso}  (UTC)

Nothing and no one — not the author of this capsule, not the maker of this
software — can decrypt it before that moment, because the key does not exist
before that moment.

WHAT YOU NEED
-------------
1. The ciphertext. In an .html capsule it is the base64 "ciphertext" field
   of the JSON inside <script id="ark-payload">; decode it to bytes and you
   have a standard age encrypted file (it begins with "age-encryption.org/v1").
   In a capsule link it is the c1./c0. blob after "#" (c1 = deflate-raw
   compressed JSON, c0 = plain JSON, both base64url).
2. The "tle" tool — open source, Apache/MIT licensed:
       https://github.com/drand/tlock          (Go library + CLI)
       https://github.com/drand/tlock-js       (TypeScript)
   Install: go install github.com/drand/tlock/cmd/tle@latest

HOW TO DECRYPT (after the unlock time)
--------------------------------------
    tle --decrypt --network https://api.drand.sh \\
        --chain ${QUICKNET_CHAIN_HASH} \\
        -o contents.json  capsule.age

The decrypted contents are JSON: {"v":1,"letter":"…","files":[{"name":…,
"type":…,"dataB64":…}]}. Each file's bytes are base64 in dataB64.

IF EVERY DRAND RELAY IS GONE
----------------------------
The key for round N is the BLS12-381 signature over sha256(N as a big-endian
64-bit integer), verifiable against the quicknet group public key:

    chain hash: ${QUICKNET_CHAIN_HASH}
    public key: ${QUICKNET_PUBLIC_KEY}
    genesis:    ${QUICKNET_GENESIS_TIME} (unix), period ${QUICKNET_PERIOD}s
    scheme:     bls-unchained-g1-rfc9380

Any archive of drand beacons (they are public, mirrored, and embedded in
many blockchains) that contains round ${p.round} can open this capsule using
the tlock construction (Gailly, Melissaris, Romailler — "tlock: Practical
Timelock Encryption from Threshold BLS", 2023). The format is documented at
https://age-encryption.org and https://drand.love.

Sealed ${new Date(p.sealedAt).toISOString()} with Ark v1.
`
}

/** Recovery spec for "open when…" bundles. Trust envelopes are plaintext in
 *  the payload itself; each timelocked envelope is an independent age file
 *  openable with the tle CLI after its round. */
export function bundleRecoverySpec(b: BundlePayload): string {
  const locked = b.envelopes.filter((e) => e.kind === "timelock")
  const lockedLines = locked
    .map((e) => {
      const at = new Date((QUICKNET_GENESIS_TIME + (e.round - 1) * QUICKNET_PERIOD) * 1000).toISOString()
      return `  - "open when ${e.label}": round ${e.round}, key exists at ${at} UTC`
    })
    .join("\n")
  return `ARK BUNDLE — RECOVERY SPECIFICATION (v1)
=========================================

This file/link carries an "open when…" bundle${b.to ? ` for ${b.to}` : ""}${b.from ? ` from ${b.from}` : ""}:
${b.envelopes.length} envelopes inside a JSON payload (in an .html capsule it is
the JSON inside <script id="ark-payload">; in a link it is the c1./c0. blob
after "#" — c1 = deflate-raw compressed JSON, c0 = plain, both base64url).

TRUST-SEALED ENVELOPES (kind: "trust")
--------------------------------------
Their letters are plaintext in the payload's "letter" fields. They are sealed
by promise, like paper — anyone holding this bundle can read them at any time.

TIMELOCKED ENVELOPES (kind: "timelock")
---------------------------------------
${locked.length === 0 ? "None in this bundle." : `Each carries base64 "ciphertext": a standard age file, timelock-encrypted
(tlock) to a round of the drand quicknet beacon:

${lockedLines}

To decrypt one after its time, base64-decode its ciphertext to a file and run:

    tle --decrypt --network https://api.drand.sh \\
        --chain ${QUICKNET_CHAIN_HASH} \\
        -o letter.json  envelope.age

The result is JSON {"v":1,"letter":"…","files":[]}. The tle tool is open
source: https://github.com/drand/tlock`}

CHAIN CONSTANTS (for a world without relays)
--------------------------------------------
    chain hash: ${QUICKNET_CHAIN_HASH}
    public key: ${QUICKNET_PUBLIC_KEY}
    genesis:    ${QUICKNET_GENESIS_TIME} (unix), period ${QUICKNET_PERIOD}s
    scheme:     bls-unchained-g1-rfc9380
The key for round N is the BLS12-381 signature over sha256(N as big-endian
u64); any public archive of drand beacons can open these envelopes.

Sealed ${b.sealedAt ? new Date(b.sealedAt).toISOString() : "(date unrecorded)"} with Ark v1.
`
}
