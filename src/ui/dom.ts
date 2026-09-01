type Child = Node | string | null | undefined | false

/** Tiny hyperscript helper — Ark deliberately has no framework. A file meant
 *  to open in 2126 should depend on nothing that can rot. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === "class") {
      el.className = String(value)
    } else if (key === "dataset") {
      Object.assign(el.dataset, value)
    } else if (key in el && key !== "list" && key !== "form") {
      ;(el as unknown as Record<string, unknown>)[key] = value
    } else {
      el.setAttribute(key, String(value))
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(child))
  }
  return el
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function fmtNum(n: number): string {
  return n.toLocaleString("en-US")
}

/** Trigger a client-side download; falls back to clipboard where the host
 *  blocks script-initiated downloads (e.g. sandboxed demo viewers). */
export async function saveOrCopy(
  filename: string,
  data: Blob | string,
  onFallback: (msg: string) => void,
): Promise<void> {
  const blob = typeof data === "string" ? new Blob([data], { type: "text/plain" }) : data
  try {
    const url = URL.createObjectURL(blob)
    const a = h("a", { href: url, download: filename })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } catch {
    /* fall through to clipboard */
  }
  // In sandboxed viewers the click above is silently inert; offer the bytes
  // via clipboard too when the payload is small enough to be text.
  if (typeof data === "string" && data.length < 2_000_000 && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(data)
      onFallback(`${filename} saved — also copied to clipboard in case downloads are blocked here`)
      return
    } catch {
      /* clipboard refused; the download attempt above is all we can do */
    }
  }
  onFallback(`${filename} saved`)
}
