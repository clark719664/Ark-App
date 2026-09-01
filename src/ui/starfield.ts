/** A quiet, slowly drifting starfield. Subtle on purpose: the stars are the
 *  product metaphor (the beacon network is "the sky"), not a screensaver. */
export function startStarfield(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")
  if (!ctx) return

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
  interface Star { x: number; y: number; r: number; base: number; phase: number; speed: number }
  let stars: Star[] = []
  let w = 0
  let h = 0

  function resize(): void {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    const count = Math.min(260, Math.round((w * h) / 6500))
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() < 0.88 ? 0.7 + Math.random() * 0.7 : 1.4 + Math.random() * 1.1,
      base: 0.25 + Math.random() * 0.55,
      phase: Math.random() * Math.PI * 2,
      speed: 0.3 + Math.random() * 0.9,
    }))
  }

  function frame(t: number): void {
    ctx!.clearRect(0, 0, w, h)
    for (const s of stars) {
      const tw = reduced ? 1 : 0.72 + 0.28 * Math.sin(s.phase + (t / 1000) * s.speed)
      ctx!.globalAlpha = s.base * tw
      ctx!.fillStyle = s.r > 1.3 ? "#f4e8c8" : "#dfe4f5"
      ctx!.beginPath()
      ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2)
      ctx!.fill()
      if (!reduced) {
        s.x += 0.006 * s.speed
        if (s.x > w + 2) s.x = -2
      }
    }
    ctx!.globalAlpha = 1
    if (!reduced) requestAnimationFrame(frame)
  }

  resize()
  addEventListener("resize", resize)
  requestAnimationFrame(frame)
}
