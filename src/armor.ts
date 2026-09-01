// age ASCII armor <-> raw bytes. Capsules store raw ciphertext bytes
// (base64url in links, base64 in JSON payloads) and re-armor on demand so
// every capsule remains openable by the official `age`/`tle` CLIs.

const HEADER = "-----BEGIN AGE ENCRYPTED FILE-----"
const FOOTER = "-----END AGE ENCRYPTED FILE-----"

export function dearmor(armored: string): Uint8Array {
  const lines = armored.trim().split(/\r?\n/)
  if (lines[0] !== HEADER || lines[lines.length - 1] !== FOOTER) {
    throw new Error("Not an age armored file")
  }
  return base64ToBytes(lines.slice(1, -1).join(""))
}

export function armor(bytes: Uint8Array): string {
  const b64 = bytesToBase64(bytes)
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? ""
  return `${HEADER}\n${wrapped}\n${FOOTER}\n`
}

// ─── base64 helpers (chunked: safe for multi-MB payloads) ────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
  while (b64.length % 4 !== 0) b64 += "="
  return base64ToBytes(b64)
}
