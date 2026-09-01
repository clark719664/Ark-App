import { h, clear, fmtDateTime, fmtNum, saveOrCopy } from "../ui/dom"
import { toast } from "../ui/toast"
import { DRAND_RELAYS, QUICKNET_CHAIN_HASH, REPO_URL } from "../config"
import {
  BeaconUnreachableError,
  parsePastedBeacon,
  timeOfRound,
  verifyBeaconSignature,
} from "../drand"
import { unsealOnline, unsealWithBeacon } from "../tlock"
import { base64ToBytes } from "../armor"
import { bundleFingerprint, type BundlePayload, type SealedEnvelope } from "../bundle"
import { bundleRecoverySpec } from "../recovery"
import { setViewCleanup } from "../state"

export interface ShelfContext {
  embedded: boolean
  onSealAnother: (() => void) | null
}

/** The recipient's side of an "open when…" bundle: a shelf of wax-sealed
 *  envelopes. Promise seals crack on click — a small ritual. Timelocked
 *  seals show a countdown and physically cannot crack until the drand round
 *  arrives; then the same ritual plays. */
export function renderShelf(root: HTMLElement, bundle: BundlePayload, ctx: ShelfContext): void {
  const card = h("div", { class: "card" })
  root.append(card)

  let opened = new Set<number>()
  let storageKey = ""
  void bundleFingerprint(bundle).then((fp) => {
    storageKey = `ark.bundle.opened.${fp}`
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as number[]
      opened = new Set(saved.filter((n) => Number.isInteger(n)))
    } catch { /* fresh shelf */ }
    renderGrid()
  })
  function persistOpened(): void {
    try {
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify([...opened]))
    } catch { /* private windows may refuse; the shelf still works */ }
  }

  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = []
  setViewCleanup(() => {
    for (const t of timers) { clearInterval(t as never); clearTimeout(t as never) }
    ritualHost?.remove()
  })

  // ── header + shelf grid ──
  const progress = h("span", { class: "hint" })
  const grid = h("div", { class: "shelf" })

  card.append(
    h("div", { style: "text-align: center; margin-bottom: 18px" },
      bundle.from ? h("div", { class: "from-line" }, `from ${bundle.from}`) : null,
      h("h2", { style: "font-size: clamp(24px, 4.5vw, 34px); margin: 4px 0 6px" },
        bundle.to ? `Letters for ${bundle.to}` : "Someone sealed letters for you"),
      h("p", { class: "hint", style: "max-width: 460px; margin: 0 auto" },
        "Each envelope is for a different moment. Open each one when its moment comes — that's the whole magic. ",
        "The locked ones aren't a request: they mathematically cannot open early."),
      h("div", { style: "margin-top: 8px" }, progress),
    ),
    grid,
  )

  function envelopeNode(env: SealedEnvelope, index: number): HTMLElement {
    const isOpened = opened.has(index)
    const locked = env.kind === "timelock" && Date.now() < timeOfRound(env.round)
    const lockBadge = env.kind === "timelock"
      ? h("span", { class: "env-lock" }, locked ? `🔒 ${shortUntil(timeOfRound(env.round))}` : "🔓 unlocked")
      : null

    const node = h("button", {
      class: `envelope env-${env.color}${isOpened ? " opened" : ""}${locked ? " locked" : ""}`,
      "aria-label": `open when ${env.label}`,
      onclick: () => {
        if (env.kind === "timelock" && Date.now() < timeOfRound(env.round)) {
          node.classList.remove("wiggling")
          void node.offsetWidth // restart the animation
          node.classList.add("wiggling")
          openRitual(env, index) // shows the countdown state
          return
        }
        openRitual(env, index)
      },
    },
      h("div", { class: "env-flap" }),
      h("div", { class: "env-body" }),
      isOpened ? null : waxSeal(env.emoji || "✉"),
      lockBadge,
      h("div", { class: "env-label" }, h("em", {}, "open when"), env.label),
    )
    return node
  }

  const loopSlot = h("div", {})
  function renderGrid(): void {
    clear(grid)
    clear(loopSlot)
    bundle.envelopes.forEach((env, i) => grid.append(envelopeNode(env, i)))
    progress.textContent = `${opened.size} of ${bundle.envelopes.length} opened`
    if (opened.size === bundle.envelopes.length) {
      loopSlot.append(
        h("div", { style: "text-align: center; margin-top: 24px" },
          h("p", {}, bundle.from ? `${bundle.from} made this for you, just because.` : "Someone made this for you, just because."),
          ctx.onSealAnother
            ? h("button", { class: "btn btn-gold", onclick: ctx.onSealAnother }, "Make one for someone you love →")
            : h("a", { class: "btn btn-gold", href: REPO_URL, target: "_blank", rel: "noopener" }, "Make one for someone you love →"),
        ),
      )
    }
  }
  grid.after(loopSlot)
  // refresh lock badges / lockability as countdowns run out
  timers.push(setInterval(renderGrid, 30_000))

  renderGrid()

  card.append(
    h("div", { class: "btn-row", style: "margin-top: 22px; justify-content: center" },
      h("button", {
        class: "btn btn-ghost",
        onclick: () => void saveOrCopy("ark-bundle-recovery.txt", bundleRecoverySpec(bundle), toast),
      }, "Recovery spec"),
    ),
  )

  // ── wax seal ──
  function waxSeal(glyph: string): HTMLElement {
    return h("div", { class: "seal" },
      h("div", { class: "half l" }, glyph),
      h("div", { class: "half r" }),
      h("div", { class: "frag f1", style: "--fx: 14px; --fy: 18px" }),
      h("div", { class: "frag f2", style: "--fx: -16px; --fy: 14px" }),
      h("div", { class: "frag f3", style: "--fx: 6px; --fy: -16px" }),
    )
  }

  // ── the ritual overlay ──
  let ritualHost: HTMLElement | null = null

  function openRitual(env: SealedEnvelope, index: number): void {
    ritualHost?.remove()
    const stage = h("div", { class: "ritual-stage" })
    const closeBtn = h("button", { class: "ritual-close", "aria-label": "Put the letter back" }, "✕")
    ritualHost = h("div", { class: "ritual", role: "dialog", "aria-modal": "true" }, closeBtn, stage)
    closeBtn.addEventListener("click", closeRitual)
    document.body.append(ritualHost)

    if (env.kind === "trust" || Date.now() >= timeOfRound(env.round)) {
      showSealedEnvelope(env, index, stage)
    } else {
      showLockedState(env, stage)
    }
  }

  function closeRitual(): void {
    ritualHost?.remove()
    ritualHost = null
  }

  function showSealedEnvelope(env: SealedEnvelope, index: number, stage: HTMLElement): void {
    clear(stage)
    const seal = waxSeal(env.emoji || "✉")
    const bigEnv = h("div", { class: `envelope env-${env.color}`, style: "cursor: pointer" },
      h("div", { class: "env-flap" }),
      h("div", { class: "env-body" }),
      seal,
      h("div", { class: "env-label" }, h("em", {}, "open when"), env.label),
    )
    const hint = h("div", { class: "tap-hint" }, "crack the seal")
    stage.append(bigEnv, hint)

    let cracked = false
    bigEnv.addEventListener("click", () => {
      if (cracked) return
      cracked = true
      seal.classList.add("cracked")
      bigEnv.classList.add("opened")
      try { navigator.vibrate?.(18) } catch { /* not everywhere */ }
      hint.textContent = ""
      const t = setTimeout(() => void revealLetter(env, index, stage), 620)
      timers.push(t)
    })
  }

  function showLockedState(env: Extract<SealedEnvelope, { kind: "timelock" }>, stage: HTMLElement): void {
    clear(stage)
    const unlockAt = timeOfRound(env.round)
    const countdown = h("div", { class: "cd-num", style: "font-size: clamp(28px, 6vw, 44px); padding: 10px 18px; text-align: center" })
    const tick = (): void => {
      const left = unlockAt - Date.now()
      if (left <= 0) { showSealedEnvelope(env, bundle.envelopes.indexOf(env), stage); return }
      countdown.textContent = formatLeft(left)
    }
    tick()
    const iv = setInterval(tick, 1000)
    timers.push(iv)

    stage.append(
      h("div", { class: `envelope env-${env.color} locked`, style: "margin-bottom: 18px" },
        h("div", { class: "env-flap" }),
        h("div", { class: "env-body" }),
        waxSeal("🔒"),
        h("div", { class: "env-label" }, h("em", {}, "open when"), env.label),
      ),
      h("div", { style: "text-align: center" },
        countdown,
        h("p", { class: "hint", style: "max-width: 380px; margin: 12px auto" },
          `This envelope is timelocked — sealed to drand round #${fmtNum(env.round)}. `,
          `The key to it does not exist anywhere until ${fmtDateTime(unlockAt)}. Not a promise: mathematics.`),
      ),
    )
  }

  async function revealLetter(env: SealedEnvelope, index: number, stage: HTMLElement): Promise<void> {
    let letterText: string
    if (env.kind === "trust") {
      letterText = env.letter
    } else {
      const status = h("div", { class: "status-line" }, h("div", { class: "spinner" }), h("span", {}, "Summoning the key from the drand network…"))
      stage.append(status)
      try {
        const got = await unsealOnline(base64ToBytes(env.ciphertext), env.round)
        letterText = got.content.letter
        status.remove()
      } catch (e) {
        status.remove()
        showUnlockFallback(env, index, stage, e)
        return
      }
    }
    finishReveal(env, index, stage, letterText)
  }

  function showUnlockFallback(env: Extract<SealedEnvelope, { kind: "timelock" }>, index: number, stage: HTMLElement, err: unknown): void {
    const beaconUrl = `${DRAND_RELAYS[0]}/${QUICKNET_CHAIN_HASH}/public/${env.round}`
    const pasteBox = h("textarea", { placeholder: `Paste the JSON from:\n${beaconUrl}`, style: "font-family: var(--mono); font-size: 12px; min-height: 100px" })
    const msg = err instanceof BeaconUnreachableError
      ? "No drand relay could be reached from here — fetch the key by hand below."
      : err instanceof Error ? err.message : String(err)
    stage.append(
      h("div", { class: "card", style: "margin-top: 14px" },
        h("div", { class: "error-box" }, msg),
        h("p", { class: "hint", style: "margin: 10px 0 6px" },
          "The key is public world data. Open ",
          h("a", { href: beaconUrl, target: "_blank", rel: "noopener" }, "the beacon for this envelope"),
          " on any device with internet, paste the JSON here — it is verified cryptographically before anything decrypts."),
        pasteBox,
        h("div", { class: "btn-row", style: "margin-top: 10px" },
          h("button", {
            class: "btn btn-gold",
            onclick: () => {
              void (async () => {
                try {
                  const beacon = parsePastedBeacon(pasteBox.value)
                  if (!verifyBeaconSignature(beacon)) throw new Error("That beacon's signature does not verify")
                  const content = await unsealWithBeacon(base64ToBytes(env.ciphertext), beacon)
                  finishReveal(env, index, stage, content.letter)
                } catch (e) {
                  toast(e instanceof Error ? e.message : "That beacon did not unlock the envelope")
                }
              })()
            },
          }, "Verify & unlock"),
          h("button", { class: "btn", onclick: () => void revealLetter(env, index, stage) }, "Try the network again"),
        ),
      ),
    )
  }

  function finishReveal(env: SealedEnvelope, index: number, stage: HTMLElement, letterText: string): void {
    opened.add(index)
    persistOpened()
    ritualHost?.classList.add("reading")
    clear(stage)
    stage.append(
      h("div", { class: `letter-paper st-${env.paper} rising` },
        h("div", { class: "lp-head" }, bundle.to ? `for ${bundle.to}` : "for you"),
        h("div", { class: "lp-moment" }, `open when ${env.label}`),
        h("div", { class: "lp-body" }, letterText),
        bundle.from ? h("div", { class: "lp-sign" }, `— ${bundle.from}`) : null,
        env.kind === "timelock"
          ? h("div", { class: "lp-lockednote" },
              `This letter was timelocked until ${fmtDateTime(timeOfRound(env.round))} — its key was created moments ago by the drand network and verified before opening.`)
          : null,
        h("div", { class: "lp-back btn-row" },
          h("button", { class: "btn", onclick: () => { closeRitual(); renderGrid() } }, "Back to the shelf"),
        ),
      ),
    )
  }

  function shortUntil(ms: number): string {
    const left = ms - Date.now()
    if (left <= 0) return "now"
    const d = Math.floor(left / 86_400_000)
    if (d > 0) return `${d}d`
    const hh = Math.floor(left / 3_600_000)
    if (hh > 0) return `${hh}h`
    return `${Math.max(1, Math.floor(left / 60_000))}m`
  }

  function formatLeft(left: number): string {
    const d = Math.floor(left / 86_400_000)
    const hh = Math.floor((left % 86_400_000) / 3_600_000)
    const mm = Math.floor((left % 3_600_000) / 60_000)
    const ss = Math.floor((left % 60_000) / 1000)
    return d > 0 ? `${d}d ${hh}h ${mm}m ${ss}s` : `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
  }
}
