# monitor-agent — Leave-behind live monitoring

A lightweight, read-only agent you schedule at a care-plan client's site (or on
your own server). Every run it checks the things that matter and alerts you when
something is wrong — turning "live monitoring" into a real recurring deliverable.

Each cycle reports:

- **Uptime** — boot time and how long the box has been up (load average on Unix).
- **Reachability** — each host/URL you list: HTTP, TCP-connect, or ping.
- **Disk** — local free space vs. a floor you set (PROBLEM) and a warning line.
- **Backup freshness** — is the expected backup file/dir newer than N hours; is
  it suspiciously small.
- **Security posture (Windows, best-effort)** — is the firewall on, is a reboot
  pending. On non-Windows these degrade gracefully to "skipped", never a failure.

Every run writes a machine-readable **status JSON** to `field-kit/reports/` and a
human **log** to `field-kit/logs/`, both stamped with the client/site name. On a
PROBLEM it alerts via **ntfy.sh** (phone push, no account) and/or a generic
**webhook**. Secrets come from environment variables and are never logged.

**Read-only.** The agent never changes a system, opens a port, or edits a file.
Standard library only — runs on any Windows/Linux/mac box with nothing to install.

## Quickstart

```bash
# 1. See it work right now — no config, no external network:
python3 agent.py --self-test
#    Runs a full cycle against a built-in sample (temp dir as a fake backup,
#    loopback checks), writes a status JSON + log, and exits non-zero because
#    the sample includes a deliberately-down service — proving alerting works.

# 2. Copy the config and fill in the client's site:
cp config.example.json yoursite.json
#    edit yoursite.json: site_name + what to watch (hosts/URLs, disks, backups)

# 3. Dry run — runs every check and PRINTS the alert it would send, sends nothing:
python3 agent.py yoursite.json

# 4. Real run — actually deliver alerts (this is what the schedule uses).
#    Put the ntfy topic / webhook in env vars, not the file:
ARK_NTFY_TOPIC=your-secret-topic python3 agent.py yoursite.json --apply

# 5. Schedule it (cron / systemd / Task Scheduler): see install-agent.md
```

Each run leaves:
- `field-kit/reports/monitor-agent-<site>-<timestamp>.json` (+ a stable
  `-latest.json` for dashboards/RMM to pick up the most recent status)
- `field-kit/logs/monitor-agent-<site>-<date>.log`

## Config fields (`config.example.json`)

| Field | Required | What it is |
|---|---|---|
| `site_name` | yes | Client site/building name — on every report and alert. |
| `client` | no | Legal client name for the deliverable + invoice trail. |
| `technician` | no | Who set it up. Defaults to Ark Web Solutions. |
| `authorized` | no | Note of the signed authorization, logged each run. `--authorized` overrides it. |
| `watch` | no | Reachability targets (see below). |
| `disks` | no | Local paths to check free space, with `min_free_pct` / `warn_free_pct`. |
| `backups` | no | Expected backup files/dirs, with `max_age_hours` (+ optional `min_size_bytes`). |
| `checks` | no | Toggle the Windows posture checks (`windows_firewall`, `pending_reboot`). |
| `reporting` | no | How alerts go out (ntfy / webhook / `alert_on`). |
| `http_timeout`, `tcp_timeout`, `ping_timeout` | no | Per-check timeout overrides (seconds). |

### `watch` entry shapes

```jsonc
{ "name": "Company website", "url": "https://example.com" }   // HTTP: up = status < 400 (or 401/403)
{ "name": "Server RDP", "host": "192.168.1.10", "port": 3389 } // TCP connect to that port
{ "name": "Gateway", "host": "192.168.1.1" }                   // ping (no port)
```

**HTTPS with a self-signed / internal cert.** A `url` check verifies the TLS
certificate. Internal boxes — NAS/DSM admin panels, routers, IP cameras,
iDRAC/ESXi, most LAN admin UIs — ship a self-signed cert that won't verify. The
agent does **not** call that an outage: a failed verification still proves the
host answered the TLS handshake, so it's reported as **WARN** ("UP but its TLS
certificate is not trusted"), never a false PROBLEM. Two ways to handle it:

```jsonc
{ "name": "NAS admin panel", "host": "192.168.1.30", "port": 5001 }        // preferred: cert-agnostic TCP-connect check
{ "name": "NAS admin panel", "url": "https://192.168.1.30:5001", "insecure": true } // HTTP check, skip cert verification
```

Use the TCP-port form when you only need "is it up"; use `"insecure": true`
(alias `"verify": false`) when you want the HTTP status code from a host whose
cert you knowingly can't verify.

### `reporting`

```jsonc
"reporting": {
  "ntfy_topic_env": "ARK_NTFY_TOPIC",     // NAME of an env var holding the topic (preferred)
  "ntfy_server": "https://ntfy.sh",       // optional; self-hosted ntfy works too
  "webhook_url_env": "ARK_WEBHOOK_URL",   // NAME of an env var holding a webhook URL
  "alert_on": "problem"                   // "problem" (default) | "warn" | "always" (heartbeat)
}
```

- **Secrets:** set `*_env` to the name of an environment variable. The agent
  reads the value from the environment and never writes it to a log. You *may*
  put `ntfy_topic` / `webhook_url` directly in the config, but the agent will
  warn you that the secret is now on disk.
- **`alert_on: "always"`** sends a notification every run even when all is well —
  a heartbeat / dead-man's-switch so you know the agent itself is alive.
- **ntfy** delivers a phone push (install the ntfy app, subscribe to your topic).
  **webhook** receives a JSON POST (`schema`, `site_name`, `overall`, `counts`,
  `problems[]`, `warnings[]`) — point it at Slack/Teams/your RMM.

## Severity & exit code

| Status | Meaning | Affects exit code? |
|---|---|---|
| `ok` | check passed | no |
| `warn` | worth attention (e.g. disk in warn zone, reboot pending) | no |
| `problem` | something is down / stale / off | **yes → exit 1** |
| `skipped` | check couldn't run here (e.g. Windows check on Linux) | no |

The agent **exits 0 when everything is OK (or only skipped), 1 when any check is
a PROBLEM** — so a cron line can alert on failure with `|| <command>` regardless
of the ntfy/webhook path.

## Notes & limits

- The firewall and pending-reboot checks are Windows-only and best-effort
  (`netsh` / `reg query`); on other platforms, or if a command isn't available,
  they report `skipped`, never a false failure.
- A disabled firewall is reported **loudly** as a PROBLEM — the agent only
  reports posture, it never changes it.
- Backup check on a directory uses the newest file inside it.
- Standard library only. Runs on any laptop / server / WSL with nothing to install.

## Testing this module

```bash
python3 -c "import py_compile; py_compile.compile('agent.py', doraise=True)"
python3 agent.py --help
python3 agent.py --self-test          # full offline cycle; exits non-zero (by design)
```
