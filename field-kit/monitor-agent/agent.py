#!/usr/bin/env python3
"""Ark Field Kit — Leave-behind live monitoring agent (read-only).

A lightweight agent you schedule at a care-plan client's site (or on your own
server) that, on every run, checks the things that matter and alerts you when
something is wrong — so "live monitoring" becomes a real recurring deliverable.

Each cycle it reports:

  * System uptime / boot time (and load average on Unix).
  * Reachability of the hosts and URLs you list (HTTP, TCP, or ping).
  * Local disk free space vs. a threshold you set.
  * Backup freshness — is the expected backup file/dir newer than N hours.
  * Security posture on Windows (best-effort): is the firewall on, is a
    reboot pending. On non-Windows these degrade gracefully to "skipped".

Every run writes a machine-readable status JSON to field-kit/reports/ and a
human log to field-kit/logs/, both stamped with the client/site name. On any
PROBLEM it alerts via ntfy.sh (phone push, no account needed) and/or a generic
webhook. Secrets (ntfy topic, webhook URL) come from environment variables or
config and are NEVER written to the log.

SAFE BY DEFAULT — the field-kit way:
  * A plain run is a DRY RUN: it performs every read-only check and prints the
    exact alert it WOULD send, but sends nothing.
  * Add --apply to actually deliver alerts (this is what your cron/Task
    Scheduler line uses).
  * --self-test runs one full cycle against a built-in sample (a temp dir as a
    fake backup, loopback checks) with no config and no external network, so
    you can see the output immediately.

The agent is READ-ONLY: it never changes a system, opens a port, or edits a
file. Standard library only — runs on any Windows/Linux/mac box with nothing
to install.

Exit code: 0 when everything is OK (or only skipped), 1 when any check is a
PROBLEM — so a cron line can alert on failure independently of push/webhook.
"""

import argparse
import json
import os
import platform
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import fieldkit  # noqa: E402  (path set up above)

MODULE = "monitor-agent"
BRAND = "Ark Web Solutions"
USER_AGENT = "ArkFieldKit-Monitor/1.0 (authorized read-only monitoring)"
SCHEMA = "ark-fieldkit-monitor/1"

DEFAULT_HTTP_TIMEOUT = 15      # seconds for a URL check
DEFAULT_TCP_TIMEOUT = 5        # seconds for a TCP-connect check
DEFAULT_PING_TIMEOUT = 4       # seconds for a ping
DEFAULT_CMD_TIMEOUT = 12       # seconds for a best-effort local subprocess
DEFAULT_MIN_FREE_PCT = 10.0    # disk problem threshold
DEFAULT_WARN_FREE_PCT = 20.0   # disk warn threshold
DEFAULT_NTFY_SERVER = "https://ntfy.sh"

# Severity ordering: higher number = more urgent. "skipped" sits below "ok"
# so any real result outranks it; a run made up only of skipped checks reports
# "skipped" overall (and, with zero problems, still exits 0).
SEV_RANK = {"skipped": 0, "ok": 1, "warn": 2, "problem": 3}
SEV_FROM_RANK = {v: k for k, v in SEV_RANK.items()}


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "site").lower()).strip("-")
    return slug or "site"


def file_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def iso_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def human_duration(seconds) -> str:
    if seconds is None:
        return "unknown"
    seconds = int(seconds)
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    mins, _ = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    parts.append(f"{mins}m")
    return " ".join(parts)


def human_bytes(n) -> str:
    if n is None:
        return "?"
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB", "PB"):
        if n < 1024 or unit == "PB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024


def result(category, name, status, detail, metric=None):
    return {"category": category, "name": name, "status": status,
            "detail": detail, "metric": metric or {}}


# --------------------------------------------------------------------------
# Reachability checks
# --------------------------------------------------------------------------
def check_url(entry, timeout):
    name = entry.get("name") or entry["url"]
    url = entry["url"]
    # A self-signed / internal TLS cert (NAS, router, IP camera, iDRAC/ESXi,
    # most LAN admin panels) is common and does NOT mean the box is down. Let a
    # target opt out of cert verification for reachability's sake ("insecure":
    # true, or "verify": false); otherwise a verify failure is reported as
    # "up but cert untrusted" (WARN) — the TLS handshake proves the host is up —
    # rather than a false outage.
    insecure = bool(entry.get("insecure")) or entry.get("verify") is False
    ctx = ssl._create_unverified_context() if insecure else None
    start = datetime.now()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            ms = int((datetime.now() - start).total_seconds() * 1000)
            status = getattr(resp, "status", None)
    except urllib.error.HTTPError as ex:
        ms = int((datetime.now() - start).total_seconds() * 1000)
        status = ex.code
    except urllib.error.URLError as ex:
        # urllib wraps a TLS-verify failure in URLError with the original
        # ssl.SSLCertVerificationError as its .reason. The handshake got far
        # enough to present a cert, so the host is up — just not trusted.
        reason = getattr(ex, "reason", None)
        if isinstance(reason, ssl.SSLCertVerificationError):
            ms = int((datetime.now() - start).total_seconds() * 1000)
            return result("reachability", name, "warn",
                          f"{url} is UP but its TLS certificate is not trusted "
                          f"({str(reason)[:80]}). Self-signed/internal cert? "
                          f'Add "insecure": true to accept it, or switch to a '
                          f"TCP-port check.",
                          {"url": url, "ms": ms, "cert_untrusted": True})
        return result("reachability", name, "problem",
                      f"{url} unreachable: {type(ex).__name__}: {str(ex)[:100]}",
                      {"url": url})
    except Exception as ex:  # noqa: BLE001 — a failed fetch is the signal
        return result("reachability", name, "problem",
                      f"{url} unreachable: {type(ex).__name__}: {str(ex)[:100]}",
                      {"url": url})
    metric = {"url": url, "http_status": status, "ms": ms,
              "tls_verified": not insecure}
    verify_note = " (TLS cert NOT verified)" if insecure else ""
    if status is None:
        return result("reachability", name, "warn",
                      f"{url} answered but returned no status code", metric)
    if status < 400 or status in (401, 403):
        note = " (auth-protected, treated as up)" if status in (401, 403) else ""
        return result("reachability", name, "ok",
                      f"{url} → HTTP {status}{note}, {ms}ms{verify_note}", metric)
    if status >= 500:
        return result("reachability", name, "problem",
                      f"{url} → HTTP {status} (server error), {ms}ms", metric)
    return result("reachability", name, "warn",
                  f"{url} → HTTP {status}, {ms}ms", metric)


def check_tcp(entry, timeout):
    host = entry["host"]
    port = int(entry["port"])
    name = entry.get("name") or f"{host}:{port}"
    start = datetime.now()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        rc = sock.connect_ex((host, port))
    except OSError as ex:
        rc = getattr(ex, "errno", -1)
    finally:
        try:
            sock.close()
        except OSError:
            pass
    ms = int((datetime.now() - start).total_seconds() * 1000)
    metric = {"host": host, "port": port, "ms": ms}
    if rc == 0:
        return result("reachability", name, "ok",
                      f"{host}:{port} accepting connections, {ms}ms", metric)
    return result("reachability", name, "problem",
                  f"{host}:{port} not reachable (TCP connect failed)", metric)


def check_ping(entry, timeout):
    host = entry["host"]
    name = entry.get("name") or host
    system = platform.system()
    if system == "Windows":
        cmd = ["ping", "-n", "1", "-w", str(int(timeout * 1000)), host]
    elif system == "Darwin":
        cmd = ["ping", "-c", "1", "-t", str(int(timeout)), host]
    else:  # Linux and friends
        cmd = ["ping", "-c", "1", "-w", str(int(timeout)), host]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout + 3)
    except FileNotFoundError:
        return result("reachability", name, "skipped",
                      f"cannot ping {host}: no 'ping' command available",
                      {"host": host})
    except subprocess.TimeoutExpired:
        return result("reachability", name, "problem",
                      f"{host} did not answer ping (timed out)", {"host": host})
    except Exception as ex:  # noqa: BLE001
        return result("reachability", name, "skipped",
                      f"ping {host} could not run: {type(ex).__name__}",
                      {"host": host})
    if proc.returncode == 0:
        return result("reachability", name, "ok",
                      f"{host} answered ping", {"host": host})
    return result("reachability", name, "problem",
                  f"{host} did not answer ping", {"host": host})


def check_reachability(entry, cfg):
    """Dispatch one watch entry to URL / TCP / ping based on its shape."""
    if "url" in entry and entry["url"]:
        return check_url(entry, cfg.get("http_timeout", DEFAULT_HTTP_TIMEOUT))
    if "host" in entry and entry.get("port"):
        return check_tcp(entry, cfg.get("tcp_timeout", DEFAULT_TCP_TIMEOUT))
    if "host" in entry and entry["host"]:
        return check_ping(entry, cfg.get("ping_timeout", DEFAULT_PING_TIMEOUT))
    return result("reachability", entry.get("name", "?"), "skipped",
                  "watch entry needs a 'url', or a 'host' (+ optional 'port')")


# --------------------------------------------------------------------------
# Disk free space
# --------------------------------------------------------------------------
def check_disk(entry):
    if isinstance(entry, str):
        entry = {"path": entry}
    path = entry.get("path")
    name = entry.get("name") or path
    if not path:
        return result("disk", name or "?", "skipped", "disk entry has no 'path'")
    min_free = float(entry.get("min_free_pct", DEFAULT_MIN_FREE_PCT))
    warn_free = float(entry.get("warn_free_pct", max(min_free, DEFAULT_WARN_FREE_PCT)))
    p = Path(path)
    if not p.exists():
        return result("disk", name, "problem",
                      f"{path} does not exist on this machine", {"path": path})
    try:
        usage = shutil.disk_usage(str(p))
    except OSError as ex:
        return result("disk", name, "skipped",
                      f"cannot read disk usage for {path}: {ex}", {"path": path})
    free_pct = usage.free / usage.total * 100 if usage.total else 0.0
    metric = {"path": path, "total_bytes": usage.total, "free_bytes": usage.free,
              "free_pct": round(free_pct, 1),
              "min_free_pct": min_free, "warn_free_pct": warn_free}
    summary = (f"{path}: {human_bytes(usage.free)} free of "
               f"{human_bytes(usage.total)} ({free_pct:.1f}%)")
    if free_pct < min_free:
        return result("disk", name, "problem",
                      f"{summary} — below {min_free:.0f}% floor", metric)
    if free_pct < warn_free:
        return result("disk", name, "warn",
                      f"{summary} — below {warn_free:.0f}% warning line", metric)
    return result("disk", name, "ok", summary, metric)


# --------------------------------------------------------------------------
# Backup freshness
# --------------------------------------------------------------------------
def newest_file(path: Path):
    """Return (Path, mtime, size) of the newest file at/under path, or None."""
    if path.is_file():
        st = path.stat()
        return (path, st.st_mtime, st.st_size)
    newest = None
    for root, _dirs, files in os.walk(str(path)):
        for fn in files:
            fp = Path(root) / fn
            try:
                st = fp.stat()
            except OSError:
                continue
            if newest is None or st.st_mtime > newest[1]:
                newest = (fp, st.st_mtime, st.st_size)
    return newest


def check_backup(entry, now=None):
    now = now or datetime.now().timestamp()
    path = entry.get("path")
    name = entry.get("name") or path
    if not path:
        return result("backup", name or "?", "skipped", "backup entry has no 'path'")
    max_age = float(entry.get("max_age_hours", 26))
    min_size = entry.get("min_size_bytes")
    p = Path(path)
    if not p.exists():
        return result("backup", name, "problem",
                      f"expected backup {path} is missing", {"path": path})
    newest = newest_file(p)
    if newest is None:
        return result("backup", name, "problem",
                      f"backup location {path} is empty — no backup files",
                      {"path": path})
    newest_path, mtime, size = newest
    age_hours = (now - mtime) / 3600.0
    metric = {"path": path, "newest_file": str(newest_path),
              "age_hours": round(age_hours, 2), "max_age_hours": max_age,
              "size_bytes": size,
              "modified": datetime.fromtimestamp(mtime).isoformat(timespec="seconds")}
    summary = (f"{path}: newest backup {human_bytes(size)}, "
               f"{human_duration(age_hours * 3600)} old "
               f"(limit {max_age:.0f}h)")
    if age_hours > max_age:
        return result("backup", name, "problem",
                      f"{summary} — STALE, backup has not run", metric)
    if min_size is not None and size < int(min_size):
        return result("backup", name, "warn",
                      f"{summary} — smaller than expected "
                      f"({human_bytes(size)} < {human_bytes(int(min_size))})",
                      metric)
    return result("backup", name, "ok", summary, metric)


# --------------------------------------------------------------------------
# System uptime (informational, best-effort, cross-platform)
# --------------------------------------------------------------------------
def get_uptime():
    info = {"seconds": None, "boot_time": None, "human": "unknown",
            "load_avg": None, "source": None}
    # Load average (Unix only).
    try:
        info["load_avg"] = [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        info["load_avg"] = None

    system = platform.system()
    # Linux: /proc/uptime is authoritative and dependency-free.
    proc_uptime = Path("/proc/uptime")
    if proc_uptime.exists():
        try:
            secs = float(proc_uptime.read_text().split()[0])
            info["seconds"] = secs
            info["boot_time"] = datetime.fromtimestamp(
                datetime.now().timestamp() - secs).isoformat(timespec="seconds")
            info["human"] = human_duration(secs)
            info["source"] = "/proc/uptime"
            return info
        except (OSError, ValueError):
            pass

    if system == "Windows":
        # Best-effort: wmic is deprecated but present on most builds.
        try:
            proc = subprocess.run(["wmic", "os", "get", "lastbootuptime"],
                                  capture_output=True, text=True, timeout=DEFAULT_CMD_TIMEOUT)
            for line in proc.stdout.splitlines():
                line = line.strip()
                if line and line[:8].isdigit():
                    boot = datetime.strptime(line.split(".")[0], "%Y%m%d%H%M%S")
                    secs = (datetime.now() - boot).total_seconds()
                    info.update(seconds=secs, boot_time=boot.isoformat(timespec="seconds"),
                                human=human_duration(secs), source="wmic")
                    return info
        except Exception:  # noqa: BLE001 — informational only
            pass
        # Fall back to PowerShell if wmic is gone.
        try:
            ps = ("(Get-Date) - (Get-CimInstance Win32_OperatingSystem)."
                  "LastBootUpTime | ForEach-Object { $_.TotalSeconds }")
            proc = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                                  capture_output=True, text=True, timeout=DEFAULT_CMD_TIMEOUT)
            secs = float(proc.stdout.strip())
            info.update(seconds=secs,
                        boot_time=datetime.fromtimestamp(
                            datetime.now().timestamp() - secs).isoformat(timespec="seconds"),
                        human=human_duration(secs), source="powershell")
            return info
        except Exception:  # noqa: BLE001
            pass
        return info

    # macOS / BSD: sysctl kern.boottime.
    try:
        proc = subprocess.run(["sysctl", "-n", "kern.boottime"],
                              capture_output=True, text=True, timeout=DEFAULT_CMD_TIMEOUT)
        m = re.search(r"sec\s*=\s*(\d+)", proc.stdout)
        if m:
            boot_ts = int(m.group(1))
            secs = datetime.now().timestamp() - boot_ts
            info.update(seconds=secs,
                        boot_time=datetime.fromtimestamp(boot_ts).isoformat(timespec="seconds"),
                        human=human_duration(secs), source="sysctl")
            return info
    except Exception:  # noqa: BLE001
        pass
    return info


# --------------------------------------------------------------------------
# Windows security posture (best-effort; degrades to "skipped" elsewhere)
# --------------------------------------------------------------------------
def check_windows_firewall(cfg):
    name = "Windows Firewall"
    if platform.system() != "Windows":
        return result("security", name, "skipped",
                      "not a Windows host — firewall check does not apply")
    try:
        proc = subprocess.run(["netsh", "advfirewall", "show", "allprofiles", "state"],
                              capture_output=True, text=True, timeout=DEFAULT_CMD_TIMEOUT)
    except Exception as ex:  # noqa: BLE001
        return result("security", name, "skipped",
                      f"could not query firewall (netsh): {type(ex).__name__}")
    text = proc.stdout or ""
    # Lines look like: "State                                 ON"
    states = [m.group(1).upper()
              for m in re.finditer(r"State\s+(\w+)", text, re.IGNORECASE)]
    if not states:
        return result("security", name, "skipped",
                      "firewall state could not be parsed from netsh output")
    off = [s for s in states if s == "OFF"]
    metric = {"profile_states": states}
    if off:
        # A disabled firewall is a genuine posture problem — report loudly,
        # never silently. This tool only reports; it changes nothing.
        return result("security", name, "problem",
                      f"firewall is OFF on {len(off)} of {len(states)} profiles "
                      f"— network exposed", metric)
    return result("security", name, "ok",
                  f"firewall ON for all {len(states)} profiles", metric)


REBOOT_KEYS = [
    (r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
     None, "Component Based Servicing"),
    (r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
     None, "Windows Update"),
    (r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager",
     "PendingFileRenameOperations", "Pending file rename"),
]


def check_pending_reboot(cfg):
    name = "Pending reboot"
    if platform.system() != "Windows":
        return result("security", name, "skipped",
                      "not a Windows host — pending-reboot check does not apply")
    reasons = []
    for key, value, label in REBOOT_KEYS:
        cmd = ["reg", "query", key]
        if value:
            cmd += ["/v", value]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=DEFAULT_CMD_TIMEOUT)
            if proc.returncode == 0:
                reasons.append(label)
        except Exception:  # noqa: BLE001 — treat as "cannot tell"
            continue
    metric = {"reasons": reasons}
    if reasons:
        # A pending reboot means updates aren't fully applied — a warning,
        # not an outage. Reported, but does not fail the exit code.
        return result("security", name, "warn",
                      "a reboot is pending (" + ", ".join(reasons) +
                      ") — updates not fully applied", metric)
    return result("security", name, "ok", "no reboot pending", metric)


# --------------------------------------------------------------------------
# Run all configured checks
# --------------------------------------------------------------------------
def run_checks(cfg):
    checks = []

    for entry in cfg.get("watch", []) or []:
        checks.append(check_reachability(entry, cfg))

    for entry in cfg.get("disks", []) or []:
        checks.append(check_disk(entry))

    for entry in cfg.get("backups", []) or []:
        checks.append(check_backup(entry))

    posture = cfg.get("checks", {}) or {}
    if posture.get("windows_firewall", True):
        checks.append(check_windows_firewall(cfg))
    if posture.get("pending_reboot", True):
        checks.append(check_pending_reboot(cfg))

    return checks


def overall_severity(checks):
    if not checks:
        return "ok"
    top = max(SEV_RANK[c["status"]] for c in checks)
    return SEV_FROM_RANK[top]


def count_by_status(checks):
    counts = {"ok": 0, "warn": 0, "problem": 0, "skipped": 0}
    for c in checks:
        counts[c["status"]] = counts.get(c["status"], 0) + 1
    return counts


# --------------------------------------------------------------------------
# Reporting: resolve secrets, build + send alerts
# --------------------------------------------------------------------------
def resolve_reporting(cfg, log):
    """Read secrets from env (preferred) or config. NEVER log the values."""
    rep = cfg.get("reporting", {}) or {}
    topic = None
    if rep.get("ntfy_topic_env"):
        topic = os.environ.get(rep["ntfy_topic_env"])
    if not topic and rep.get("ntfy_topic"):
        topic = rep["ntfy_topic"]
    webhook = None
    if rep.get("webhook_url_env"):
        webhook = os.environ.get(rep["webhook_url_env"])
    if not webhook and rep.get("webhook_url"):
        webhook = rep["webhook_url"]

    resolved = {
        "ntfy_topic": topic or None,
        "ntfy_server": rep.get("ntfy_server", DEFAULT_NTFY_SERVER),
        "webhook_url": webhook or None,
        "alert_on": (rep.get("alert_on") or "problem").lower(),
    }
    # Log only whether each method is configured — never the secret itself.
    log.log(f"  Reporting: ntfy {'configured' if topic else 'not set'}; "
            f"webhook {'configured' if webhook else 'not set'}; "
            f"alert_on={resolved['alert_on']}")
    if rep.get("ntfy_topic") and not rep.get("ntfy_topic_env"):
        log.log("  NOTE: ntfy topic is stored in the config file. Prefer "
                "'ntfy_topic_env' and an environment variable so the secret "
                "never lives on disk.")
    if rep.get("webhook_url") and not rep.get("webhook_url_env"):
        log.log("  NOTE: webhook URL is stored in the config file. Prefer "
                "'webhook_url_env' and an environment variable so the secret "
                "never lives on disk.")
    return resolved


def should_alert(overall, alert_on):
    if alert_on == "always":
        return True
    if alert_on == "warn":
        return SEV_RANK[overall] >= SEV_RANK["warn"]
    return SEV_RANK[overall] >= SEV_RANK["problem"]


def build_alert_text(status):
    site = status["site_name"]
    overall = status["overall"].upper()
    lines = [f"{site}: {overall}"]
    flagged = [c for c in status["checks"] if c["status"] in ("problem", "warn")]
    for c in sorted(flagged, key=lambda x: -SEV_RANK[x["status"]]):
        lines.append(f"[{c['status'].upper()}] {c['name']}: {c['detail']}")
    if overall == "OK":
        counts = status["counts"]
        lines.append(f"All {counts['ok']} checks OK "
                     f"({counts['skipped']} skipped).")
    lines.append(f"host: {status['host_machine']}  at {status['generated_at']}")
    return "\n".join(lines)


def ascii_header(value: str) -> str:
    """HTTP headers must be latin-1/ASCII. Normalize common punctuation
    (em/en dashes, smart quotes), transliterate accents (Café -> Cafe), then
    drop anything still non-ASCII — so a site name with fancy characters can't
    break alert delivery. The full-fidelity text still rides in the body."""
    subs = {"—": "-", "–": "-", "‘": "'", "’": "'",
            "“": '"', "”": '"', "…": "...", " ": " "}
    for bad, good in subs.items():
        value = value.replace(bad, good)
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    return value or "alert"


def send_ntfy(server, topic, title, body, priority):
    url = f"{server.rstrip('/')}/{topic}"
    # Body goes out as UTF-8 (ntfy handles it); the Title header must be ASCII.
    req = urllib.request.Request(
        url, data=body.encode("utf-8"),
        headers={"User-Agent": USER_AGENT, "Title": ascii_header(title),
                 "Priority": priority, "Tags": "ark,monitor"})
    with urllib.request.urlopen(req, timeout=DEFAULT_HTTP_TIMEOUT) as resp:
        return 200 <= getattr(resp, "status", 200) < 300


def send_webhook(url, status):
    payload = {
        "schema": SCHEMA,
        "site_name": status["site_name"],
        "client": status["client"],
        "overall": status["overall"],
        "counts": status["counts"],
        "generated_at": status["generated_at"],
        "host_machine": status["host_machine"],
        "problems": [c for c in status["checks"] if c["status"] == "problem"],
        "warnings": [c for c in status["checks"] if c["status"] == "warn"],
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=DEFAULT_HTTP_TIMEOUT) as resp:
        return 200 <= getattr(resp, "status", 200) < 300


def deliver_alerts(status, reporting, apply, log):
    """Send (or, in dry run, describe) alerts. Returns a delivery dict."""
    delivery = {"attempted": False, "sent": False, "ntfy": None, "webhook": None,
                "reason": None}
    overall = status["overall"]
    if not should_alert(overall, reporting["alert_on"]):
        delivery["reason"] = (f"overall={overall}, alert_on="
                              f"{reporting['alert_on']} — nothing to alert")
        log.log(f"  No alert needed ({delivery['reason']}).")
        return delivery

    title = f"{BRAND}: {status['site_name']} — {overall.upper()}"
    body = build_alert_text(status)
    priority = "high" if overall == "problem" else "default"

    if not reporting["ntfy_topic"] and not reporting["webhook_url"]:
        delivery["reason"] = "no reporting method configured"
        log.log("  ALERT CONDITION but no reporting method configured "
                "(set a ntfy topic or webhook to get pushed). Alert text:")
        for ln in body.splitlines():
            log.log(f"    | {ln}")
        return delivery

    log.log(f"  Alert prepared (priority={priority}). Would notify: "
            f"{'ntfy ' if reporting['ntfy_topic'] else ''}"
            f"{'webhook' if reporting['webhook_url'] else ''}".strip())
    for ln in body.splitlines():
        log.log(f"    | {ln}")

    if not apply:
        delivery["reason"] = "dry run — alert NOT sent (re-run with --apply)"
        log.log(f"  DRY RUN: {delivery['reason']}.")
        return delivery

    delivery["attempted"] = True
    if reporting["ntfy_topic"]:
        try:
            ok = send_ntfy(reporting["ntfy_server"], reporting["ntfy_topic"],
                           title, body, priority)
            delivery["ntfy"] = "sent" if ok else "non-2xx response"
            delivery["sent"] = delivery["sent"] or ok
            log.log("  ntfy push delivered." if ok else
                    "  ntfy push returned a non-success status.")
        except Exception as ex:  # noqa: BLE001 — never crash the agent on alert failure
            delivery["ntfy"] = f"error: {type(ex).__name__}"
            log.log(f"  ntfy delivery failed: {type(ex).__name__}: {str(ex)[:100]}")
    if reporting["webhook_url"]:
        try:
            ok = send_webhook(reporting["webhook_url"], status)
            delivery["webhook"] = "sent" if ok else "non-2xx response"
            delivery["sent"] = delivery["sent"] or ok
            log.log("  webhook delivered." if ok else
                    "  webhook returned a non-success status.")
        except Exception as ex:  # noqa: BLE001
            delivery["webhook"] = f"error: {type(ex).__name__}"
            log.log(f"  webhook delivery failed: {type(ex).__name__}: {str(ex)[:100]}")
    return delivery


# --------------------------------------------------------------------------
# Status assembly + persistence
# --------------------------------------------------------------------------
def build_status(cfg, checks, uptime, apply, authorization):
    overall = overall_severity(checks)
    return {
        "schema": SCHEMA,
        "module": MODULE,
        "site_name": cfg["site_name"],
        "client": cfg.get("client", cfg["site_name"]),
        "technician": cfg.get("technician", BRAND),
        "host_machine": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "generated_at": iso_now(),
        "generated_at_human": fieldkit.timestamp(),
        "mode": fieldkit.mode_label(apply),
        "authorization": authorization,
        "overall": overall,
        "counts": count_by_status(checks),
        "uptime": uptime,
        "checks": checks,
    }


def write_status_json(status, slug, log):
    fieldkit.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamped = fieldkit.REPORT_DIR / f"{MODULE}-{slug}-{file_stamp()}.json"
    latest = fieldkit.REPORT_DIR / f"{MODULE}-{slug}-latest.json"
    payload = json.dumps(status, indent=2)
    stamped.write_text(payload, encoding="utf-8")
    latest.write_text(payload, encoding="utf-8")
    log.log(f"  Status JSON: {stamped}")
    log.log(f"  Latest JSON: {latest}")
    return stamped


def print_summary(status, log):
    icons = {"ok": "OK  ", "warn": "WARN", "problem": "DOWN", "skipped": "--  "}
    log.log("")
    log.log(f"Site: {status['site_name']}   Host: {status['host_machine']}"
            f"   ({status['platform']})")
    up = status["uptime"]
    load = ("  load " + "/".join(str(x) for x in up["load_avg"])
            if up.get("load_avg") else "")
    log.log(f"Uptime: {up['human']}"
            + (f" (since {up['boot_time']})" if up.get("boot_time") else "")
            + load)
    log.log("Checks:")
    for c in status["checks"]:
        log.log(f"  [{icons.get(c['status'], '?')}] "
                f"{c['category']:<12} {c['name']}")
        log.log(f"         {c['detail']}")
    counts = status["counts"]
    log.log("")
    log.log(f"OVERALL: {status['overall'].upper()}   "
            f"(ok {counts['ok']}, warn {counts['warn']}, "
            f"problem {counts['problem']}, skipped {counts['skipped']})")


# --------------------------------------------------------------------------
# One monitoring cycle (shared by normal runs and self-test)
# --------------------------------------------------------------------------
def run_cycle(cfg, args, log, authorization):
    log.log(f"Mode: {fieldkit.mode_label(args.apply)}  "
            f"(monitor-agent is read-only; --apply only enables alert delivery)")
    log.log(f"Site: {cfg['site_name']}   Client: {cfg.get('client', cfg['site_name'])}")
    log.log(f"Authorization: {authorization}")

    watch_n = len(cfg.get("watch", []) or [])
    disk_n = len(cfg.get("disks", []) or [])
    backup_n = len(cfg.get("backups", []) or [])
    log.log(f"Plan: {watch_n} reachability, {disk_n} disk, {backup_n} backup "
            f"check(s), plus best-effort security posture.")
    if watch_n + disk_n + backup_n == 0:
        log.log("  NOTE: nothing to watch is configured (no watch/disks/backups). "
                "Fill in the config so the agent has something to monitor.")

    reporting = resolve_reporting(cfg, log)

    log.log("")
    log.log("Running checks (read-only)...")
    checks = run_checks(cfg)
    uptime = get_uptime()

    status = build_status(cfg, checks, uptime, args.apply, authorization)
    print_summary(status, log)

    delivery = deliver_alerts(status, reporting, args.apply, log)
    status["alert_delivery"] = delivery

    slug = slugify(cfg["site_name"])
    write_status_json(status, slug, log)
    return status


# --------------------------------------------------------------------------
# Self-test: a full cycle with no config and no external network
# --------------------------------------------------------------------------
def run_self_test(args):
    slug = "selftest"
    log = fieldkit.Logger(MODULE, slug)
    print(fieldkit.BANNER)
    log.log("SELF-TEST: one full monitoring cycle against a built-in sample "
            "(temp dir as a fake backup, loopback checks). No config needed; "
            "no alerts are sent.")

    tmp = Path(tempfile.mkdtemp(prefix="ark-monitor-selftest-"))
    fresh_backup = tmp / "backup-fresh"
    fresh_backup.mkdir()
    (fresh_backup / "nightly.bak").write_text("pretend backup contents\n")
    missing_backup = tmp / "backup-that-never-ran"  # deliberately absent

    cfg = {
        "site_name": "Demo Site (self-test)",
        "client": "Example Client LLC",
        "technician": f"{BRAND} / self-test",
        # Loopback checks: no external network required, deterministic.
        "watch": [
            {"name": "Loopback ping", "host": "127.0.0.1"},
            {"name": "Local web (expected closed)", "host": "127.0.0.1",
             "port": 9},  # discard port: almost always refused -> a PROBLEM
        ],
        "disks": [
            {"name": "Temp filesystem", "path": str(tmp), "min_free_pct": 1},
        ],
        "backups": [
            {"name": "Fresh nightly backup", "path": str(fresh_backup),
             "max_age_hours": 24},
            {"name": "Missing weekly backup", "path": str(missing_backup),
             "max_age_hours": 168},
        ],
        "checks": {"windows_firewall": True, "pending_reboot": True},
        "reporting": {"alert_on": "problem"},
    }

    status = run_cycle(cfg, args, log, authorization="SELF-TEST — no real site")

    log.log("")
    log.log("SELF-TEST complete. The 'PROBLEM' results above are expected — "
            "they demonstrate the agent catching a down service and a missing "
            "backup, and it will exit non-zero so cron would alert.")
    log.close()

    # Clean up the temp sample.
    try:
        shutil.rmtree(tmp)
    except OSError:
        pass

    print(f"\nSelf-test overall: {status['overall'].upper()}")
    return 1 if status["counts"]["problem"] else 0


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def build_parser():
    parser = argparse.ArgumentParser(
        description="Ark Field Kit — leave-behind live monitoring agent "
                    "(read-only): uptime, reachability, disk, backup, and "
                    "Windows security posture -> status JSON + alerts.")
    parser.add_argument("config", nargs="?", default=None,
                        help="path to your filled-in config JSON "
                             "(see config.example.json); omit only with --self-test")
    parser.add_argument("--apply", action="store_true",
                        help="deliver alerts for real (default is a DRY RUN that "
                             "runs every check and prints the alert but sends nothing)")
    parser.add_argument("--self-test", action="store_true",
                        help="run one full cycle against a built-in sample (no "
                             "config, no external network) and exit")
    parser.add_argument("--authorized", metavar="NOTE",
                        help='record signed authorization for the log, e.g. '
                             '"Joe\'s HVAC / care plan / signed 2026-01-04"')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.self_test:
        return run_self_test(args)

    if not args.config:
        sys.exit("No config given. Provide a config JSON, or use --self-test.\n"
                 "Copy config.example.json, fill it in, and pass its path.")

    cfg = fieldkit.load_config(args.config, required=["site_name"])

    # Light structural validation with loud, specific errors.
    for key in ("watch", "disks", "backups"):
        if key in cfg and cfg[key] is not None and not isinstance(cfg[key], list):
            sys.exit(f"Config field '{key}' must be a list (or omitted).")

    authorization = (args.authorized or cfg.get("authorized")
                     or "recorded in config / read-only monitoring")

    slug = slugify(cfg["site_name"])
    log = fieldkit.Logger(MODULE, slug)
    # Print the banner so every run identifies the site and its authorization.
    # This is a non-interactive read-only agent (built to be scheduled), so it
    # records authorization rather than blocking on a prompt.
    print(fieldkit.BANNER)

    status = run_cycle(cfg, args, log, authorization)

    log.log("")
    if not args.apply and status["overall"] in ("problem", "warn"):
        log.log("DRY RUN — checks ran but no alert was delivered. The scheduled "
                "agent uses --apply so alerts actually go out.")
    log.close()

    problems = status["counts"]["problem"]
    print(f"\nDone. Overall: {status['overall'].upper()}. "
          f"Status JSON + log written to field-kit/reports and field-kit/logs.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
