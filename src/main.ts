import "./styles.css"
import { h, clear, fmtNum } from "./ui/dom"
import { startStarfield } from "./ui/starfield"
import { arkMark } from "./ui/icons"
import { openProModal } from "./ui/pro"
import { openHowItWorks } from "./ui/how"
import { toast } from "./ui/toast"
import { APP_VERSION, REPO_URL } from "./config"
import { roundAt } from "./drand"
import { decodeFragment, readEmbeddedCapsule, type CapsulePayload } from "./capsule"
import { capturePristineHtml, isPro, setLicense } from "./state"
import { storedLicense } from "./license"
import { renderSealer, notifySealerProChanged } from "./views/sealer"
import { renderResult } from "./views/result"
import { renderViewer } from "./views/viewer"
import { DEMO_CAPSULE } from "./demo"

// FIRST: capture this document exactly as shipped, before rendering anything.
// Downloaded capsules are this snapshot with a payload injected.
capturePristineHtml()

const app = document.getElementById("app")!
const stars = document.getElementById("stars") as HTMLCanvasElement | null
if (stars) startStarfield(stars)

// ─── header ───
const proBtn = h("button", { class: "btn btn-ghost", onclick: () => openProModal(onProChanged) })
function refreshProBtn(): void {
  proBtn.replaceChildren(isPro() ? h("span", { class: "pro-badge" }, "PRO") : "Ark Pro")
}
function onProChanged(): void {
  refreshProBtn()
  notifySealerProChanged()
}

const roundEl = h("b", {}, "…")
setInterval(() => { roundEl.textContent = `#${fmtNum(roundAt(Date.now()))}` }, 1000)
roundEl.textContent = `#${fmtNum(roundAt(Date.now()))}`

function renderHeader(): HTMLElement {
  return h("div", { class: "hdr" },
    h("div", { class: "hdr-brand", onclick: () => navigate({ kind: "sealer" }) },
      arkMark(), h("span", { class: "wordmark" }, "ARK")),
    h("div", { class: "hdr-right" },
      h("div", { class: "beacon-pill", title: "The drand quicknet beacon mints one key every 3 seconds. This counter is computed from its genesis time and your clock." },
        h("div", { class: "beacon-dot" }),
        h("span", {}, "quicknet round ", roundEl)),
      proBtn,
    ),
  )
}

// ─── routing ───
type Route =
  | { kind: "sealer" }
  | { kind: "result"; payload: CapsulePayload }
  | { kind: "viewer"; payload: CapsulePayload; embedded: boolean; demo: boolean }

function navigate(route: Route): void {
  clear(app)
  app.append(renderHeader())

  if (route.kind === "sealer") {
    // A stray fragment from a viewed capsule shouldn't re-open on reload.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search)
    app.append(renderHero())
    renderSealer(app, (payload) => navigate({ kind: "result", payload }))
    app.append(renderFooter())
  } else if (route.kind === "result") {
    renderResult(app, route.payload,
      () => navigate({ kind: "viewer", payload: route.payload, embedded: false, demo: false }),
      () => navigate({ kind: "sealer" }))
    app.append(renderFooter())
  } else {
    renderViewer(app, route.payload, {
      embedded: route.embedded,
      demo: route.demo,
      onSealAnother: route.embedded ? null : () => navigate({ kind: "sealer" }),
    })
    app.append(renderFooter())
  }
  scrollTo({ top: 0 })
}

function renderHero(): HTMLElement {
  const demo = DEMO_CAPSULE
  return h("div", { class: "hero" },
    h("h1", {}, "Seal a message the universe cannot open yet."),
    h("p", { class: "sub" },
      "Ark locks letters and files to a ", h("b", {}, "moment in time"), " using timelock encryption against the ",
      h("b", {}, "drand"), " randomness beacon. The decryption key isn't hidden — it ",
      h("b", {}, "does not exist"), " until ~16 independent organisations jointly create it at the moment you choose."),
    h("div", { class: "hero-links" },
      h("a", { href: "#", onclick: (e: Event) => { e.preventDefault(); openHowItWorks() } }, "How is that possible?"),
      demo
        ? h("a", { href: "#", onclick: (e: Event) => {
            e.preventDefault()
            navigate({ kind: "viewer", payload: demo, embedded: false, demo: true })
          } }, "Open a capsule sealed in the past →")
        : null,
    ),
    h("div", { class: "trust" },
      h("span", {}, "encrypted in your browser"),
      h("span", {}, "zero servers, zero accounts"),
      h("span", {}, "standard age format — opens with the tle CLI"),
      h("span", {}, "works offline, forever"),
    ),
  )
}

function renderFooter(): HTMLElement {
  return h("div", { class: "ftr" },
    h("span", {}, `Ark v${APP_VERSION} — a single HTML file. Save this page and it keeps working, offline, indefinitely.`),
    h("span", {},
      h("a", { href: "https://drand.love", target: "_blank", rel: "noopener" }, "drand.love"), " · ",
      h("a", { href: "https://age-encryption.org", target: "_blank", rel: "noopener" }, "age"), " · ",
      h("a", { href: REPO_URL, target: "_blank", rel: "noopener" }, "source"),
    ),
  )
}

// ─── boot ───
async function boot(): Promise<void> {
  setLicense(await storedLicense())
  refreshProBtn()

  // 1. Am I a downloaded capsule file? (payload baked into this document)
  try {
    const embedded = readEmbeddedCapsule(document)
    if (embedded) {
      navigate({ kind: "viewer", payload: embedded, embedded: true, demo: false })
      return
    }
  } catch (e) {
    toast(`This capsule file looks damaged: ${e instanceof Error ? e.message : String(e)}`)
  }

  // 2. Was I opened through a capsule link? (payload in the #fragment)
  if (location.hash.length > 1) {
    try {
      const fromLink = await decodeFragment(location.hash)
      if (fromLink) {
        navigate({ kind: "viewer", payload: fromLink, embedded: false, demo: false })
        return
      }
    } catch (e) {
      toast(`This capsule link is damaged: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 3. Plain visit → the sealer.
  navigate({ kind: "sealer" })
}

void boot()

// A capsule link pasted into an already-open tab only changes the hash —
// re-run boot so the viewer appears without a manual reload.
addEventListener("hashchange", () => void boot())
