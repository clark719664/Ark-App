// ─── Go-live configuration ────────────────────────────────────────────────
// Ark runs with zero backend. Going live with Ark Pro requires exactly three
// steps (see README):
//   1. `npm run keygen` → paste the public key below, keep the private key safe
//   2. Create a Stripe Payment Link (or Gumroad/Lemon Squeezy product) → paste
//      its URL below
//   3. Deploy server/webhook.mjs (or fulfil manually with `npm run sign-license`)

/** Where the "Buy Ark Pro" button sends people. Replace with your real
 *  Stripe Payment Link. Until then it points at the docs explaining setup. */
export const PAYMENT_LINK = "https://buy.stripe.com/REPLACE_ME"

/** Ed25519 public key (hex) that license keys are verified against — offline,
 *  in the browser. The matching private key never ships. This default is the
 *  repo's DEMO keypair (see tools/keygen.mjs output in README); replace it
 *  with your own before selling. */
export const LICENSE_PUBLIC_KEY_HEX =
  "REPLACE_WITH_KEYGEN_OUTPUT"

export const PRO_PRICE = "$4.99"
export const PRO_TIER = "ARK-PRO"

// ─── Product limits ───────────────────────────────────────────────────────
export const FREE_LETTER_MAX = 4_000 // characters
export const PRO_LETTER_MAX = 100_000
export const PRO_FILES_MAX_BYTES = 20 * 1024 * 1024 // 20 MB per capsule
export const LINK_CIPHERTEXT_SOFT_MAX = 24 * 1024 // beyond this, suggest the .html capsule
/** Chromium refuses to navigate URLs beyond ~2MB. Past this ciphertext size
 *  a capsule link would be a dead link, so we don't offer one at all. */
export const LINK_CIPHERTEXT_HARD_MAX = 1_200_000
/** Ceiling for inflating a c1. fragment — a legitimate link payload is under
 *  ~3MB inflated; anything bigger is a decompression bomb, not a capsule. */
export const FRAGMENT_INFLATED_MAX = 8 * 1024 * 1024

/** Furthest allowed unlock date. The League of Entropy has run since 2019 and
 *  quicknet carries no announced end date, but honesty matters: we surface a
 *  longevity note in the UI past 10 years. */
export const MAX_HORIZON_YEARS = 30

// ─── drand quicknet chain constants ───────────────────────────────────────
// These are world-public facts about the League of Entropy quicknet chain,
// embedded so the app can compute rounds, verify beacons, and decrypt with
// zero network access. Cross-check them yourself:
//   https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info
export const QUICKNET_CHAIN_HASH =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"

export const QUICKNET_PUBLIC_KEY =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"

export const QUICKNET_GENESIS_TIME = 1692803367 // unix seconds
export const QUICKNET_PERIOD = 3 // seconds per round
export const QUICKNET_SCHEME = "bls-unchained-g1-rfc9380"

/** Public HTTP relays for the drand network, tried in order. Anyone can run
 *  one; these are the canonical public endpoints. */
export const DRAND_RELAYS = [
  "https://api.drand.sh",
  "https://drand.cloudflare.com",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
]

export const APP_NAME = "Ark"
export const APP_VERSION = "1.0.0"
export const REPO_URL = "https://github.com/clark719664/Ark-App"
