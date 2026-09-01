import { h, clear, fmtBytes, fmtDateTime, fmtNum } from "../ui/dom"
import { toast } from "../ui/toast"
import { sealGlyph } from "../ui/icons"
import { openProModal } from "../ui/pro"
import {
  FREE_LETTER_MAX,
  MAX_HORIZON_YEARS,
  PRO_FILES_MAX_BYTES,
  PRO_LETTER_MAX,
} from "../config"
import { roundForUnlock, timeOfRound } from "../drand"
import { seal, type CapsuleContent } from "../tlock"
import { makePayload, type CapsulePayload } from "../capsule"
import { isPro, setProChangeListener } from "../state"
import { bytesToBase64 } from "../armor"

interface PendingFile { name: string; type: string; dataB64: string; size: number }

const PRESETS: Array<{ label: string; ms: () => number }> = [
  { label: "60 seconds", ms: () => Date.now() + 60_000 },
  { label: "1 hour", ms: () => Date.now() + 3_600_000 },
  { label: "1 day", ms: () => Date.now() + 86_400_000 },
  { label: "1 year", ms: () => addYears(1) },
  { label: "5 years", ms: () => addYears(5) },
  { label: "10 years", ms: () => addYears(10) },
]

function addYears(n: number): number {
  const d = new Date()
  d.setFullYear(d.getFullYear() + n)
  return d.getTime()
}

export function renderSealer(root: HTMLElement, onSealed: (payload: CapsulePayload) => void): void {
  let unlockMs = PRESETS[3].ms() // default: 1 year
  let files: PendingFile[] = []
  let accent = ""
  let brandless = false

  // ── unlock time ──
  const roundNote = h("div", { class: "round-note" })
  function refreshRoundNote(): void {
    const round = roundForUnlock(unlockMs)
    const exact = timeOfRound(round)
    roundNote.replaceChildren(
      h("span", {}, "opens "),
      h("b", {}, fmtDateTime(exact)),
      h("span", {}, ` — drand round `),
      h("b", {}, `#${fmtNum(round)}`),
      h("span", {}, `. The key for that round will not exist until that moment.`),
      ...(unlockMs > addYears(10)
        ? [h("div", { style: "margin-top: 6px; color: var(--ink-faint)" },
            "Horizons past 10 years rest on the drand network's continuity — it has run since 2019 with no end date announced. The recovery spec inside every capsule covers even the network-vanishes case.")]
        : []),
    )
  }

  const customInput = h("input", {
    type: "datetime-local",
    style: "display: none; margin-top: 10px",
    onchange: () => {
      const t = new Date(customInput.value).getTime()
      if (!Number.isFinite(t)) return
      if (t < Date.now() + 30_000) {
        toast("Pick a moment at least 30 seconds in the future")
        return
      }
      if (t > addYears(MAX_HORIZON_YEARS)) {
        toast(`Ark seals at most ${MAX_HORIZON_YEARS} years out`)
        return
      }
      unlockMs = t
      refreshRoundNote()
    },
  })

  const chips = h(
    "div",
    { class: "chips" },
    ...PRESETS.map((p, i) =>
      h("button", {
        class: `chip${i === 3 ? " on" : ""}`,
        onclick: (e: Event) => {
          chipsSelect(e.currentTarget as HTMLElement)
          customInput.style.display = "none"
          unlockMs = p.ms()
          refreshRoundNote()
        },
      }, p.label),
    ),
    h("button", {
      class: "chip",
      onclick: (e: Event) => {
        chipsSelect(e.currentTarget as HTMLElement)
        customInput.style.display = "block"
        customInput.focus()
      },
    }, "custom…"),
  )
  function chipsSelect(el: HTMLElement): void {
    chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"))
    el.classList.add("on")
  }

  // ── letter ──
  const letterMax = (): number => (isPro() ? PRO_LETTER_MAX : FREE_LETTER_MAX)
  const counter = h("div", { class: "char-count" })
  const letter = h("textarea", {
    placeholder:
      "Dear future…\n\nWrite to your future self, your child on their 18th birthday, your co-founders on IPO day, or the internet of 2036. What you write here is encrypted in this browser tab and nowhere else.",
    oninput: refreshCounter,
  })
  function refreshCounter(): void {
    const over = letter.value.length > letterMax()
    counter.textContent = `${fmtNum(letter.value.length)} / ${fmtNum(letterMax())}${over ? " — over the limit" : ""}${!isPro() && letter.value.length > FREE_LETTER_MAX * 0.8 ? "  ·  Pro raises this to 100k" : ""}`
    counter.classList.toggle("over", over)
  }

  const titleInput = h("input", {
    type: "text",
    placeholder: "For my daughter, on her 18th birthday",
    maxLength: 140,
  })

  // ── files (Pro) ──
  const fileList = h("div", {})
  const fileInput = h("input", { type: "file", multiple: true, style: "display: none" })
  const dropzone = h("div", { class: "dropzone" })

  function refreshDropzone(): void {
    if (!isPro()) {
      dropzone.classList.add("locked")
      dropzone.replaceChildren(
        h("span", {}, "Attach photos, documents, recordings — "),
        h("span", { style: "color: var(--gold)" }, "an Ark Pro feature. Click to unlock."),
      )
      return
    }
    dropzone.classList.remove("locked")
    const used = files.reduce((n, f) => n + f.size, 0)
    dropzone.replaceChildren(
      h("span", {}, `Drop files here or click to choose — ${fmtBytes(used)} of ${fmtBytes(PRO_FILES_MAX_BYTES)} used`),
    )
  }

  async function addFiles(list: FileList | null): Promise<void> {
    if (!list) return
    for (const f of Array.from(list)) {
      const used = files.reduce((n, x) => n + x.size, 0)
      if (used + f.size > PRO_FILES_MAX_BYTES) {
        toast(`${f.name} would exceed the ${fmtBytes(PRO_FILES_MAX_BYTES)} capsule limit`)
        continue
      }
      const bytes = new Uint8Array(await f.arrayBuffer())
      files.push({ name: f.name, type: f.type || "application/octet-stream", dataB64: bytesToBase64(bytes), size: f.size })
    }
    refreshFileList()
    refreshDropzone()
  }

  function refreshFileList(): void {
    clear(fileList)
    for (const f of files) {
      fileList.append(
        h(
          "div",
          { class: "file-row" },
          h("span", { class: "name" }, f.name),
          h("span", { class: "size" }, fmtBytes(f.size)),
          h("button", {
            class: "rm",
            title: "Remove",
            onclick: () => {
              files = files.filter((x) => x !== f)
              refreshFileList()
              refreshDropzone()
            },
          }, "✕"),
        ),
      )
    }
  }

  dropzone.addEventListener("click", () => {
    if (!isPro()) {
      openProModal()
      return
    }
    fileInput.click()
  })
  fileInput.addEventListener("change", () => void addFiles(fileInput.files))
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag") })
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"))
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault()
    dropzone.classList.remove("drag")
    if (!isPro()) { openProModal(); return }
    void addFiles(e.dataTransfer?.files ?? null)
  })

  // ── Pro theming ──
  const themeRow = h("div", {})
  function refreshTheme(): void {
    themeRow.replaceChildren()
    if (!isPro()) return
    const colorIn = h("input", {
      type: "color",
      value: accent || "#d9a648",
      style: "width: 44px; height: 30px; padding: 2px; background: var(--bg-inset); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; cursor: pointer",
      oninput: () => { accent = colorIn.value },
    })
    const brandIn = h("input", {
      type: "checkbox",
      checked: brandless,
      onchange: () => { brandless = brandIn.checked },
    })
    themeRow.append(
      h("div", { class: "field" },
        h("label", {}, "Capsule theme — Pro"),
        h("div", { class: "btn-row", style: "font-size: 13.5px; color: var(--ink-dim)" },
          colorIn, h("span", {}, "accent colour"),
          h("label", { style: "display: flex; align-items: center; gap: 7px; margin: 0; text-transform: none; letter-spacing: 0; font-size: 13.5px; cursor: pointer" },
            brandIn, "no Ark branding inside the capsule"),
        ),
      ),
    )
  }

  // ── seal ──
  async function doSeal(): Promise<void> {
    const text = letter.value
    if (!text.trim() && files.length === 0) {
      toast("Write a letter (or attach files) before sealing")
      return
    }
    if (text.length > letterMax()) {
      toast(`Your letter is over the ${fmtNum(letterMax())} character limit`)
      return
    }
    if (unlockMs < Date.now() + 25_000) {
      toast("Pick a moment at least 30 seconds in the future")
      return
    }
    const round = roundForUnlock(unlockMs)
    const content: CapsuleContent = {
      v: 1,
      letter: text,
      files: files.map(({ name, type, dataB64 }) => ({ name, type, dataB64 })),
    }

    const steps = h("div", { class: "ceremony-steps" })
    const overlay = h("div", { class: "ceremony" },
      h("div", { class: "ceremony-inner" },
        sealGlyph(),
        h("h2", { class: "serif", style: "margin: 0 0 18px" }, "Sealing"),
        steps,
      ),
    )
    document.body.append(overlay)
    const stepDone = async (msg: string): Promise<void> => {
      const line = h("div", {}, h("span", { class: "ok" }, "✓"), msg)
      steps.append(line)
      await new Promise((r) => setTimeout(r, 60))
      line.classList.add("show")
      await new Promise((r) => setTimeout(r, 420))
    }

    try {
      await stepDone(`Target round computed — #${fmtNum(round)} on drand quicknet`)
      await stepDone("Deriving the round's identity point on BLS12-381")
      const ciphertext = await seal(content, round)
      await stepDone("Payload encrypted — ChaCha20-Poly1305, age v1 format")
      const payload = makePayload({
        title: titleInput.value.trim(),
        round,
        ciphertext,
        sealedAt: Date.now(),
        theme: isPro() && (accent || brandless) ? { ...(accent ? { accent } : {}), ...(brandless ? { brandless: true } : {}) } : undefined,
      })
      await stepDone("Plaintext discarded. The only key now lies in the future.")
      await new Promise((r) => setTimeout(r, 500))
      overlay.remove()
      onSealed(payload)
    } catch (e) {
      overlay.remove()
      toast(e instanceof Error ? e.message : "Sealing failed")
    }
  }

  // ── assemble ──
  refreshRoundNote()
  refreshCounter()
  refreshDropzone()
  refreshTheme()

  root.append(
    h("div", { class: "card" },
      h("h2", {}, "Seal a capsule"),
      h("div", { class: "hint" }, "Everything below is encrypted in this browser tab. Nothing is uploaded — there is nowhere to upload it to."),
      h("div", { class: "field" }, h("label", {}, "Title — stays readable on the sealed capsule"), titleInput),
      h("div", { class: "field" }, h("label", {}, "The letter"), letter, counter),
      h("div", { class: "field" }, h("label", {}, "Files"), dropzone, fileInput, fileList),
      themeRow,
      h("div", { class: "field" }, h("label", {}, "When may the world open it?"), chips, customInput, roundNote),
      h("div", { class: "btn-row", style: "margin-top: 24px" },
        h("button", { class: "btn btn-gold btn-lg", onclick: () => void doSeal() }, "Seal it  ◆"),
        h("span", { class: "hint" }, "Sealing is irreversible. There is no override, including for us."),
      ),
    ),
  )

  // refresh tier gates whenever a license is activated or removed, from any
  // surface — the keyed slot means a re-mounted sealer replaces this hook
  setProChangeListener("sealer", () => { refreshDropzone(); refreshCounter(); refreshTheme() })
}
