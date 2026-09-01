import { h, clear, fmtBytes, fmtDateTime, fmtNum, saveOrCopy } from "../ui/dom"
import { toast } from "../ui/toast"
import { renderProof, type ProofBeacon } from "../ui/proof"
import { DRAND_RELAYS, QUICKNET_CHAIN_HASH, REPO_URL } from "../config"
import {
  BeaconUnreachableError,
  parsePastedBeacon,
  timeOfRound,
  verifyBeaconSignature,
} from "../drand"
import { unsealOnline, unsealWithBeacon, type CapsuleContent } from "../tlock"
import { ciphertextBytes, type CapsulePayload } from "../capsule"
import { base64ToBytes } from "../armor"
import { recoverySpec } from "../recovery"
import { setViewCleanup } from "../state"

export interface ViewerContext {
  /** true when this document IS a downloaded capsule file */
  embedded: boolean
  /** true when showing the built-in demo capsule */
  demo: boolean
  onSealAnother: (() => void) | null
}

export function renderViewer(root: HTMLElement, payload: CapsulePayload, ctx: ViewerContext): void {
  const unlockAt = timeOfRound(payload.round)
  const card = h("div", { class: "card" })
  root.append(card)

  applyTheme(payload)

  let unlockTimer: ReturnType<typeof setTimeout> | null = null
  let countdownTimer: ReturnType<typeof setInterval> | null = null
  function clearTimers(): void {
    if (unlockTimer) clearTimeout(unlockTimer)
    if (countdownTimer) clearInterval(countdownTimer)
    unlockTimer = countdownTimer = null
  }
  // When the user navigates away, the countdown must stop and any pending
  // auto-unlock must never fire against the detached card.
  setViewCleanup(clearTimers)

  function header(): HTMLElement {
    return h("div", { style: "text-align: center" },
      h("h2", { style: "font-size: clamp(26px, 5vw, 38px); margin: 8px 0 6px" },
        payload.title || "A sealed capsule"),
      h("div", { class: "sealed-line" },
        `Sealed ${fmtDateTime(payload.sealedAt)} · opens ${fmtDateTime(unlockAt)}`,
        h("div", { class: "r" }, `drand quicknet round #${fmtNum(payload.round)}`),
        ctx.demo ? h("div", { class: "r", style: "color: var(--gold)" }, "· demonstration capsule, sealed in the past ·") : null,
      ),
    )
  }

  // ─── locked state ───
  function showLocked(): void {
    clearTimers()
    clear(card)
    const cells = {
      d: h("div", { class: "cd-num" }, "–"),
      h: h("div", { class: "cd-num" }, "–"),
      m: h("div", { class: "cd-num" }, "–"),
      s: h("div", { class: "cd-num" }, "–"),
    }
    const countdown = h("div", { class: "countdown" },
      h("div", { class: "cd-cell" }, cells.d, h("div", { class: "cd-label" }, "days")),
      h("div", { class: "cd-cell" }, cells.h, h("div", { class: "cd-label" }, "hours")),
      h("div", { class: "cd-cell" }, cells.m, h("div", { class: "cd-label" }, "minutes")),
      h("div", { class: "cd-cell" }, cells.s, h("div", { class: "cd-label" }, "seconds")),
    )

    function tick(): void {
      const left = unlockAt - Date.now()
      if (left <= 0) {
        attemptUnlock("auto")
        return
      }
      const d = Math.floor(left / 86_400_000)
      const hh = Math.floor((left % 86_400_000) / 3_600_000)
      const mm = Math.floor((left % 3_600_000) / 60_000)
      const ss = Math.floor((left % 60_000) / 1000)
      cells.d.textContent = d > 999 ? String(d) : String(d).padStart(2, "0")
      cells.h.textContent = String(hh).padStart(2, "0")
      cells.m.textContent = String(mm).padStart(2, "0")
      cells.s.textContent = String(ss).padStart(2, "0")
    }
    tick()
    countdownTimer = setInterval(tick, 500)

    card.append(
      header(),
      countdown,
      h("p", { style: "text-align: center; color: var(--ink-dim); font-size: 15px; max-width: 520px; margin: 18px auto" },
        "This capsule cannot be opened yet — not by its author, not by this software, not by anyone. ",
        "The decryption key is a signature that roughly sixteen independent organisations will jointly publish at the moment above, and not one second before."),
      h("details", { class: "acc" },
        h("summary", {}, "Proof — verify these claims yourself"),
        h("div", { class: "acc-body" }, renderProof(payload)),
      ),
      footerRow(),
    )
  }

  // ─── unlocking state ───
  const statusLine = h("div", { class: "status-line" })
  function setStatus(msg: string, spinning: boolean): void {
    statusLine.replaceChildren(...(spinning ? [h("div", { class: "spinner" })] : []), h("span", {}, msg))
  }

  function attemptUnlock(trigger: "auto" | "manual"): void {
    clearTimers()
    clear(card)
    card.append(header(), statusLine)
    void (async () => {
      try {
        let content: CapsuleContent
        let proof: ProofBeacon
        if (payload.beacon && payload.beacon.round === payload.round) {
          // Demo capsules carry their beacon so the full verify-and-decrypt
          // ritual runs with zero network — same code path, same BLS check.
          setStatus("Reading the embedded beacon record…", true)
          const verified = verifyBeaconSignature(payload.beacon)
          setStatus("Verifying BLS signature against the League of Entropy group key…", true)
          await pause(700)
          content = await unsealWithBeacon(ciphertextBytes(payload), payload.beacon)
          proof = { beacon: payload.beacon, source: "embedded record (offline)", verified }
        } else {
          setStatus(`Summoning the key — asking the drand network for round #${fmtNum(payload.round)}…`, true)
          const got = await unsealOnline(ciphertextBytes(payload), payload.round)
          content = got.content
          proof = { beacon: got.beacon, source: got.relay, verified: verifyBeaconSignature(got.beacon) }
          setStatus("Beacon received. Verifying BLS signature…", true)
          await pause(600)
        }
        showUnlocked(content, proof)
      } catch (e) {
        showUnlockError(e, trigger)
      }
    })()
  }

  // ─── error + airgap panel ───
  function showUnlockError(e: unknown, trigger: "auto" | "manual"): void {
    statusLine.replaceChildren()
    const tooEarly = e instanceof Error && /too early/i.test(e.message)
    const unreachable = e instanceof BeaconUnreachableError
    // Relays answer 404 for a round that exists on the schedule but hasn't
    // been published yet — that's "seconds early", not "offline".
    const notYet = unreachable && e.attempts.length > 0 && e.attempts.every((a) => /HTTP 404/.test(a))
    if (notYet && trigger === "auto" && Date.now() - unlockAt < 120_000) {
      setStatus("The network hasn't published this round yet — retrying…", true)
      unlockTimer = setTimeout(() => attemptUnlock("auto"), 3500)
      return
    }
    const msg = tooEarly
      ? "The network says: too early. The key for this round has not been published yet — try again at the unlock time."
      : notYet
        ? "The relays answer, but this round's key hasn't been published yet. Try again in a moment, or fetch it by hand below once the time arrives."
        : unreachable
          ? "No drand relay could be reached from here. The key may already exist — fetch it by hand below."
          : e instanceof Error ? e.message : String(e)

    card.append(
      h("div", { class: "error-box", style: "margin: 10px 0" }, msg),
      airgapPanel(),
      h("div", { class: "btn-row", style: "margin-top: 14px; justify-content: center" },
        h("button", { class: "btn", onclick: () => attemptUnlock("manual") }, "Try the network again"),
      ),
      footerRow(),
    )
    if (trigger === "auto" && tooEarly) {
      // Relays can lag a beat behind the round schedule; retry shortly.
      unlockTimer = setTimeout(() => attemptUnlock("auto"), 4000)
    }
  }

  function airgapPanel(): HTMLElement {
    const beaconUrl = `${DRAND_RELAYS[0]}/${QUICKNET_CHAIN_HASH}/public/${payload.round}`
    const pasteBox = h("textarea", {
      placeholder: `Paste the JSON from:\n${beaconUrl}`,
      style: "font-family: var(--mono); font-size: 12px; min-height: 110px",
    })
    return h("details", { class: "acc", open: true },
      h("summary", {}, "Unlock by hand — no network access required for this page"),
      h("div", { class: "acc-body" },
        h("p", {},
          "The key is public world data, not our secret. Open ",
          h("a", { href: beaconUrl, target: "_blank", rel: "noopener" }, "the beacon for this round"),
          " on any device that has internet (the link is plain JSON), then paste it here. ",
          "The signature is verified cryptographically before anything decrypts — a forged paste is rejected."),
        pasteBox,
        h("div", { class: "btn-row", style: "margin-top: 10px" },
          h("button", {
            class: "btn btn-gold",
            onclick: () => {
              void (async () => {
                try {
                  const beacon = parsePastedBeacon(pasteBox.value)
                  const verified = verifyBeaconSignature(beacon)
                  const content = await unsealWithBeacon(ciphertextBytes(payload), beacon)
                  showUnlocked(content, { beacon, source: "pasted by hand (offline)", verified })
                } catch (err) {
                  // A valid beacon plus "too early" means the DEVICE clock is
                  // behind the unlock time — the key is fine, the clock isn't.
                  if (err instanceof Error && /too early/i.test(err.message)) {
                    try {
                      if (verifyBeaconSignature(parsePastedBeacon(pasteBox.value))) {
                        toast("That beacon is valid, but this device's clock reads earlier than the unlock time — correct the clock and try again")
                        return
                      }
                    } catch { /* fall through to the generic message */ }
                  }
                  toast(err instanceof Error ? err.message : "That beacon did not unlock the capsule")
                }
              })()
            },
          }, "Verify & unlock"),
        ),
      ),
    )
  }

  // ─── unlocked state ───
  function showUnlocked(content: CapsuleContent, proof: ProofBeacon): void {
    clearTimers()
    clear(card)
    const fileNodes: Node[] = []
    for (const f of content.files) {
      const bytes = base64ToBytes(f.dataB64)
      const isImage = f.type.startsWith("image/")
      const rowChildren: Node[] = []
      if (isImage) {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: f.type }))
        fileNodes.push(h("img", { src: url, class: "reveal-img", alt: f.name }))
      }
      rowChildren.push(
        h("span", { class: "name" }, f.name),
        h("span", { class: "size" }, fmtBytes(bytes.length)),
        h("button", {
          class: "btn", style: "padding: 4px 12px; font-size: 12.5px",
          onclick: () => void saveOrCopy(f.name, new Blob([bytes as BlobPart], { type: f.type }), toast),
        }, "Save"),
      )
      fileNodes.push(h("div", { class: "file-row" }, ...rowChildren))
    }

    card.append(
      header(),
      h("p", { style: "text-align: center; color: var(--green); font-size: 14px; font-family: var(--mono)" },
        "✓ key published · ✓ signature verified · ✓ capsule opened"),
      ...(content.letter ? [h("div", { class: "letter" }, content.letter)] : []),
      ...(fileNodes.length ? [h("div", { class: "field" }, h("label", {}, "Enclosed files"), ...fileNodes)] : []),
      h("details", { class: "acc" },
        h("summary", {}, "Proof of unlock — the beacon that opened this capsule"),
        h("div", { class: "acc-body" }, renderProof(payload, proof)),
      ),
      footerRow(),
    )
  }

  function footerRow(): HTMLElement {
    const row = h("div", { class: "btn-row", style: "margin-top: 22px; justify-content: center" })
    if (ctx.onSealAnother) {
      row.append(h("button", { class: "btn", onclick: ctx.onSealAnother }, "Seal your own capsule"))
    } else if (!payload.theme?.brandless) {
      row.append(h("a", { class: "btn", href: REPO_URL, target: "_blank", rel: "noopener" }, "Sealed with Ark — get your own"))
    }
    row.append(h("button", {
      class: "btn btn-ghost",
      onclick: () => void saveOrCopy(`ark-recovery-r${payload.round}.txt`, recoverySpec(payload), toast),
    }, "Recovery spec"))
    return row
  }

  // ─── boot ───
  if (Date.now() >= unlockAt || (payload.beacon && payload.beacon.round === payload.round)) {
    attemptUnlock("auto")
  } else {
    showLocked()
    const wait = unlockAt - Date.now() + 1500
    if (wait < 2 ** 31 - 1) {
      unlockTimer = setTimeout(() => attemptUnlock("auto"), wait)
    }
  }
}

function applyTheme(payload: CapsulePayload): void {
  const accent = payload.theme?.accent
  if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
    document.documentElement.style.setProperty("--gold", accent)
    document.documentElement.style.setProperty("--gold-bright", accent)
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
