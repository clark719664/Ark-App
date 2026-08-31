# Field Kit conventions

Every script in this toolkit follows these rules so they're predictable,
safe to demo in front of a client, and easy to hand to a trained tech.

## 1. Safe by default
- Anything that changes a system or network **dry-runs by default** and
  prints the exact plan. Real changes require an explicit `--apply` flag
  (Python/Bash) or `-Apply` switch (PowerShell). No flag = no changes.
- Destructive steps (disk, registry mass-edits, firewall flush) require a
  second confirmation even under `--apply`, unless `--yes` is also passed.

## 2. Authorization banner
- Any tool that scans a network or modifies a machine prints a banner naming
  the client/site and requires the operator to confirm authorization before
  proceeding (skippable with `--authorized "Client Name / signed 2026-01-01"`
  for logging, never to bypass the intent).
- Network discovery is scoped to RFC-1918 private ranges by default; scanning
  a public range requires an explicit, logged opt-in.

## 3. Fill-in-the-blank config
- Inputs come from a `config.example.<ext>` you copy and edit — never
  hard-coded, never interactive-only. A tech should be able to fill a JSON
  and run without reading the code.
- Validate config on load; fail loudly with the exact missing/invalid field.

## 4. Logging = deliverable
- Every run appends a timestamped log to `field-kit/logs/<module>-<slug>-<date>.log`.
- Reports (HTML/Markdown) go to `field-kit/reports/`. These are what you hand
  the client and what justifies the invoice.

## 5. No dependencies where possible
- Python tools use the standard library only (runs on any laptop / WSL with
  nothing to install). If a tool genuinely needs a package, its README says so
  and it degrades gracefully when absent.
- PowerShell targets Windows PowerShell 5.1+ (built into Windows) — no modules
  that aren't installable via `Install-Module` from a default system.

## 6. Idempotent and resumable
- Re-running a script should be safe: detect what's already done and skip it,
  rather than doubling up or erroring.

## 7. Never
- Never weaken security to "make it work" (disabling the firewall, opening
  everything, blanket-allow rules) without a printed warning and confirmation.
- Never store client passwords in a config file in plaintext; read secrets
  from environment variables or prompt at runtime and never log them.
- Never touch anything outside the authorized scope.
