# windows — Windows provisioning & Windows 11 upgrade

PowerShell scripts you run on a client's Windows PCs to check Windows 11
readiness, perform an unattended upgrade, provision a new machine to the
client's standard build, and strip consumer bloatware. Windows PowerShell
5.1+ (built into Windows) — no modules to install.

Every state-changing script **dry-runs by default** and prints exactly what it
would do. Real changes require `-Apply`. Each run prints an authorization
banner and writes a transcript log to `field-kit\logs\`.

## Scripts

| Script | What it does | Changes the machine? |
|---|---|---|
| `Win11-Readiness.ps1` | TPM 2.0 / Secure Boot / CPU / RAM / disk → PASS/FAIL + HTML report | No (read-only) |
| `Win11-Upgrade.ps1` | Pre-flight + unattended in-place upgrade to Windows 11 | Yes (`-Apply`) |
| `New-PC-Setup.ps1` | Rename, join workgroup/domain, timezone, power, install winget apps | Yes (`-Apply`) |
| `Debloat.ps1` | Remove a curated, safe list of consumer bloatware Appx packages | Yes (`-Apply`) |

`_FieldKit.ps1` is the shared helper (banner, logging, config) the scripts
dot-source. `check-ps-syntax.py` structurally validates the `.ps1` files in
this environment (pwsh isn't installed here).

## Quickstart (run on the client PC, from an elevated PowerShell)

```powershell
cd <path>\field-kit\windows

# 0. Copy the config and fill it in (one file drives all four scripts):
Copy-Item config.example.json frontdesk.json
notepad frontdesk.json

# 1. Is this PC Windows 11 capable? (read-only, writes an HTML report)
powershell -ExecutionPolicy Bypass -File .\Win11-Readiness.ps1 -Config frontdesk.json

# 2. Provision a new PC — DRY RUN first (shows the plan, changes nothing):
.\New-PC-Setup.ps1 -Config frontdesk.json
#    then for real:
.\New-PC-Setup.ps1 -Config frontdesk.json -Apply -Authorized "Joe's HVAC / signed 2026-01-04"

# 3. Remove consumer bloatware — DRY RUN, then apply:
.\Debloat.ps1 -Config frontdesk.json
.\Debloat.ps1 -Config frontdesk.json -Apply
.\Debloat.ps1 -ShowRestoreNote          # how to put anything back

# 4. Upgrade to Windows 11 — DRY RUN runs the full pre-flight, then apply:
.\Win11-Upgrade.ps1 -Config frontdesk.json
.\Win11-Upgrade.ps1 -Config frontdesk.json -Apply -Authorized "Joe's HVAC / signed 2026-01-04"
```

> On many systems you must allow the scripts to run this session:
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`. Run the
> upgrade and setup scripts from an **elevated** (Administrator) PowerShell.

## Config fields (`config.example.json`)

One JSON drives every script; each script reads only the fields it needs.

| Field | Used by | What it is |
|---|---|---|
| `site_name` | all | Required. PC/site label on logs & reports. |
| `client`, `technician` | all | Optional. Invoice-trail labels. |
| `upgrade_source` | Upgrade | `installationassistant` or `iso`. |
| `iso_path` | Upgrade | Full path to a Win11 ISO when source is `iso`. |
| `installation_assistant_url` | Upgrade | Override the assistant download URL. |
| `min_free_gb` | Upgrade | Minimum free GB on the system drive (default 25). |
| `computer_name` | Setup | Rename target. Empty = skip. |
| `workgroup` / `domain` | Setup | Workgroup to join, or AD domain (prompts for creds). |
| `timezone` | Setup | Windows timezone Id, e.g. `Eastern Standard Time`. |
| `power_plan` | Setup | `Balanced`, `High performance`, or `Power saver`. |
| `monitor_timeout_min` | Setup | Minutes before the display (monitor) turns off on AC. Monitor-off only — does not lock the screen or sleep the PC. |
| `winget_apps` | Setup | List of exact winget package IDs to install (idempotent). |
| `debloat_extra` / `debloat_keep` | Debloat | Add to / subtract from the removal list. |

Secrets are never stored in the config: a domain join prompts for credentials
at runtime and they are never logged.

## Safety notes

- **Readiness `REVIEW` items** (TPM/Secure Boot toggles, CPU model) are usually
  a firmware setting or a lookup against Microsoft's supported-processor list —
  not a hard failure. The overall verdict distinguishes `NOT READY` (a real
  FAIL) from `READY (with review)`.
- **`Win11-Upgrade.ps1 -AllowUnsupported`** is the only way to set Microsoft's
  documented registry workaround
  (`HKLM\SYSTEM\Setup\MoSetup\AllowUpgradesWithUnsupportedTPMOrCPU = 1`) for
  supported-but-blocked hardware. It prints a loud warning: such PCs are an
  unsupported configuration and are not guaranteed to receive updates. Get the
  client's written sign-off first. Off by default.
- **`Debloat.ps1`** only removes a conservative, curated list of consumer apps
  (casual games, Xbox social, promo apps). It never touches system components,
  security, the Store, or productivity apps. Everything it removes is
  reinstallable free from the Microsoft Store (`-ShowRestoreNote`).
- The upgrade creates a **System Restore point** before starting and refuses to
  run on battery or with insufficient disk space.

## Testing this module (in this build environment)

`pwsh` isn't installed here, so validate the PowerShell structurally:

```bash
python3 -c "import py_compile; py_compile.compile('check-ps-syntax.py', doraise=True)"
python3 check-ps-syntax.py          # checks every .ps1 in this folder — must PASS
```

The checker verifies balanced `{} () []`, balanced here-strings
(`@" … "@` / `@' … '@`), and that each entry-point script has a `param()`
block and a `[CmdletBinding()]` attribute. On a real Windows box, always do a
dry run (no `-Apply`) and read the printed plan before applying.
