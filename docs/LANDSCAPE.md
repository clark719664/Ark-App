# Competitive Landscape

*Researched September 2026. Statuses are as observed then; re-verify before
quoting in anything public.*

The one-line read: **the mechanism exists as free demos, the emotional market
exists as big trust-based businesses, and almost nobody has productized the
two together.** Ark's slot is the intersection: real timelock cryptography ×
a paid consumer product × capsules that outlive every company involved.

## 1. Same crypto — drand tlock tools (all free, mostly demos)

| Product | Mechanism | Money | Status |
|---|---|---|---|
| [Timevault](https://timevault.drand.love) | Real tlock, client-side (drand's own reference app) | Free | Active since 2023, explicitly a demo |
| [Pastelock](https://pastelock.drand.love) | Client-side tlock, server auto-publishes at unlock | Free | Dead/offline (HTTP 530) |
| [TimeLock.dev](https://timelock.dev) | drand-based but **encrypts server-side** — plaintext leaves the browser | Free | Active, indie side project (Show HN 2024) |
| [Flowvault time-locks](https://useflowvault.com/timelock/new) | Client-side tlock inside a privacy-tools suite | Free, donations | Active |
| [Encrypter.site](https://www.encrypter.site) | Client-side, drand-keyed AES; downloads a portable `.capsule` file | Free, ads | Active |
| OpenAt (iOS) | drand-based capsule app | Free | Active, new/indie |
| [mboxly Time Vault](https://mboxly.app/time-vault) | Hybrid: client crypto + hosted delivery | **Paid** (~$5/yr per capsule) | Active, small — the only monetized drand product found |

Takeaway: the crypto is validated and endorsed (the drand team ships its own
demo), but nobody has built a *product identity* on it. mboxly charges, but
as a hosted service — its capsules die with its servers.

## 2. Same emotion — future-letter services (real money, zero cryptography)

| Product | Mechanism | Money | Status |
|---|---|---|---|
| [FutureMe](https://www.futureme.org) | Trust-based server + email | Freemium → ~$99–119 lifetime; 2025 added ads/caps on free | **20M+ letters since 2002** — the category giant |
| [Sealed](https://www.openwhenitstime.com) | Server-side encryption (server holds keys) | One-time capsule credits from $2.99 | Active, small, markets against FutureMe's paywall |
| [LetterToMyFutureSelf](https://lettertomyfutureself.net) | Trust-based server + email | Free + ~$9/yr premium | Active, ~160k users |
| [LetterMeLater](https://www.lettermelater.com) | Scheduled email queue | Freemium | Active ~20 years, 52M+ emails sent |
| EmailToFuture | Trust-based email | Free (premium "coming") | Active, early |
| Incubate | Trust-based SMS/push | Free | Dead (delisted) |

Takeaway: durable, proven willingness to pay for "messages to the future."
Every player asks users to trust a company's database and continued
existence — the exact promise Ark replaces with mathematics.

## 3. Adjacent trust market — inheritance & dead-man switches

| Product | Mechanism | Money | Status |
|---|---|---|---|
| [Everplans](https://everplans.com) | Server-side vault, human release process | ~$100/yr | Active since 2012 |
| [Killswitch](https://killswitch.app) | Client-encrypted content, check-in-based release | $79–199/yr | Active |
| [Cipherwill](https://www.cipherwill.com) | Hybrid: client-side AES + server-run dead-man switch | ~$40/yr | Active, launched ~2025 |
| [DeadMansSwitch.net](https://www.deadmansswitch.net) | Trust-based check-in emails | Freemium | Active, long-running |
| SafeBeyond | Trust-based message-after-death | Freemium, $1.1M raised | **Dead (~2022)** — the cautionary tale |
| [Sarcophagus](https://sarcophagus.io) | Token-incentivized threshold release on Arweave | SARCO fees, $5.47M raised | Nominally alive, low traction |
| Casa Inheritance | Multisig custody + legal process | Paid custody plans | Active (funds, not messages) |

Takeaway: higher price points prove the stakes; SafeBeyond's death proves the
fragility of "trust our server for decades." The crypto-native attempt
(Sarcophagus) went the token/dApp route and stalled — a warning against
requiring wallets and tokens from grieving families.

## 4. Research & infrastructure (context, not competitors)

- **Shutter Network** — threshold-encryption API for developers (B2B).
- **Shugur/Nostr time capsules** — proposed NIP using tlock; demo stage.
- **LCS35** — Rivest's 1999 MIT time-lock puzzle; solved 2019. The ancestor.
- **VeeDo (StarkWare)** — VDF-based timelock PoC; dormant since 2020.

## What this means for Ark

**The open quadrant.** Plot mechanism (trust-based ⟷ real timelock) against
maturity (free demo ⟷ monetized product): three quadrants are crowded, one is
nearly empty. Trust×product is FutureMe and the estate planners.
Crypto×demo is Timevault and friends. Crypto×product holds only mboxly —
hosted, small, capsules die with the company. Ark sits in that quadrant with
three things nobody else has:

1. **Capsule-is-the-app.** No one else ships a self-contained single-file
   capsule that carries its own decryptor and works from a USB stick after
   every company in this table is gone. (Encrypter.site's `.capsule` file
   still needs their site to open.)
2. **The recovery spec.** Every Ark capsule documents how to open itself
   with the open-source `tle` CLI — the anti-SafeBeyond guarantee, in
   plain text, inside the artifact.
3. **Offline licensing.** The business itself honors the product's thesis:
   Ed25519-verified license keys with no license server to shut down.

**The threats, honestly.**
- Timevault is free and always will be — bare text sealing can't be the paid
  feature. Charge for what demos don't do: files, size, ceremony, theming,
  inheritance workflows.
- FutureMe's brand gravity is enormous; don't out-scale it, out-promise it:
  *"your letter shouldn't die with the company — ours is one file that opens
  itself."* Their 2025 paywall grumbling is a standing invitation.
- The mechanism needs a demo-first pitch — "the key doesn't exist yet" is
  unbelievable until watched. That's what the 60-second canary and The First
  Ark are for.

**Lines of attack for launch.**
- Show HN (the mechanism is the story; TimeLock.dev's 2024 thread proves HN
  appetite, and Ark is client-side where that one wasn't).
- The crypto-inheritance crowd already pays $100+ for steel seed plates —
  file capsules + the recovery spec speak their language.
- Comparison content vs. FutureMe's paywall and SafeBeyond's shutdown —
  the "outlives us" table basically writes itself from this document.
