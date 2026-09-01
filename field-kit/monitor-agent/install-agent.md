# Scheduling the monitoring agent

The agent runs **one cycle and exits** — it is not a daemon. You schedule it to
run on an interval (every 5–15 minutes is typical) with the OS scheduler. Each
run writes a status JSON + log and, with `--apply`, sends an alert if anything
is a PROBLEM.

Two golden rules:

1. **Use `--apply` in the scheduled command.** Without it the agent runs every
   check but never actually sends an alert (a safe dry run). The schedule needs
   `--apply` for alerts to go out.
2. **Put secrets in environment variables, not the config file.** The agent
   reads the ntfy topic and webhook URL from env vars named in the config
   (`ntfy_topic_env`, `webhook_url_env`). Set those vars in the schedule so the
   secret never lands on disk or in a log.

Before scheduling, prove it works by hand once:

```bash
python3 agent.py yoursite.json            # DRY RUN — see the checks + the alert it WOULD send
python3 agent.py yoursite.json --apply    # real run — confirm a test alert reaches your phone
```

---

## Linux / macOS — cron

Edit the crontab for the user the agent should run as (`crontab -e`). Use
**absolute paths**, and set the secret env vars right in the crontab.

```cron
# Ark Field Kit — monitoring agent for <client>, every 10 minutes.
ARK_NTFY_TOPIC=your-secret-ntfy-topic
ARK_WEBHOOK_URL=https://hooks.example.com/xxxx
*/10 * * * * /usr/bin/python3 /home/user/Ark-App/field-kit/monitor-agent/agent.py /home/user/Ark-App/field-kit/monitor-agent/yoursite.json --apply >> /home/user/Ark-App/field-kit/logs/monitor-agent-cron.out 2>&1
```

Notes:
- The agent already writes its own timestamped log to `field-kit/logs/`; the
  `>> ...cron.out` redirect just captures anything unexpected.
- The agent **exits non-zero when any check is a PROBLEM.** If you would rather
  alert from cron itself (instead of, or in addition to, ntfy/webhook), append a
  command after `||`:

  ```cron
  */10 * * * * /usr/bin/python3 .../agent.py .../yoursite.json --apply || echo "monitor problem at $(date)" | mail -s "ALERT" you@example.com
  ```

- To run as a dedicated service account, create one and install the crontab
  under it. To run at boot as well, add an `@reboot` line.

### systemd timer (alternative to cron)

`/etc/systemd/system/ark-monitor.service`:

```ini
[Service]
Type=oneshot
Environment=ARK_NTFY_TOPIC=your-secret-ntfy-topic
ExecStart=/usr/bin/python3 /home/user/Ark-App/field-kit/monitor-agent/agent.py /home/user/Ark-App/field-kit/monitor-agent/yoursite.json --apply
```

`/etc/systemd/system/ark-monitor.timer`:

```ini
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ark-monitor.timer
systemctl list-timers ark-monitor.timer
```

---

## Windows — Task Scheduler (`schtasks`)

Windows PowerShell 5.1+ and `python` are assumed on PATH (install Python for all
users, or use the full path to `python.exe`). Run this **elevated** so the
firewall / pending-reboot checks can read machine state.

Set the secret as a **machine environment variable** once (elevated), so the
scheduled task inherits it without the secret appearing in the task definition:

```cmd
setx /M ARK_NTFY_TOPIC "your-secret-ntfy-topic"
setx /M ARK_WEBHOOK_URL "https://hooks.example.com/xxxx"
```

Then create the task (runs every 10 minutes as SYSTEM):

```cmd
schtasks /Create /TN "Ark Monitor Agent" /SC MINUTE /MO 10 /RU SYSTEM /RL HIGHEST /F ^
  /TR "python C:\ArkFieldKit\field-kit\monitor-agent\agent.py C:\ArkFieldKit\field-kit\monitor-agent\yoursite.json --apply"
```

- `/RU SYSTEM /RL HIGHEST` runs elevated with no stored password — best for the
  posture checks. To run as a specific service account instead:
  `... /RU "DOMAIN\svc-ark" /RP *` (you'll be prompted for the password).
- `setx /M` requires an elevated prompt and takes effect for tasks created
  afterward; if the task can't see the variable, recreate the task or reboot.
- Verify and test-fire the task:

  ```cmd
  schtasks /Query /TN "Ark Monitor Agent" /V /FO LIST
  schtasks /Run   /TN "Ark Monitor Agent"
  ```

- Remove it when the engagement ends:

  ```cmd
  schtasks /Delete /TN "Ark Monitor Agent" /F
  ```

---

## Where the output goes

- **Status JSON** (machine-readable, one per run + a stable `-latest.json`):
  `field-kit/reports/monitor-agent-<site>-<timestamp>.json`
- **Human log** (appended, one file per day):
  `field-kit/logs/monitor-agent-<site>-<date>.log`

Point a dashboard, another script, or your RMM at the `-latest.json` to pick up
the most recent status. Hand the client the daily log as the "we're watching it"
deliverable.

## Uninstall / handoff checklist

1. Remove the schedule (`crontab -e` line, `systemctl disable --now
   ark-monitor.timer`, or `schtasks /Delete`).
2. Remove the machine env vars if the secret should not persist
   (`setx` value via registry, or `Remove-Item Env:` is per-session only —
   delete under `HKLM\SYSTEM\...\Environment` for machine-wide).
3. Keep the logs/reports with the engagement records.
