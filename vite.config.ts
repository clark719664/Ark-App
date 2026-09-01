import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

// Ark ships as ONE self-contained HTML file. No CDN, no external fonts, no
// telemetry — the built artifact must open from a USB stick in 2126. The
// single-file constraint is a product feature, not a build convenience: the
// downloadable capsule *is* this same file with a payload injected.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    // Everything must inline; never emit separate asset files.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 4096,
  },
})
