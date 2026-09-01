# Security — cyber-hygiene audit, hardening & insurance report

A three-part security checkup for a single Windows machine, run on a client's
own equipment you're authorized to service. It produces the deliverable that
sells the cyber-insurance questionnaire service and the remediation work.

1. **`Invoke-SecurityAudit.ps1`** — a *read-only* audit of a Windows machine.
   Writes structured JSON to `field-kit/reports/`. Changes nothing.
2. **`Invoke-Hardening.ps1`** — applies the common, *safe* fixes. Dry-run by
   default; real changes need `-Apply`. Every change prints a reversal note.
3. **`insurance-report.py`** — reads the audit JSON and builds an HTML report
   mapping the findings to a typical small-business cyber-insurance
   application (endpoint protection, patch cadence, encryption at rest, MFA,
   backups, security-awareness training, incident-response plan).

Standard-library Python (runs anywhere). PowerShell targets built-in Windows
PowerShell 5.1+.

---

## Quickstart

### 1. Audit the machine (read-only, on the Windows box)

Run in an **elevated** PowerShell for complete results (BitLocker, full
password policy). Read-only — it never changes a setting.

```powershell
# From the security\ folder on the client Windows machine:
.\Invoke-SecurityAudit.ps1 -SiteName "Joe's HVAC — Main Office" `
    -Client "Joe's HVAC LLC" `
    -Authorized "Joe's HVAC LLC / signed 2026-01-04"
```

It prints an authorization banner, runs the checks, and writes:

```
field-kit\reports\security-audit-<site>-<timestamp>.json
field-kit\logs\security-audit-<site>-<date>.log
```

Checks: Defender/AV status & signature age, firewall (all profiles),
BitLocker, Windows Update last-patched date & pending criticals, local admin
accounts & built-in-admin state, RDP exposure, SMBv1, screen-lock timeout,
password policy, guest account, autorun, and domain/workgroup membership.
Each finding has a severity (`good` / `warn` / `critical` / `unknown`) and a
plain-English explanation.

### 2. Build the insurance report (on your laptop or the same box)

```bash
# Copy and fill in the config once per client:
cp config.example.json myclient.json
#   edit site_name, client, contact_name, contact_email, technician

python3 insurance-report.py myclient.json --audit ../reports/security-audit-joe-s-hvac-main-office-<timestamp>.json
```

Writes `field-kit/reports/insurance-report-<site>-<timestamp>.html` — the
client-facing deliverable. Open it in a browser and Print → Save as PDF.

See the whole thing with **no machine and no network**:

```bash
python3 insurance-report.py --self-test
```

This writes `sample-audit.json` (the exact input shape the PowerShell audit
produces) and renders a demo report from it.

### 3. Fix the safe findings (optional, back on the Windows box)

Dry run first — it changes nothing and prints the plan plus a reversal note
for every item:

```powershell
.\Invoke-Hardening.ps1 -SiteName "Joe's HVAC — Main Office"
```

Then apply for real (elevated PowerShell):

```powershell
.\Invoke-Hardening.ps1 -SiteName "Joe's HVAC — Main Office" -Apply `
    -Authorized "Joe's HVAC LLC / signed 2026-01-04"
```

Fixes: enable firewall (all profiles), disable SMBv1, disable Guest, set a
15-minute screen lock, enable Defender real-time protection, and set a sane
password policy. Items with a lockout risk (password lockout policy; firewall
while you're on a Remote Desktop session) print a warning and ask for a second
confirmation unless you also pass `-Yes`. Re-run the audit afterward to
confirm the new posture. The script never disables the firewall, never opens
blanket-allow rules, and never touches RDP or user passwords.

---

## Config fields (`config.example.json`)

| field | required | purpose |
|-------|----------|---------|
| `site_name` | yes | Physical site / building. Shown on the report. |
| `client` | no | Legal client name for the report + invoice trail. |
| `contact_name` | no | Client contact for remediation follow-up. |
| `contact_email` | no | Where the deliverable / answers get sent. |
| `technician` | no | Who ran the audit. Defaults to Ark Web Solutions. |
| `authorization` | no | Signed-authorization note for the report footer. |

The PowerShell scripts read the machine directly and take their site /
authorization on the command line — they do not need the JSON config. The
config is for `insurance-report.py`.

---

## Safety model

- **Audit is read-only.** It only reads status (cmdlets, WMI/CIM, registry,
  `net accounts`). Not-elevated runs degrade to `unknown`, never fail.
- **Hardening is dry-run by default.** Real changes require `-Apply`; each is
  printed with a reversal note; lockout-risk items need a second `yes`.
- **Authorization banner** on both scripts; `-Authorized "note"` records the
  signed authorization for the log instead of prompting.
- **No secrets** are read or logged. **Logging is the deliverable** — every
  run appends to `field-kit/logs/`.

---

## Testing / validation

`pwsh` is not installed in the dev environment, so the PowerShell scripts are
validated structurally by `check-ps-syntax.py` (balanced brackets, balanced
here-strings, `param()` and `[CmdletBinding()]` present). The scripts
themselves are authored for real Windows 5.1+ machines.

```bash
# Structural check of both .ps1 files (expect: all pass)
python3 check-ps-syntax.py

# Python report builder
python3 -c "import py_compile; py_compile.compile('insurance-report.py', doraise=True)"
python3 insurance-report.py --help
python3 insurance-report.py --self-test        # renders from bundled sample
```

## Files

```
security/
├── Invoke-SecurityAudit.ps1   read-only Windows audit -> JSON
├── Invoke-Hardening.ps1       safe fixes, dry-run by default (-Apply)
├── insurance-report.py        audit JSON -> HTML insurance-readiness report
├── check-ps-syntax.py         structural validator for the .ps1 files
├── config.example.json        copy to myclient.json and fill in
├── sample-audit.json          example audit JSON (written by --self-test)
└── README.md
```
