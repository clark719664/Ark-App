import { h } from "./dom"

/** Open a modal; returns a close function. Closes on backdrop click, ✕, Esc. */
export function openModal(...content: Array<Node | string>): () => void {
  const modal = h("div", { class: "modal", role: "dialog", "aria-modal": "true" })
  const closeBtn = h("button", { class: "x", "aria-label": "Close" }, "×")
  modal.append(closeBtn, ...content)
  const back = h("div", { class: "modal-back" }, modal)

  function close(): void {
    back.remove()
    removeEventListener("keydown", onKey)
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close()
  }
  closeBtn.addEventListener("click", close)
  back.addEventListener("click", (e) => {
    if (e.target === back) close()
  })
  addEventListener("keydown", onKey)
  document.body.append(back)
  return close
}
