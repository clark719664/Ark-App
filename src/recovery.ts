import { QUICKNET_CHAIN_HASH, QUICKNET_GENESIS_TIME, QUICKNET_PERIOD, QUICKNET_PUBLIC_KEY } from "./config"
import type { CapsulePayload } from "./capsule"

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
