#!/usr/bin/env python3
"""Client-site monitor: uptime, SSL expiry, and domain expiry in one pass.

Usage:
    python3 tools/monitor.py                # check everything in tools/sites.json
    python3 tools/monitor.py --json         # machine-readable output

Exit code is 0 when all checks pass, 1 when anything is DOWN or WARN —
so a cron line can alert on failure:

    */15 * * * * cd /path/to/Ark-App && python3 tools/monitor.py || <alert command>

Optional alerting: set NTFY_TOPIC (https://ntfy.sh) and failures are pushed
to your phone with no account needed:

    NTFY_TOPIC=ark-web-alerts python3 tools/monitor.py

No third-party dependencies. Domain expiry uses RDAP (the modern WHOIS).
"""

import json
import os
import socket
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITES_FILE = Path(__file__).parent / "sites.json"
TIMEOUT = 15
SSL_WARN_DAYS = 14
DOMAIN_WARN_DAYS = 30
UA = {"User-Agent": "ArkMonitor/1.0"}


def check_http(url: str) -> dict:
    start = time.time()
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            ms = int((time.time() - start) * 1000)
            ok = 200 <= resp.status < 400
            return {"ok": ok, "status": resp.status, "ms": ms}
    except Exception as e:
        return {"ok": False, "status": None, "ms": None, "error": str(e)[:120]}


def check_ssl(domain: str) -> dict:
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((domain, 443), timeout=TIMEOUT) as sock:
            with ctx.wrap_socket(sock, server_hostname=domain) as tls:
                cert = tls.getpeercert()
        expires = datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(
            tzinfo=timezone.utc
        )
        days = (expires - datetime.now(timezone.utc)).days
        return {"ok": days > SSL_WARN_DAYS, "days_left": days}
    except Exception as e:
        return {"ok": False, "days_left": None, "error": str(e)[:120]}


def check_domain(domain: str) -> dict:
    """Registration expiry via RDAP. Some TLD registries rate-limit; failures
    are reported as unknown rather than treated as outages."""
    try:
        req = urllib.request.Request(f"https://rdap.org/domain/{domain}", headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.load(resp)
        for event in data.get("events", []):
            if event.get("eventAction") == "expiration":
                expires = datetime.fromisoformat(
                    event["eventDate"].replace("Z", "+00:00")
                )
                days = (expires - datetime.now(timezone.utc)).days
                return {"ok": days > DOMAIN_WARN_DAYS, "days_left": days}
        return {"ok": True, "days_left": None, "note": "no expiration event in RDAP"}
    except Exception as e:
        return {"ok": True, "days_left": None, "error": str(e)[:120]}


def notify(lines: list[str]) -> None:
    topic = os.environ.get("NTFY_TOPIC")
    if not topic or not lines:
        return
    try:
        req = urllib.request.Request(
            f"https://ntfy.sh/{topic}",
            data="\n".join(lines).encode(),
            headers={**UA, "Title": "Ark Web Solutions: site alert", "Priority": "high"},
        )
        urllib.request.urlopen(req, timeout=TIMEOUT)
    except Exception as e:
        print(f"(alert delivery failed: {e})", file=sys.stderr)


def main() -> int:
    if not SITES_FILE.exists():
        sys.exit(f"No {SITES_FILE} found — copy tools/sites.example.json to get started.")
    sites = json.loads(SITES_FILE.read_text())

    results, alerts = [], []
    for site in sites:
        name, url = site["name"], site["url"]
        domain = site.get("domain") or url.split("//", 1)[-1].split("/", 1)[0]
        r = {
            "name": name,
            "http": check_http(url),
            "ssl": check_ssl(domain),
            "domain": check_domain(domain),
        }
        results.append(r)

        if not r["http"]["ok"]:
            alerts.append(f"DOWN: {name} ({url}) — {r['http'].get('error', 'HTTP ' + str(r['http']['status']))}")
        if not r["ssl"]["ok"]:
            d = r["ssl"]["days_left"]
            alerts.append(f"SSL: {name} — {'expires in ' + str(d) + ' days' if d is not None else r['ssl'].get('error', 'check failed')}")
        if not r["domain"]["ok"]:
            alerts.append(f"DOMAIN: {name} — expires in {r['domain']['days_left']} days")

    if "--json" in sys.argv:
        print(json.dumps(results, indent=2))
    else:
        for r in results:
            h, s, d = r["http"], r["ssl"], r["domain"]
            status = "UP  " if h["ok"] else "DOWN"
            ms = f"{h['ms']}ms" if h["ms"] is not None else "—"
            ssl_txt = f"ssl {s['days_left']}d" if s["days_left"] is not None else "ssl ?"
            dom_txt = f"dom {d['days_left']}d" if d["days_left"] is not None else "dom ?"
            print(f"[{status}] {r['name']:<28} {ms:>7}  {ssl_txt:>9}  {dom_txt:>9}")

    notify(alerts)
    if alerts:
        print("\n" + "\n".join(alerts), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
