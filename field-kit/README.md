# Ark Field Kit

On-site IT automation you run from a laptop at a client's location. Fill in
what the client tells you, run one command, done — network audits, VLAN and
firewall configs, Windows provisioning and Windows 11 upgrades, and security
checkups.

> **This toolkit is for authorized work only.** Every tool that touches a
> network or a machine you don't own prints an authorization banner and
> requires you to confirm you have the client's permission before it does
> anything. Run these only on equipment you've been hired to work on. This
> is standard, professional MSP practice — it protects you legally and it's
> exactly what cyber-insurance auditors want to see documented.

## The pattern (every module works the same way)

1. Copy the module's `config.example.*` and fill in the client's details.
2. Run the script. It **dry-runs by default** — shows you exactly what it
   would do without changing anything.
3. Review the plan. Re-run with `--apply` (or `-Apply` in PowerShell) to
   execute for real.
4. Every run writes a timestamped log to `field-kit/logs/` — your paper
   trail and the client's deliverable.

## Modules

| Module | What it does | Runs on |
|---|---|---|
| `netaudit/` | Discover & document a client's whole LAN → HTML report | Your laptop (Python) |
| `netconfig/` | Generate VLAN / firewall / guest-WiFi configs from one JSON | Your laptop → paste to gear |
| `windows/` | Win11 readiness, unattended upgrade, new-PC setup, debloat | Client Windows PCs (PowerShell) |
| `security/` | Cyber-hygiene audit → report tied to insurance questionnaires | Client Windows PCs + network |
| `monitor-agent/` | Leave-behind monitoring for care-plan clients | Client machine or your server |

See `CONVENTIONS.md` for how scripts are structured (useful when you train
someone to run them). Each module has its own README with a copy-paste
quickstart.

## The field workflow (what a visit looks like)

1. Arrive, get written authorization signed (`docs/authorization-form.md`).
2. Plug in. Run `netaudit` → you now have their whole network documented.
3. Do the work the job called for — `netconfig` to push VLANs, `windows`
   to upgrade PCs, `security` to harden and report.
4. Run `security` again to show before/after.
5. Hand them the reports. Set up `monitor-agent` if they're on a care plan.
6. The reports and logs justify the invoice and the recurring fee.
