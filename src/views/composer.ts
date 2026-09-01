import { h, clear, fmtDateTime, fmtNum } from "../ui/dom"
import { toast } from "../ui/toast"
import { sealGlyph } from "../ui/icons"
import { openProModal } from "../ui/pro"
import {
  FREE_BUNDLE_MAX_ENVELOPES,
  FREE_LETTER_MAX,
  MAX_HORIZON_YEARS,
  PRO_BUNDLE_MAX_ENVELOPES,
  PRO_LETTER_MAX,
  QUICKNET_CHAIN_HASH,
} from "../config"
import { roundForUnlock, timeOfRound } from "../drand"
import { seal } from "../tlock"
import { bytesToBase64 } from "../armor"
import { isPro } from "../state"
import { ENVELOPE_COLORS, MOMENT_GROUPS, STATIONERY, type EnvelopeColor, type Stationery } from "../moments"
import type { BundlePayload, SealedEnvelope } from "../bundle"

interface EnvelopeDraft {
  id: number
  label: string
  emoji: string
  hint: string
  letter: string
  color: EnvelopeColor
  paper: Stationery
  unlockMs: number | null // null = sealed by promise
}

const LOCK_PRESETS: Array<{ label: string; ms: () => number }> = [
  { label: "tomorrow", ms: () => Date.now() + 86_400_000 },
  { label: "1 week", ms: () => Date.now() + 7 * 86_400_000 },
  { label: "1 month", ms: () => Date.now() + 30 * 86_400_000 },
  { label: "1 year", ms: () => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.getTime() } },
]

export function renderComposer(root: HTMLElement, onSealed: (payload: BundlePayload) => void): void {
  let nextId = 1
  let drafts: EnvelopeDraft[] = []

  const maxEnvelopes = (): number => (isPro() ? PRO_BUNDLE_MAX_ENVELOPES : FREE_BUNDLE_MAX_ENVELOPES)
  const letterMax = (): number => (isPro() ? PRO_LETTER_MAX : FREE_LETTER_MAX)

  const toInput = h("input", { type: "text", placeholder: "Ana", maxLength: 60 })
  const fromInput = h("input", { type: "text", placeholder: "Mom · Sam · your favorite brother", maxLength: 60 })

  // ── moments picker ──
  const momentChips = new Map<string, HTMLButtonElement>()
  function refreshChips(): void {
    for (const [key, chip] of momentChips) {
      chip.classList.toggle("on", drafts.some((d) => d.hint !== "" && d.label === labelOfKey(key)))
    }
  }
  function labelOfKey(key: string): string {
    for (const g of MOMENT_GROUPS) for (const m of g.moments) if (m.key === key) return m.label
    return ""
  }

  function addDraft(label: string, emoji: string, hint: string): void {
    if (drafts.length >= maxEnvelopes()) {
      if (!isPro()) {
        openProModal()
        toast(`Free bundles hold ${FREE_BUNDLE_MAX_ENVELOPES} envelopes — Ark Pro raises that to ${PRO_BUNDLE_MAX_ENVELOPES}`)
      } else {
        toast(`Bundles hold at most ${PRO_BUNDLE_MAX_ENVELOPES} envelopes`)
      }
      return
    }
    drafts.push({
      id: nextId++,
      label,
      emoji,
      hint,
      letter: "",
      color: ENVELOPE_COLORS[drafts.length % ENVELOPE_COLORS.length],
      paper: "classic",
      unlockMs: null,
    })
    refreshList()
    refreshChips()
  }

  const picker = h("div", {})
  for (const group of MOMENT_GROUPS) {
    const chips = h("div", { class: "chips", style: "margin: 6px 0 14px" })
    for (const m of group.moments) {
      const chip = h("button", {
        class: "chip",
        onclick: () => {
          const existing = drafts.find((d) => d.label === m.label)
          if (existing) {
            document.getElementById(`env-${existing.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
            return
          }
          addDraft(m.label, m.emoji, m.hint)
        },
      }, `${m.emoji} ${m.label}`)
      momentChips.set(m.key, chip)
      chips.append(chip)
    }
    picker.append(
      h("div", { style: "font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-faint)" }, group.name),
      chips,
    )
  }
  picker.append(
    h("button", { class: "chip", onclick: () => addDraft("", "💌", "") }, "＋ your own moment…"),
  )

  // ── envelope editors ──
  const list = h("div", {})
  const counter = h("div", { class: "hint", style: "margin-top: 8px" })

  function refreshList(): void {
    clear(list)
    counter.textContent = `${drafts.length} of ${maxEnvelopes()} envelopes${!isPro() ? " on the free tier" : ""}`
    for (const d of drafts) list.append(renderDraft(d))
  }

  function renderDraft(d: EnvelopeDraft): HTMLElement {
    const labelInput = h("input", {
      type: "text",
      value: d.label,
      placeholder: "the moment feels right",
      maxLength: 90,
      style: "font-family: var(--serif); font-size: 16px",
      oninput: () => { d.label = labelInput.value; refreshChips() },
    })

    const count = h("div", { class: "char-count" })
    const letter = h("textarea", {
      placeholder: d.hint || "Write the letter they'll need in that moment…",
      style: "min-height: 120px",
      oninput: () => {
        d.letter = letter.value
        const over = letter.value.length > letterMax()
        count.textContent = `${fmtNum(letter.value.length)} / ${fmtNum(letterMax())}${over ? " — over the limit" : ""}`
        count.classList.toggle("over", over)
      },
    })
    letter.value = d.letter

    const swatches = h("div", { class: "chips" },
      ...ENVELOPE_COLORS.map((c) =>
        h("button", {
          class: `swatch sw-${c}${d.color === c ? " on" : ""}`,
          title: c,
          "aria-label": `${c} envelope`,
          onclick: (e: Event) => {
            d.color = c
            const parent = (e.currentTarget as HTMLElement).parentElement!
            parent.querySelectorAll(".swatch").forEach((s) => s.classList.remove("on"))
            ;(e.currentTarget as HTMLElement).classList.add("on")
          },
        }),
      ),
      h("span", { style: "width: 14px" }),
      ...(Object.entries(STATIONERY) as Array<[Stationery, string]>).map(([key, name]) =>
        h("button", {
          class: `chip${d.paper === key ? " on" : ""}`,
          dataset: { paper: key },
          onclick: (e: Event) => {
            d.paper = key
            const parent = (e.currentTarget as HTMLElement).parentElement!
            parent.querySelectorAll("[data-paper]").forEach((s) => s.classList.remove("on"))
            ;(e.currentTarget as HTMLElement).classList.add("on")
          },
        }, name),
      ),
    )

    // ── lock controls ──
    const lockNote = h("div", { class: "round-note", style: "display: none" })
    const customTime = h("input", {
      type: "datetime-local",
      style: "display: none; margin-top: 8px",
      onchange: () => {
        const t = new Date(customTime.value).getTime()
        if (!Number.isFinite(t) || t < Date.now() + 30_000) { toast("Pick a moment at least 30 seconds ahead"); return }
        const max = new Date(); max.setFullYear(max.getFullYear() + MAX_HORIZON_YEARS)
        if (t > max.getTime()) { toast(`Ark seals at most ${MAX_HORIZON_YEARS} years out`); return }
        d.unlockMs = t
        refreshLockNote()
      },
    })
    const presetChips = h("div", { class: "chips", style: "display: none; margin-top: 8px" },
      ...LOCK_PRESETS.map((p) => h("button", { class: "chip", onclick: () => { d.unlockMs = p.ms(); refreshLockNote(); customTime.style.display = "none" } }, p.label)),
      h("button", { class: "chip", onclick: () => { customTime.style.display = "block"; customTime.focus() } }, "custom…"),
    )
    function refreshLockNote(): void {
      if (d.unlockMs === null) { lockNote.style.display = "none"; return }
      const round = roundForUnlock(d.unlockMs)
      lockNote.style.display = "block"
      lockNote.replaceChildren(
        h("span", {}, "cannot open before "),
        h("b", {}, fmtDateTime(timeOfRound(round))),
        h("span", {}, ` — drand round `),
        h("b", {}, `#${fmtNum(round)}`),
        h("span", {}, ". Sealed by mathematics, not by promise."),
      )
    }

    const trustChip = h("button", { class: `chip${d.unlockMs === null ? " on" : ""}` }, "🤞 sealed by promise")
    const lockChip = h("button", { class: `chip${d.unlockMs !== null ? " on" : ""}` }, "🔒 timelocked — a real Ark seal")
    trustChip.addEventListener("click", () => {
      d.unlockMs = null
      trustChip.classList.add("on"); lockChip.classList.remove("on")
      presetChips.style.display = "none"; customTime.style.display = "none"
      refreshLockNote()
    })
    lockChip.addEventListener("click", () => {
      trustChip.classList.remove("on"); lockChip.classList.add("on")
      presetChips.style.display = "flex"
      if (d.unlockMs === null) { d.unlockMs = LOCK_PRESETS[3].ms() } // default: 1 year
      refreshLockNote()
    })
    if (d.unlockMs !== null) { presetChips.style.display = "flex"; refreshLockNote() }

    return h("div", { class: "card env-editor", id: `env-${d.id}` },
      h("div", { style: "display: flex; align-items: center; gap: 10px" },
        h("span", { style: "font-size: 22px" }, d.emoji || "💌"),
        h("span", { class: "hint", style: "white-space: nowrap" }, "open when"),
        labelInput,
        h("button", {
          class: "rm", title: "Remove envelope", style: "font-size: 18px",
          onclick: () => { drafts = drafts.filter((x) => x.id !== d.id); refreshList(); refreshChips() },
        }, "✕"),
      ),
      h("div", { class: "field", style: "margin: 12px 0 6px" }, letter, count),
      h("div", { class: "field", style: "margin: 10px 0 6px" }, swatches),
      h("div", { class: "field", style: "margin: 10px 0 0" },
        h("div", { class: "chips" }, trustChip, lockChip),
        presetChips, customTime, lockNote,
      ),
    )
  }

  // ── seal ──
  async function doSeal(): Promise<void> {
    if (drafts.length === 0) { toast("Add at least one envelope"); return }
    for (const d of drafts) {
      if (!d.letter.trim()) { toast(`The "open when ${d.label || "…"}" envelope is empty`); return }
      if (d.letter.length > letterMax()) { toast(`The "open when ${d.label}" letter is over ${fmtNum(letterMax())} characters`); return }
      if (d.unlockMs !== null && d.unlockMs < Date.now() + 25_000) { toast(`The lock on "open when ${d.label}" is in the past`); return }
    }

    const steps = h("div", { class: "ceremony-steps" })
    const overlay = h("div", { class: "ceremony" },
      h("div", { class: "ceremony-inner" }, sealGlyph(), h("h2", { class: "serif", style: "margin: 0 0 18px" }, "Sealing the bundle"), steps),
    )
    document.body.append(overlay)
    const stepDone = async (msg: string): Promise<void> => {
      const line = h("div", {}, h("span", { class: "ok" }, "✓"), msg)
      steps.append(line)
      await new Promise((r) => setTimeout(r, 60))
      line.classList.add("show")
      await new Promise((r) => setTimeout(r, 380))
    }

    try {
      const envelopes: SealedEnvelope[] = []
      const trustCount = drafts.filter((d) => d.unlockMs === null).length
      if (trustCount > 0) await stepDone(`Folding ${trustCount} promise-sealed ${trustCount === 1 ? "letter" : "letters"} into the bundle`)
      for (const d of drafts) {
        const base = { label: d.label.trim() || "the moment is right", emoji: d.emoji, color: d.color, paper: d.paper }
        if (d.unlockMs === null) {
          envelopes.push({ kind: "trust", ...base, letter: d.letter })
        } else {
          const round = roundForUnlock(d.unlockMs)
          const ciphertext = await seal({ v: 1, letter: d.letter, files: [] }, round)
          envelopes.push({ kind: "timelock", ...base, round, ciphertext: bytesToBase64(ciphertext) })
          await stepDone(`Timelocked "open when ${base.label}" — round #${fmtNum(round)}, its key does not exist yet`)
        }
      }
      await stepDone("Bundle sealed. The wax is theirs to crack.")
      await new Promise((r) => setTimeout(r, 450))
      overlay.remove()
      onSealed({
        v: 1,
        bundle: true,
        to: toInput.value.trim(),
        from: fromInput.value.trim(),
        sealedAt: Date.now(),
        chainHash: QUICKNET_CHAIN_HASH,
        envelopes,
      })
    } catch (e) {
      overlay.remove()
      toast(e instanceof Error ? e.message : "Sealing failed")
    }
  }

  refreshList()

  root.append(
    h("div", { class: "card" },
      h("h2", {}, "Write an “open when…” bundle"),
      h("div", { class: "hint" },
        "A shelf of sealed envelopes for someone you love — each one for a moment. ",
        "Promise-sealed envelopes open on their honor, like paper. Timelocked ones are sealed by real cryptography and physically cannot open early."),
      h("div", { class: "field", style: "display: grid; grid-template-columns: 1fr 1fr; gap: 12px" },
        h("div", {}, h("label", {}, "Their name"), toInput),
        h("div", {}, h("label", {}, "From — how you'd sign a letter"), fromInput),
      ),
      h("div", { class: "field" }, h("label", {}, "Choose their moments"), picker, counter),
    ),
    list,
    h("div", { class: "card" },
      h("div", { class: "btn-row" },
        h("button", { class: "btn btn-gold btn-lg", onclick: () => void doSeal() }, "Seal the bundle  ◆"),
        h("span", { class: "hint" }, "Timelocked envelopes are irreversible — there is no override, including for us."),
      ),
    ),
  )
}
