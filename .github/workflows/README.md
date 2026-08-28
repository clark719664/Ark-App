# CI

`ci.yml` runs on every push and pull request: typecheck (client and server),
the full test suite, and a production build.

The test suite includes browser-driven scraper tests, which is why the workflow
installs Chromium. They run against synthetic fixtures checked into the repo —
no Yahoo account, no network, and nothing personal is involved.

The calibration tests in `server/yahoo/calibration.test.ts` skip in CI by
design: they only run when `.cache/raw/` holds pages captured from a real
league, and that directory is gitignored because it contains your league's data.
