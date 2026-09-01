# Ark

**Seal a message the universe cannot open yet.**

Ark is a cryptographic time capsule. Write a letter (or attach files), pick a
moment in the future, and Ark seals it with **timelock encryption** — not a
promise, not a server with a calendar, but mathematics with a clock:

> The decryption key for your capsule **does not exist anywhere in the
> universe** until roughly sixteen independent organisations — Cloudflare,
> EPFL, Kudelski Security, UCL and the rest of the
> [League of Entropy](https://leagueofentropy.com) — jointly create it at the
> moment you chose. Not the author of the capsule, not the maker of this
> software, not a court order can conjure it sooner. Waiting is the only
> attack that works.

No accounts. No servers. No database. The entire product compiles to **one
self-contained HTML file** that runs from a USB stick, an email attachment, or
a hard drive found in an attic — this decade or three from now.

---

## How it works

Ark implements [tlock](https://eprint.iacr.org/2023/189) (Gailly, Melissaris,
Romailler: *Practical Timelock Encryption from Threshold BLS*) against the
[drand](https://drand.love) **quicknet** beacon:

1. drand's League of Entropy publishes one BLS signature every 3 seconds —
   a signature over the round number itself. It has run without a missed beat
   since 2019, and no coalition below the signing threshold can compute a
   *future* round's signature — early decryption would take majority
   collusion across those independent organisations.
2. Your unlock date maps to a round number. Ark encrypts **to that round as
   an identity** (identity-based encryption over BLS12-381 pairings), entirely
   in your browser. Plaintext never leaves the tab.
3. When the round arrives, the network publishes its signature — which *is*
   the decryption key. Anyone holding the capsule can fetch it (or paste it by
   hand, fully offline), verify it against the League's public key, and open
   the capsule.

Capsules are standard [age](https://age-encryption.org) files. Every capsule
embeds a plain-text **recovery spec**: exact instructions for opening it with
the open-source [`tle` CLI](https://github.com/drand/tlock) — without Ark,
without us, in any decade. The file documents how to open itself.

### Three shapes of capsule

| Shape | What it is | Best for |
|---|---|---|
| **Capsule link** | The whole capsule in the URL `#fragment` — browsers never send fragments to servers, so any static host is zero-knowledge hosting | Letters, sharing by text/email |
| **`.html` capsule** | This entire app with your ciphertext sealed inside — one file, opens anywhere, forever | Inheritance, USB sticks, safes |
| **`.age` file** | Raw ciphertext for the `tle`/`age` toolchain | The paranoid and the technical |

The `.html` capsule is the trick worth noticing: **product and output are the
same file.** Every capsule *is* a full copy of Ark, including the sealer — a
capsule can beget capsules.

### “Open when…” bundles

Ark also seals **bundles**: a shelf of wax-sealed envelopes for someone you
love — *open when you can't sleep, open on the morning of the big day* — with
21 curated moments and writing prompts, envelope colours, stationery, and a
seal-cracking ritual (ported from the Open When sister product in
`openwhen/`). Each envelope chooses its seal, honestly labelled:

- **Sealed by promise** 🤞 — like paper. The letter travels privately in the
  link, and the recipient is trusted to wait for the moment.
- **Timelocked** 🔒 — a real Ark seal. The letter is tlock-encrypted to a
  drand round and *cannot* be opened early, by anyone, including its author.

A birthday envelope that mathematically refuses to open before the birthday
is the feature neither the letter apps nor the crypto demos have.

## Quick start

```bash
npm install
npm run seal-demo   # seals "The First Ark" against the live network (~20s)
npm run dev         # → http://localhost:5173
```

```bash
npm test            # 25 tests: real BLS pairings, tlock round-trips,
                    # forged-beacon rejection, codecs, licensing — all offline
npm run build       # → dist/index.html, ONE file, zero external requests
```

Try the 60-second canary: seal a capsule to "60 seconds", open the link,
watch the countdown hit zero, and see the beacon fetched, BLS-verified, and
the capsule decrypt itself. That ritual is exactly what a ten-year capsule
will do — just sooner.

## The business: Ark Pro

Free tier seals letters (4,000 chars) with every cryptographic guarantee.
**Ark Pro** ($4.99, one-time) unlocks file attachments up to 20 MB, 100k-char
letters, custom accent colour, and brand-free capsules.

Licenses are **Ed25519-signed keys verified offline** in the browser — no
license server, no phone-home, nothing to shut down. The infrastructure is
this repo:

```
tools/keygen.mjs        mint your signing keypair (once)
tools/sign-license.mjs  mint a license key by hand (day-one fulfillment)
server/webhook.mjs      zero-dependency Stripe webhook → auto-mint → email
```

### Go-live checklist (three paste-ins)

1. `npm run keygen` → paste the printed public key into
   `LICENSE_PUBLIC_KEY_HEX` in `src/config.ts`. Back up `secrets/`.
2. Create a [Stripe Payment Link](https://stripe.com/payments/payment-links)
   for a $4.99 product → paste its URL into `PAYMENT_LINK` in `src/config.ts`.
3. Fulfillment, pick one:
   - **Manual (day one):** Stripe emails you on each sale → run
     `npm run sign-license -- buyer@email.com` → reply with the key.
   - **Automatic:** deploy `server/webhook.mjs` anywhere Node runs, point a
     Stripe webhook (`checkout.session.completed`) at
     `/webhook/stripe`, set `STRIPE_WEBHOOK_SECRET` + `RESEND_API_KEY`.

`npm run build`, put `dist/index.html` on any static host (GitHub Pages,
Cloudflare Pages, a $0 bucket), and you are selling.

## Security model, honestly

- **What Ark guarantees:** confidentiality until the round arrives, enforced
  by the discrete log problem on BLS12-381 and the honesty of *a threshold*
  of League members (no single member — or minority coalition — can early-decrypt).
- **What Ark does not guarantee:** secrecy *after* unlock (anyone holding the
  capsule can open it then — that is the product), or availability of the
  drand network decades out (it has run since 2019; the recovery spec covers
  even the network-vanishes case, since beacons are public, mirrored data).
- **Verify, don't trust:** every capsule's proof panel shows the chain hash,
  group key, target round, and — on unlock — the explicit BLS verification of
  the beacon that opened it. A forged or tampered beacon is rejected; the
  tests prove it (`tests/tlock.test.ts`).
- Sealing is irreversible by design. There is no recovery from "I picked the
  wrong date." The UI says so before you click.

## Repository map

```
src/
  main.ts        boot, routing, header/hero — and the pristine-HTML capture
                 that makes capsule downloads possible
  tlock.ts       seal/unseal wrappers around tlock-js
  drand.ts       round math, multi-relay client, offline client, explicit BLS verify
  capsule.ts     payload format, #fragment codec, .html capsule injection
  armor.ts       age armor + base64 codecs
  license.ts     offline Ed25519 license verification
  recovery.ts    the self-documenting recovery spec
  views/         sealer, result, viewer (countdown → verify → reveal)
  ui/            starfield, proof panel, modals, Pro, toasts — no framework
server/webhook.mjs   Stripe fulfillment, zero dependencies
tools/               keygen, license minting, demo-capsule sealing
tests/               25 tests against a recorded League of Entropy beacon
```

No framework, no analytics, no CDN, no cookies. Dependencies that ship to the
browser: `tlock-js`, `drand-client`, `@noble/curves`, `@noble/ed25519` —
audited primitives, ~280 KB total, inlined into the single file.

## Also aboard: Open When 💌

This repo carries a sister product in [`openwhen/`](openwhen/): **Open When** —
bundles of sealed "open when…" letters (*open when you can't sleep, open on
the morning of the big day*) delivered as a single private link, with a
wax-seal-cracking ritual and stationery choices. Same philosophy, opposite
temperament: the letters live inside the link itself (no server, no accounts),
but its date locks are sealed by **trust**, like paper — where Ark's are sealed
by mathematics. One warm, one cosmic; both are single HTML files that outlive
their maker. `npm run test:openwhen` runs its suite; open
`openwhen/index.html` to try it.

A natural future integration: an Open When envelope whose date lock is a real
Ark timelock — the paper ritual with the cryptographic padlock.

---

*The future is a place. Ark is how you send something there.*
