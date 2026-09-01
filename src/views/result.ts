import { h, fmtDateTime, saveOrCopy } from "../ui/dom"
import { toast } from "../ui/toast"
import { renderProof } from "../ui/proof"
import { LINK_CIPHERTEXT_HARD_MAX, LINK_CIPHERTEXT_SOFT_MAX } from "../config"
import { timeOfRound } from "../drand"
import { armor } from "../armor"
import { ciphertextBytes, encodeFragment, injectCapsule, type CapsulePayload } from "../capsule"
import { recoverySpec } from "../recovery"
import { pristineHtml } from "../state"

function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return s || "capsule"
}

export function renderResult(
  root: HTMLElement,
  payload: CapsulePayload,
  onOpenNow: () => void,
  onSealAnother: () => void,
): void {
  const unlockAt = timeOfRound(payload.round)
  const linkInput = h("input", { type: "text", readOnly: true, value: "building link…" })
  const ctBytes = ciphertextBytes(payload)
  // Chromium won't navigate URLs past ~2MB — past the hard cap a link would
  // be a dead link, so the capsule is file-only.
  const linkable = ctBytes.length <= LINK_CIPHERTEXT_HARD_MAX
  let fragCache = ""

  if (linkable) {
    void encodeFragment(payload).then((frag) => {
      fragCache = frag
      const base = location.href.split("#")[0]
      linkInput.value = `${base}#${frag}`
    })
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(linkInput.value)
      toast("Capsule link copied — the ciphertext travels in the #fragment, which browsers never send to any server")
    } catch {
      linkInput.select()
      toast("Press ⌘/Ctrl-C to copy")
    }
  }

  function downloadHtmlCapsule(): void {
    try {
      const html = injectCapsule(pristineHtml, payload)
      void saveOrCopy(`ark-${slug(payload.title)}-r${payload.round}.html`, new Blob([html], { type: "text/html" }), toast)
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not build the capsule file")
    }
  }

  root.append(
    h("div", { class: "card" },
      h("h2", {}, "Sealed."),
      h("p", { style: "color: var(--ink-dim); font-size: 15px" },
        payload.title ? h("span", {}, h("b", { style: "color: var(--ink)" }, `“${payload.title}” `)) : "This capsule ",
        `can be opened by anyone who holds it — but only after `,
        h("b", { style: "color: var(--ink)" }, fmtDateTime(unlockAt)),
        `. Until then it is mathematically sealed: the decryption key does not exist yet.`,
      ),

      linkable
        ? h("div", { class: "field" },
            h("label", {}, "Capsule link"),
            h("div", { class: "linkbox" }, linkInput, h("button", { class: "btn", onclick: () => void copyLink() }, "Copy")),
            ctBytes.length > LINK_CIPHERTEXT_SOFT_MAX
              ? h("div", { class: "hint", style: "margin-top: 6px" },
                  "This capsule is large for a link — prefer the self-contained file below.")
              : null,
          )
        : h("div", { class: "field" },
            h("label", {}, "Capsule link"),
            h("div", { class: "hint" },
              "This capsule is too large for a link (browsers refuse multi-megabyte URLs). Deliver it as the self-contained file below — same capsule, same crypto."),
          ),

      h("div", { class: "field" },
        h("label", {}, "Keep it as a file"),
        h("div", { class: "btn-row" },
          h("button", { class: "btn btn-gold", onclick: downloadHtmlCapsule }, "Download capsule (.html)"),
          h("button", { class: "btn", onclick: () => void saveOrCopy(`ark-${slug(payload.title)}-r${payload.round}.age`, armor(ctBytes), toast) }, "Ciphertext only (.age)"),
          h("button", { class: "btn", onclick: () => void saveOrCopy(`ark-${slug(payload.title)}-recovery.txt`, recoverySpec(payload), toast) }, "Recovery spec (.txt)"),
        ),
        h("div", { class: "hint", style: "margin-top: 8px" },
          "The .html capsule is this entire app with your ciphertext sealed inside — one file that opens from a USB stick, an email attachment, or a hard drive found in an attic, decades from now. The .age file is standard ciphertext the open-source tle CLI can decrypt."),
      ),

      h("details", { class: "acc" },
        h("summary", {}, "Proof of sealing — what must happen for this to open"),
        h("div", { class: "acc-body" }, renderProof(payload)),
      ),
      h("details", { class: "acc" },
        h("summary", {}, "Recovery spec — opening this without Ark, ever"),
        h("div", { class: "acc-body" }, h("pre", { class: "spec" }, recoverySpec(payload))),
      ),

      h("div", { class: "btn-row", style: "margin-top: 20px" },
        h("button", {
          class: "btn",
          onclick: () => {
            // Navigate via the fragment when possible: the sealed capsule
            // then survives a reload instead of living only in memory.
            if (linkable && fragCache) location.hash = fragCache
            else onOpenNow()
          },
        }, "View the sealed capsule →"),
        h("button", { class: "btn btn-ghost", onclick: onSealAnother }, "Seal another"),
      ),
      timeOfRound(payload.round) - Date.now() > 86_400_000
        ? h("p", { class: "hint", style: "margin-top: 14px" },
            "Sealing something precious? Seal a 60-second canary capsule first and watch a real unlock happen — same crypto, same network, just sooner.")
        : null,
    ),
  )
}

// ─── bundle result ────────────────────────────────────────────────────────

import { bundleRecoverySpec } from "../recovery"
import type { BundlePayload } from "../bundle"

/** Chromium refuses URLs past ~2MB; fragments beyond this many chars would
 *  make dead links, so past it the bundle is file-only. */
const LINK_FRAGMENT_CHAR_MAX = 1_800_000

export function renderBundleResult(
  root: HTMLElement,
  bundle: BundlePayload,
  onOpenNow: () => void,
  onSealAnother: () => void,
): void {
  const locked = bundle.envelopes.filter((e) => e.kind === "timelock").length
  const linkInput = h("input", { type: "text", readOnly: true, value: "building link…" })
  let fragCache = ""
  let linkable = true

  const linkField = h("div", { class: "field" }, h("label", {}, "Bundle link"))
  const linkRow = h("div", { class: "linkbox" }, linkInput,
    h("button", {
      class: "btn",
      onclick: () => {
        void navigator.clipboard.writeText(linkInput.value)
          .then(() => toast("Bundle link copied — the letters travel in the #fragment, which browsers never send to any server"))
          .catch(() => { linkInput.select(); toast("Press ⌘/Ctrl-C to copy") })
      },
    }, "Copy"))
  linkField.append(linkRow)

  void encodeFragment(bundle).then((frag) => {
    if (frag.length > LINK_FRAGMENT_CHAR_MAX) {
      linkable = false
      linkRow.replaceWith(h("div", { class: "hint" },
        "This bundle is too large for a link (browsers refuse multi-megabyte URLs). Deliver it as the self-contained file below — same bundle, same seals."))
      return
    }
    fragCache = frag
    linkInput.value = `${location.href.split("#")[0]}#${frag}`
  })

  function downloadHtmlBundle(): void {
    try {
      const html = injectCapsule(pristineHtml, bundle)
      const name = bundle.to ? bundle.to.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "bundle"
      void saveOrCopy(`ark-open-when-${name || "bundle"}.html`, new Blob([html], { type: "text/html" }), toast)
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not build the bundle file")
    }
  }

  root.append(
    h("div", { class: "card" },
      h("h2", {}, "Sealed."),
      h("p", { style: "color: var(--ink-dim); font-size: 15px" },
        h("b", { style: "color: var(--ink)" },
          `${bundle.envelopes.length} ${bundle.envelopes.length === 1 ? "envelope" : "envelopes"}${bundle.to ? ` for ${bundle.to}` : ""}`),
        locked > 0
          ? h("span", {}, ` — ${locked} of them timelocked. Those cannot be opened early by anyone, including you.`)
          : h("span", {}, " — sealed by promise, like paper. Whoever holds the bundle is trusted to wait for each moment."),
      ),
      linkField,
      h("div", { class: "field" },
        h("label", {}, "Keep it as a file"),
        h("div", { class: "btn-row" },
          h("button", { class: "btn btn-gold", onclick: downloadHtmlBundle }, "Download bundle (.html)"),
          h("button", { class: "btn", onclick: () => void saveOrCopy("ark-bundle-recovery.txt", bundleRecoverySpec(bundle), toast) }, "Recovery spec (.txt)"),
        ),
        h("div", { class: "hint", style: "margin-top: 8px" },
          "The .html bundle is this entire app with the envelopes sealed inside — one file that opens from a USB stick or an email attachment, decades from now."),
      ),
      h("details", { class: "acc" },
        h("summary", {}, "Recovery spec — opening this without Ark, ever"),
        h("div", { class: "acc-body" }, h("pre", { class: "spec" }, bundleRecoverySpec(bundle))),
      ),
      h("div", { class: "btn-row", style: "margin-top: 20px" },
        h("button", {
          class: "btn",
          onclick: () => {
            if (linkable && fragCache) location.hash = fragCache
            else onOpenNow()
          },
        }, "View their shelf →"),
        h("button", { class: "btn btn-ghost", onclick: onSealAnother }, "Seal another"),
      ),
    ),
  )
}
