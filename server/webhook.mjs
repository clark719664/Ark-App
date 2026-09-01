#!/usr/bin/env node
// Ark Pro fulfillment — a zero-dependency Stripe webhook server (~150 lines).
//
// Flow: buyer pays through your Stripe Payment Link → Stripe POSTs
// checkout.session.completed here → we verify the signature, mint an
// Ed25519-signed license key, and email it (via Resend) or log it for manual
// sending. No database; an append-only fulfillment log is the paper trail.
//
// Run:  STRIPE_WEBHOOK_SECRET=whsec_… node server/webhook.mjs
// Env:
//   STRIPE_WEBHOOK_SECRET  required — from your Stripe webhook endpoint
//   LICENSE_SIGNING_KEY    hex private key (falls back to secrets/ file)
//   RESEND_API_KEY         optional — set it and keys are emailed automatically
//   FROM_EMAIL             sender address for Resend (e.g. ark@yourdomain.com)
//   PORT                   default 8787
import { createServer } from "node:http"
import { createHmac, timingSafeEqual } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { hexToBytes, mintLicense } from "../tools/license-lib.mjs"

const PORT = Number(process.env.PORT || 8787)
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || "ark@example.com"
const LOG_DIR = new URL("../secrets/", import.meta.url)
const LOG_PATH = new URL("../secrets/fulfillment.log", import.meta.url)

if (!WEBHOOK_SECRET) {
  console.error("STRIPE_WEBHOOK_SECRET is required (whsec_… from the Stripe dashboard)")
  process.exit(1)
}

function signingKey() {
  const hex =
    process.env.LICENSE_SIGNING_KEY ??
    (existsSync(new URL("../secrets/license-signing-key.hex", import.meta.url))
      ? readFileSync(new URL("../secrets/license-signing-key.hex", import.meta.url), "utf8")
      : null)
  if (!hex) throw new Error("No license signing key — run `npm run keygen` or set LICENSE_SIGNING_KEY")
  return hexToBytes(hex)
}
signingKey() // fail fast at boot if unconfigured

/** Stripe signature scheme: header `t=<ts>,v1=<hmac>`, where hmac =
 *  HMAC-SHA256(secret, `${ts}.${rawBody}`). */
function verifyStripeSignature(rawBody, header, tolerance = 300) {
  if (!header) return false
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=")
      return [kv.slice(0, i), kv.slice(i + 1)]
    }),
  )
  const ts = Number(parts.t)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > tolerance) return false
  const expected = Buffer.from(
    createHmac("sha256", WEBHOOK_SECRET).update(`${parts.t}.${rawBody}`).digest("hex"),
    "utf8",
  )
  // During a secret rotation Stripe sends multiple v1= entries; accepting if
  // ANY matches is what their docs require.
  const candidates = header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .map((kv) => Buffer.from(kv.slice(3), "utf8"))
  return candidates.some((given) => given.length === expected.length && timingSafeEqual(given, expected))
}

async function emailKey(to, key) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `Ark <${FROM_EMAIL}>`,
      to: [to],
      subject: "Your Ark Pro license key",
      text: `Thank you for buying Ark Pro.\n\nYour license key:\n\n${key}\n\nOpen Ark, click "Ark Pro", and paste it under "Already have a key?". Verification happens entirely offline — this key is yours forever, on any device.\n`,
    }),
  })
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`)
}

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`
  process.stdout.write(entry)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_PATH, entry)
  } catch {
    /* stdout already has it */
  }
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true, service: "ark-fulfillment" }))
    return
  }
  if (req.method !== "POST" || req.url !== "/webhook/stripe") {
    res.writeHead(404).end()
    return
  }

  const chunks = []
  let size = 0
  req.on("data", (c) => {
    size += c.length
    if (size > 1_000_000) req.destroy()
    else chunks.push(c)
  })
  req.on("end", () => {
    void (async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8")
      if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"])) {
        log(`REJECTED invalid signature from ${req.socket.remoteAddress}`)
        res.writeHead(400).end("bad signature")
        return
      }
      let event
      try {
        event = JSON.parse(rawBody)
      } catch {
        res.writeHead(400).end("bad json")
        return
      }
      // Acknowledge quickly; Stripe retries on non-2xx. Fulfil on completed
      // checkouts AND on delayed payment methods (ACH/SEPA/OXXO) succeeding.
      if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
        res.writeHead(200).end("ignored")
        return
      }
      const session = event.data?.object ?? {}
      // A completed session with payment_status "unpaid" is a delayed-method
      // checkout whose payment may still FAIL — minting an irrevocable
      // license now would fulfil unpaid orders. Wait for async_payment_succeeded.
      if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
        log(`DEFERRED ${session.id}: payment_status=${session.payment_status} — awaiting async payment result`)
        res.writeHead(200).end("awaiting payment")
        return
      }
      const email = (session.customer_details?.email || session.customer_email || "").trim().toLowerCase()
      if (!email) {
        log(`ERROR session ${session.id}: no customer email on session`)
        res.writeHead(200).end("no email; logged")
        return
      }
      try {
        const key = await mintLicense(signingKey(), email)
        if (RESEND_API_KEY) {
          await emailKey(email, key)
          log(`FULFILLED ${email} session=${session.id} (emailed)`)
        } else {
          log(`FULFILLED ${email} session=${session.id} key=${key} (RESEND_API_KEY unset — send manually)`)
        }
        res.writeHead(200).end("fulfilled")
      } catch (e) {
        log(`ERROR ${email} session=${session.id}: ${e.message}`)
        res.writeHead(500).end("fulfillment error") // Stripe will retry
      }
    })()
  })
})

server.listen(PORT, () => {
  console.log(`Ark fulfillment listening on :${PORT}`)
  console.log(`  POST /webhook/stripe   (point your Stripe webhook here, event: checkout.session.completed)`)
  console.log(`  GET  /health`)
  if (!RESEND_API_KEY) console.log("  RESEND_API_KEY unset — keys will be logged for manual sending")
})
