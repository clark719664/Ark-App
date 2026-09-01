import { h } from "./dom"
import { openModal } from "./modal"
import { toast } from "./toast"
import { PAYMENT_LINK, PRO_PRICE } from "../config"
import { storeLicense, verifyLicenseKey, clearLicense } from "../license"
import { isPro, license, setLicense } from "../state"

function feature(title: string, detail: string): HTMLElement {
  return h(
    "div",
    { class: "pro-feature" },
    h("span", { class: "tick" }, "◆"),
    h("span", {}, h("b", {}, title + " — "), detail),
  )
}

export function openProModal(onChange: () => void): void {
  const status = h("div", {})

  function renderStatus(): void {
    status.replaceChildren()
    if (isPro() && license) {
      status.append(
        h(
          "p",
          { style: "color: var(--green); font-size: 14px" },
          `✓ Ark Pro active — licensed to ${license.claim.email} (verified offline, Ed25519)`,
        ),
        h(
          "button",
          {
            class: "btn btn-ghost",
            onclick: () => {
              clearLicense()
              setLicense(null)
              renderStatus()
              onChange()
              toast("License removed from this browser")
            },
          },
          "Remove license from this browser",
        ),
      )
    }
  }
  renderStatus()

  const keyInput = h("input", {
    type: "text",
    placeholder: "ARK1.…paste your license key…",
    spellcheck: false,
    style: "font-family: var(--mono); font-size: 12px",
  })

  const activate = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        try {
          const claim = await verifyLicenseKey(keyInput.value)
          storeLicense(keyInput.value)
          setLicense({ claim, key: keyInput.value.trim() })
          renderStatus()
          onChange()
          toast(`Welcome to Ark Pro, ${claim.email} — verified without a single network call`)
        } catch (e) {
          toast(e instanceof Error ? e.message : "That key did not verify")
        }
      },
    },
    "Activate",
  )

  openModal(
    h("h2", {}, "Ark Pro"),
    h(
      "p",
      { style: "color: var(--ink-dim); font-size: 14.5px" },
      "One payment, yours forever. Licenses are Ed25519-signed keys your browser verifies ",
      h("b", { style: "color: var(--ink)" }, "offline"),
      " — no account, no license server, nothing that can ever be shut down.",
    ),
    h("div", { class: "price" }, PRO_PRICE, h("small", {}, "  one-time, forever")),
    feature("Attach files", "seal photos, documents, and recordings — up to 20 MB per capsule"),
    feature("Longer letters", "100,000 characters instead of 4,000"),
    feature("Your mark, not ours", "remove the Ark footer and set a custom accent colour"),
    feature("Same zero-trust crypto", "free and Pro capsules are cryptographically identical"),
    h(
      "div",
      { class: "btn-row", style: "margin: 20px 0 8px" },
      h(
        "a",
        { class: "btn btn-gold btn-lg", href: PAYMENT_LINK, target: "_blank", rel: "noopener" },
        `Buy Ark Pro — ${PRO_PRICE}`,
      ),
    ),
    h("p", { class: "hint" }, "Your key arrives by email within a minute of checkout."),
    h("div", { class: "field", style: "margin-top: 22px" }, h("label", {}, "Already have a key?"), keyInput),
    h("div", { class: "btn-row" }, activate),
    status,
  )
}
