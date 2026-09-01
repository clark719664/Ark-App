import { h, fmtNum } from "./dom"
import { QUICKNET_CHAIN_HASH, QUICKNET_PUBLIC_KEY, QUICKNET_SCHEME } from "../config"
import { timeOfRound, type Beacon } from "../drand"
import type { CapsulePayload } from "../capsule"

export interface ProofBeacon {
  beacon: Beacon
  source: string // "api.drand.sh", "pasted by hand", "embedded record", …
  verified: boolean
}

function trunc(s: string, n = 26): string {
  return s.length <= n ? s : `${s.slice(0, n)}…${s.slice(-6)}`
}

/** The proof panel shows its work: which network must sign what, and — once
 *  a beacon arrives — the explicit BLS12-381 verification result. Nothing
 *  here is decorative; every value can be checked against api.drand.sh. */
export function renderProof(payload: CapsulePayload, proof?: ProofBeacon): HTMLElement {
  const row = (k: string, v: Node | string, cls = "v"): HTMLElement =>
    h("div", { class: "row" }, h("span", { class: "k" }, k), h("span", { class: cls }, v))

  const panel = h(
    "div",
    { class: "proof" },
    row("mechanism", "tlock (IBE on BLS12-381) · age v1 · ChaCha20-Poly1305"),
    row("network", "drand quicknet — League of Entropy"),
    row("chain hash", trunc(QUICKNET_CHAIN_HASH, 30)),
    row("group key", trunc(QUICKNET_PUBLIC_KEY, 30)),
    row("scheme", QUICKNET_SCHEME),
    row("target round", h("span", {}, `#${fmtNum(payload.round)}`), "v gold"),
    row("key exists at", new Date(timeOfRound(payload.round)).toUTCString()),
  )

  if (proof) {
    panel.append(
      row("beacon round", `#${fmtNum(proof.beacon.round)}`),
      row("beacon source", proof.source),
      row("BLS signature", trunc(proof.beacon.signature, 30)),
      proof.verified
        ? row("verification", "✓ signature valid for League of Entropy group key", "v ok")
        : row("verification", "✗ SIGNATURE INVALID — beacon rejected", "v bad"),
    )
  } else {
    panel.append(row("decryption key", "does not exist yet — anywhere", "v gold"))
  }
  return panel
}
