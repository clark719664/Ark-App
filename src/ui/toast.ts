import { h } from "./dom"

let container: HTMLElement | null = null

export function toast(message: string, ms = 3600): void {
  if (!container) {
    container = h("div", { id: "toasts" })
    document.body.append(container)
  }
  const el = h("div", { class: "toast" }, message)
  container.append(el)
  setTimeout(() => {
    el.style.transition = "opacity 0.4s ease"
    el.style.opacity = "0"
    setTimeout(() => el.remove(), 450)
  }, ms)
}
