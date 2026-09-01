import { h } from "./dom"
import { openModal } from "./modal"

function step(n: string, title: string, body: string): HTMLElement {
  return h(
    "div",
    { class: "how-step" },
    h("div", { class: "how-num" }, n),
    h("div", {}, h("b", { class: "serif", style: "font-size: 16.5px" }, title), h("p", {}, body)),
  )
}

export function openHowItWorks(): void {
  openModal(
    h("h2", {}, "How a capsule stays sealed"),
    h(
      "p",
      { style: "color: var(--ink-dim); font-size: 14.5px" },
      "Ark is not a promise to keep your secret. It is timelock encryption (tlock): ",
      "identity-based encryption over BLS12-381 pairings, against the drand randomness beacon. ",
      "Every claim below is checkable — the proof panel on every capsule shows the raw values.",
    ),
    step(
      "1",
      "A network that publishes keys on a clock",
      "Roughly sixteen independent organisations — Cloudflare, EPFL, Kudelski Security, UCL and others, together the League of Entropy — jointly sign each round number: one BLS signature every 3 seconds, for years without a missed beat. No coalition smaller than the signing threshold can compute a future round's signature — opening a capsule early would take majority collusion across those independent organisations.",
    ),
    step(
      "2",
      "Your date becomes an identity",
      "Ark converts your unlock moment into a round number, and encrypts to that round AS AN IDENTITY — like addressing a letter to a moment in time. This happens entirely in your browser; your words never leave it.",
    ),
    step(
      "3",
      "The key literally does not exist yet",
      "The decryption key for round N is the network's signature over N — a value that is not computed, stored, or known anywhere until the round arrives. There is no server to subpoena, no admin to bribe, no database to breach. Waiting is the only attack that works.",
    ),
    step(
      "4",
      "Anyone can open it — after, and only after",
      "When the moment arrives, the signature is published openly. Your capsule fetches it (or you paste it by hand, fully offline), verifies it against the League's public key, and decrypts. It works in this app, or with the open-source tle CLI, decades from now.",
    ),
    h(
      "p",
      { class: "hint", style: "margin-top: 18px" },
      "Construction: “tlock: Practical Timelock Encryption from Threshold BLS” — Gailly, Melissaris, Romailler (2023). ",
      "Network: drand.love. Format: age-encryption.org — capsules are standard age files.",
    ),
  )
}
