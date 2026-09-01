#!/usr/bin/env python3
"""Ark Field Kit — Network discovery & audit (read-only).

Walk into a client site, discover every live host on the authorized private
LAN ranges, fingerprint what each device is and which services it exposes,
and produce a clean, printable HTML report a client (and a cyber-insurance
auditor) can read.

This tool is READ-ONLY. It never changes a device — it makes TCP-connect
probes to a curated list of common ports and grabs HTTP banners where a web
service answers. It is still gated the field-kit way:

  * Default run is a DRY RUN: it validates your ranges (private only),
    prints the exact scan plan, and writes a log. It touches no packets.
  * Add --apply to actually scan. You confirm authorization first.
  * --self-test renders the HTML report from a built-in fake dataset so you
    can see the output with no network at all.

Standard library only. Runs on any laptop / WSL with nothing to install.
"""

import concurrent.futures
import errno
import html
import re
import socket
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import fieldkit  # noqa: E402  (path set up above)

MODULE = "netaudit"
BRAND = "Ark Web Solutions"
REPORT_TITLE = "Network Audit"
USER_AGENT = "ArkFieldKit-NetAudit/1.0 (authorized network audit)"

# --------------------------------------------------------------------------
# Curated port catalog. `enc` = is the traffic encrypted in typical use.
# `desc` is what a non-technical client reads in the report.
# --------------------------------------------------------------------------
PORT_CATALOG = {
    21:   {"svc": "FTP",       "desc": "File transfer",             "enc": False},
    22:   {"svc": "SSH",       "desc": "Secure shell / SFTP",       "enc": True},
    23:   {"svc": "Telnet",    "desc": "Legacy remote admin",       "enc": False},
    25:   {"svc": "SMTP",      "desc": "Email relay",               "enc": False},
    53:   {"svc": "DNS",       "desc": "Name resolution",           "enc": True},
    80:   {"svc": "HTTP",      "desc": "Web / admin panel",         "enc": False},
    139:  {"svc": "NetBIOS",   "desc": "Legacy Windows networking", "enc": False},
    161:  {"svc": "SNMP",      "desc": "Device management",         "enc": False},
    443:  {"svc": "HTTPS",     "desc": "Secure web / admin panel",  "enc": True},
    445:  {"svc": "SMB",       "desc": "Windows file sharing",      "enc": True},
    587:  {"svc": "SMTP-sub",  "desc": "Email submission",          "enc": True},
    631:  {"svc": "IPP",       "desc": "Network printing",          "enc": False},
    3306: {"svc": "MySQL",     "desc": "Database",                  "enc": False},
    3389: {"svc": "RDP",       "desc": "Windows Remote Desktop",    "enc": True},
    5900: {"svc": "VNC",       "desc": "Remote desktop",            "enc": False},
    8080: {"svc": "HTTP-alt",  "desc": "Admin / proxy web",         "enc": False},
    8443: {"svc": "HTTPS-alt", "desc": "Admin web (TLS)",           "enc": True},
    9100: {"svc": "RAW-print", "desc": "Raw printing (JetDirect)",  "enc": False},
}

DEFAULT_PORTS = sorted(PORT_CATALOG.keys())
WEB_PORTS = (80, 443, 8080, 8443)
# Services that should never carry sensitive data in clear text.
CLEARTEXT_PORTS = {21, 23, 25, 80, 5900, 8080, 9100}

DEFAULT_TIMEOUT = 0.6      # seconds per TCP probe
DEFAULT_WORKERS = 120      # concurrent probes
BIG_SCAN_WARN = 16384      # warn if more than this many hosts are targeted

SEVERITY_RANK = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFO": 3}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "site").lower()).strip("-")
    return slug or "site"


def file_stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def port_label(port: int) -> str:
    meta = PORT_CATALOG.get(port)
    return f"{port}/{meta['svc']}" if meta else str(port)


MAX_HOSTS = 65536  # refuse ranges larger than a /16 so a fat-fingered mask fails loudly


def validate_cidrs(cidrs):
    """Return list of (cidr, host_count); raise ValueError on bad/public/oversized range."""
    import ipaddress
    out = []
    for cidr in cidrs:
        if not isinstance(cidr, str):
            raise ValueError(
                f"cidrs entry must be a string like \"192.168.1.0/24\", got {cidr!r}.")
        net = ipaddress.ip_network(cidr, strict=False)
        if net.version != 4:
            raise ValueError(
                f"{cidr} is not an IPv4 range — this tool scans IPv4 (RFC-1918) only.")
        if not net.is_private:
            raise ValueError(
                f"{cidr} is not a private (RFC-1918) range — refusing to scan.")
        # Count arithmetically (never iterate — a huge mask would hang the dry run).
        count = net.num_addresses - (2 if net.prefixlen < 31 else 0) or net.num_addresses
        if count > MAX_HOSTS:
            raise ValueError(
                f"{cidr} covers {count:,} hosts — larger than the {MAX_HOSTS:,} (a /16) "
                f"cap. Narrow the range (scan one subnet at a time).")
        out.append((cidr, count))
    return out


# --------------------------------------------------------------------------
# Scanning (read-only TCP connect probes)
# --------------------------------------------------------------------------
def probe(ip: str, port: int, timeout: float) -> str:
    """Return 'open', 'refused' (host up, port closed) or 'filtered'."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        rc = s.connect_ex((ip, port))
        if rc == 0:
            return "open"
        if rc == errno.ECONNREFUSED:
            return "refused"
        return "filtered"
    except OSError:
        return "filtered"
    finally:
        try:
            s.close()
        except OSError:
            pass


def scan_network(cidrs, ports, timeout, workers, log):
    """Probe every (host, port) and return live hosts with their open ports."""
    import ipaddress
    targets = []
    for cidr in cidrs:
        for ip in ipaddress.ip_network(cidr, strict=False).hosts():
            targets.append(str(ip))

    results = {ip: {"open": set(), "up": False} for ip in targets}
    probes = [(ip, port) for ip in targets for port in ports]
    log.log(f"  Probing {len(targets)} hosts x {len(ports)} ports "
            f"= {len(probes)} TCP connects (timeout {timeout}s, "
            f"{workers} workers)...")

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        future_map = {ex.submit(probe, ip, port, timeout): (ip, port)
                      for ip, port in probes}
        for fut in concurrent.futures.as_completed(future_map):
            ip, port = future_map[fut]
            state = fut.result()
            if state == "open":
                results[ip]["open"].add(port)
                results[ip]["up"] = True
            elif state == "refused":
                results[ip]["up"] = True
            done += 1
            if done % 1000 == 0:
                log.log(f"    ...{done}/{len(probes)} probes complete")

    live = {ip: r for ip, r in results.items() if r["up"]}
    log.log(f"  {len(live)} host(s) responded "
            f"({sum(1 for r in live.values() if r['open'])} with open ports).")
    return live


def reverse_dns(ip: str, timeout: float):
    old = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout)
    try:
        return socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror, OSError):
        return None
    finally:
        socket.setdefaulttimeout(old)


def grab_http(ip: str, port: int, timeout: float):
    """Read-only GET of '/'. Returns server header, page title, status."""
    scheme = "https" if port in (443, 8443) else "http"
    url = f"{scheme}://{ip}:{port}/"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    ctx = None
    if scheme == "https":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            server = resp.headers.get("Server")
            body = resp.read(8192).decode("utf-8", errors="replace")
            return {"status": getattr(resp, "status", None),
                    "server": server, "title": _extract_title(body),
                    "auth": False, "url": url}
    except urllib.error.HTTPError as e:
        server = e.headers.get("Server") if e.headers else None
        title = None
        try:
            title = _extract_title(e.read(8192).decode("utf-8", errors="replace"))
        except Exception:
            pass
        return {"status": e.code, "server": server, "title": title,
                "auth": e.code in (401, 403), "url": url}
    except Exception as e:  # noqa: BLE001 — read-only probe, report and move on
        return {"error": type(e).__name__, "url": url}


def _extract_title(body: str):
    m = re.search(r"<title[^>]*>(.*?)</title>", body, re.I | re.S)
    if not m:
        return None
    title = re.sub(r"\s+", " ", m.group(1)).strip()
    return title[:120] or None


# --------------------------------------------------------------------------
# Device fingerprinting (best-effort, always labelled "likely")
# --------------------------------------------------------------------------
DEVICE_SIGNATURES = [
    ("Printer", ["printer", "jetdirect", "laserjet", "officejet", "deskjet",
                 "ipp", "cups", "canon", "epson", "brother", "lexmark",
                 "kyocera", "ricoh", "xerox", "pcl", "postscript"]),
    ("IP camera / DVR", ["camera", "ipcam", "webcam", "hikvision", "dahua",
                         "axis", "netcam", "nvr", "dvr", "surveillance",
                         "goahead", "boa/"]),
    ("NAS / storage", ["synology", "diskstation", "qnap", "truenas", "freenas",
                       "readynas", "nas", "openmediavault"]),
    ("Router / firewall / gateway", ["router", "gateway", "openwrt", "dd-wrt",
                                     "pfsense", "opnsense", "mikrotik",
                                     "routeros", "ubiquiti", "unifi", "edgeos",
                                     "tp-link", "tplink", "netgear", "linksys",
                                     "asuswrt", "asus", "draytek", "fortinet",
                                     "fortigate", "sonicwall", "sophos",
                                     "meraki", "zyxel", "d-link", "dlink"]),
    ("Windows host", ["windows", "iis", "microsoft-httpapi", "microsoft-iis"]),
    ("Web server / appliance", ["apache", "nginx", "lighttpd", "tomcat",
                                "jetty", "gunicorn", "werkzeug"]),
]


def guess_device_type(host):
    """Return (label, confidence) where confidence is 'likely' or 'identified'."""
    hay = []
    for info in host.get("http", {}).values():
        if not isinstance(info, dict):
            continue
        for key in ("server", "title"):
            if info.get(key):
                hay.append(str(info[key]).lower())
    if host.get("hostname"):
        hay.append(host["hostname"].lower())
    blob = " ".join(hay)

    for label, keywords in DEVICE_SIGNATURES:
        if any(k in blob for k in keywords):
            return label, "identified"

    ports = set(host.get("open_ports", []))
    # Port-shape fallbacks (lower confidence).
    if ports & {9100, 631}:
        return "Printer", "likely"
    if 3389 in ports and ports & {139, 445}:
        return "Windows PC / server", "likely"
    if 445 in ports or 139 in ports:
        return "Windows / SMB host", "likely"
    if 22 in ports and ports & {80, 443, 3306}:
        return "Linux / Unix server", "likely"
    if ports & {80, 443, 8080, 8443}:
        return "Web-enabled device", "likely"
    if 22 in ports:
        return "Linux / Unix host", "likely"
    if not ports:
        return "Host (no scanned ports open)", "likely"
    return "Unknown device", "likely"


def assemble_hosts(live, timeout, log):
    """Turn raw scan results into full host records (DNS + HTTP + fingerprint)."""
    import ipaddress
    hosts = []
    for ip in sorted(live, key=lambda a: ipaddress.ip_address(a)):
        open_ports = sorted(live[ip]["open"])
        record = {"ip": ip, "hostname": None, "open_ports": open_ports,
                  "http": {}, "device_type": "Unknown device",
                  "confidence": "likely"}
        record["hostname"] = reverse_dns(ip, timeout)
        for port in open_ports:
            if port in WEB_PORTS:
                record["http"][port] = grab_http(ip, port, timeout)
        label, conf = guess_device_type(record)
        record["device_type"] = label
        record["confidence"] = conf
        desc = f"    {ip:<15} {label}"
        if record["hostname"]:
            desc += f"  ({record['hostname']})"
        desc += f"  ports: {', '.join(port_label(p) for p in open_ports) or 'none'}"
        log.log(desc)
        hosts.append(record)
    return hosts


# --------------------------------------------------------------------------
# Risk flags — the "what a client cares about" section
# --------------------------------------------------------------------------
def compute_flags(hosts):
    flags = []

    def hosts_with(port):
        return [h for h in hosts if port in h["open_ports"]]

    def label(h):
        return h["ip"] + (f" ({h['hostname']})" if h.get("hostname") else "")

    telnet = hosts_with(23)
    if telnet:
        flags.append({
            "severity": "HIGH", "title": "Telnet is enabled",
            "detail": ("Telnet carries usernames, passwords and everything "
                       "typed over the wire in clear text. Anyone on the "
                       "network can capture it."),
            "hosts": [label(h) for h in telnet],
            "fix": "Disable Telnet and use SSH (port 22) for remote admin.",
        })

    vnc = hosts_with(5900)
    if vnc:
        flags.append({
            "severity": "HIGH", "title": "VNC remote desktop exposed",
            "detail": ("VNC on the default port is often unencrypted and "
                       "protected only by a short password — a common way in."),
            "hosts": [label(h) for h in vnc],
            "fix": "Tunnel VNC over SSH/VPN, require a strong password, or disable it.",
        })

    rdp = hosts_with(3389)
    if rdp:
        sev = "HIGH" if len(rdp) > 1 else "MEDIUM"
        flags.append({
            "severity": sev, "title": "Remote Desktop (RDP) reachable across the LAN",
            "detail": ("RDP is open to any device on this network. If one "
                       "machine is compromised (or an unmanaged device is "
                       "plugged in), it can reach these directly. RDP is a "
                       "top ransomware entry point."),
            "hosts": [label(h) for h in rdp],
            "fix": ("Restrict RDP to a VPN or jump host, require Network Level "
                    "Authentication, and enable MFA."),
        })

    netbios = hosts_with(139)
    if netbios:
        flags.append({
            "severity": "MEDIUM", "title": "Legacy NetBIOS / SMBv1-era networking",
            "detail": ("Port 139 (NetBIOS session service) indicates legacy "
                       "Windows networking, often tied to the obsolete SMBv1 "
                       "protocol exploited by WannaCry/EternalBlue."),
            "hosts": [label(h) for h in netbios],
            "fix": ("Disable NetBIOS over TCP/IP and confirm SMBv1 is turned "
                    "off (SMBv2/3 only)."),
        })

    snmp = hosts_with(161)
    if snmp:
        flags.append({
            "severity": "MEDIUM", "title": "SNMP management exposed",
            "detail": ("SNMP is often left on with the default community "
                       "string ('public'), leaking device details and "
                       "sometimes allowing configuration changes."),
            "hosts": [label(h) for h in snmp],
            "fix": ("Disable SNMP if unused, or move to SNMPv3 with "
                    "authentication and a non-default community."),
        })

    ftp = hosts_with(21)
    if ftp:
        flags.append({
            "severity": "MEDIUM", "title": "Unencrypted FTP",
            "detail": ("FTP sends credentials and files in clear text."),
            "hosts": [label(h) for h in ftp],
            "fix": "Switch to SFTP (over SSH) or FTPS.",
        })

    mysql = hosts_with(3306)
    if mysql:
        flags.append({
            "severity": "MEDIUM", "title": "Database reachable on the LAN",
            "detail": ("A MySQL/MariaDB service is listening to the whole "
                       "network. Databases should not be broadly reachable."),
            "hosts": [label(h) for h in mysql],
            "fix": ("Bind the database to localhost or a private app subnet "
                    "and firewall port 3306."),
        })

    # Plain-HTTP admin panels (login pages / auth-required over cleartext).
    http_admin = []
    for h in hosts:
        for port in (80, 8080):
            info = h["http"].get(port)
            if not isinstance(info, dict):
                continue
            title = (info.get("title") or "").lower()
            hint = (info.get("auth") or "login" in title or "sign in" in title
                    or "router" in title or "admin" in title
                    or h["device_type"].startswith(("Router", "IP camera",
                                                     "Printer", "NAS")))
            if hint:
                http_admin.append(f"{label(h)} :{port}")
    if http_admin:
        flags.append({
            "severity": "MEDIUM", "title": "Admin panel served over plain HTTP",
            "detail": ("A device management / login page is reachable over "
                       "unencrypted HTTP. Admin credentials can be sniffed, "
                       "and default logins are a frequent finding on this gear."),
            "hosts": http_admin,
            "fix": ("Enable HTTPS on the device, change any default admin "
                    "password, and restrict the panel to admin machines."),
        })

    # Generic "unencrypted service" round-up (anything cleartext not already flagged).
    unenc = []
    for h in hosts:
        cleartext = sorted(set(h["open_ports"]) & CLEARTEXT_PORTS)
        if cleartext:
            unenc.append(f"{label(h)}: "
                         + ", ".join(port_label(p) for p in cleartext))
    if unenc:
        flags.append({
            "severity": "LOW", "title": "Unencrypted services present",
            "detail": ("These services move data without encryption. On a "
                       "trusted internal network this may be acceptable, but "
                       "they are worth reviewing."),
            "hosts": unenc,
            "fix": ("Prefer encrypted equivalents (HTTPS, SSH/SFTP, SMTP over "
                    "TLS) where the device supports them."),
        })

    flags.sort(key=lambda f: SEVERITY_RANK.get(f["severity"], 9))
    return flags


# --------------------------------------------------------------------------
# HTML report
# --------------------------------------------------------------------------
def e(text):
    return html.escape(str(text), quote=True)


SEVERITY_COLORS = {
    "HIGH":   ("#7f1d1d", "#fee2e2", "#dc2626"),
    "MEDIUM": ("#7c2d12", "#ffedd5", "#ea580c"),
    "LOW":    ("#1e3a5f", "#dbeafe", "#2563eb"),
    "INFO":   ("#334155", "#e2e8f0", "#64748b"),
}


def port_chip(port):
    meta = PORT_CATALOG.get(port)
    if not meta:
        cls = "chip chip-neutral"
        return f'<span class="{cls}" title="port {e(port)}">{e(port)}</span>'
    if not meta["enc"]:
        cls = "chip chip-unenc"
    elif meta["svc"] in ("RDP", "SMB", "NetBIOS"):
        cls = "chip chip-warn"
    else:
        cls = "chip chip-ok"
    tip = f"{meta['svc']} — {meta['desc']}"
    return f'<span class="{cls}" title="{e(tip)}">{e(port)}/{e(meta["svc"])}</span>'


def build_html(ctx, hosts, flags):
    sev_counts = {s: 0 for s in SEVERITY_RANK}
    for f in flags:
        sev_counts[f["severity"]] = sev_counts.get(f["severity"], 0) + 1
    total_open = sum(len(h["open_ports"]) for h in hosts)

    parts = []
    parts.append(f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(BRAND)} — {e(REPORT_TITLE)} — {e(ctx['site_name'])}</title>
<style>
  :root {{
    --ink:#0f172a; --muted:#475569; --line:#e2e8f0; --bg:#f1f5f9;
    --brand:#0b3d5c; --brand2:#1178a7; --card:#ffffff;
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }}
  .wrap {{ max-width:1040px; margin:0 auto; padding:24px; }}
  header.brand {{ background:linear-gradient(105deg,var(--brand),var(--brand2));
    color:#fff; border-radius:12px; padding:26px 28px; }}
  header.brand h1 {{ margin:0; font-size:22px; letter-spacing:.3px; }}
  header.brand .sub {{ opacity:.9; font-size:13px; margin-top:2px; }}
  header.brand .site {{ margin-top:14px; font-size:19px; font-weight:600; }}
  .meta {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
    gap:8px 24px; margin-top:14px; font-size:12.5px; }}
  .meta div span {{ display:block; opacity:.75; text-transform:uppercase;
    letter-spacing:.6px; font-size:10.5px; }}
  .cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
    gap:14px; margin:22px 0; }}
  .card {{ background:var(--card); border:1px solid var(--line);
    border-radius:10px; padding:16px 18px; }}
  .card .n {{ font-size:26px; font-weight:700; }}
  .card .l {{ color:var(--muted); font-size:12px; text-transform:uppercase;
    letter-spacing:.5px; }}
  h2 {{ font-size:16px; margin:30px 0 10px; padding-bottom:6px;
    border-bottom:2px solid var(--line); }}
  .flag {{ background:var(--card); border:1px solid var(--line);
    border-left:5px solid var(--muted); border-radius:8px; padding:14px 16px;
    margin:10px 0; }}
  .flag .row {{ display:flex; align-items:center; gap:10px; }}
  .badge {{ font-size:11px; font-weight:700; padding:2px 9px; border-radius:20px;
    letter-spacing:.5px; }}
  .flag h3 {{ margin:0; font-size:14.5px; }}
  .flag p {{ margin:8px 0 6px; color:var(--muted); }}
  .flag .fix {{ font-size:13px; }}
  .flag .fix b {{ color:var(--brand); }}
  .flag .hosts {{ font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:12px; color:var(--ink); margin-top:6px; }}
  table {{ width:100%; border-collapse:collapse; background:var(--card);
    border:1px solid var(--line); border-radius:8px; overflow:hidden; }}
  .tablewrap {{ overflow-x:auto; }}
  th,td {{ text-align:left; padding:9px 12px; border-bottom:1px solid var(--line);
    vertical-align:top; font-size:13px; }}
  th {{ background:#eef2f7; font-size:11px; text-transform:uppercase;
    letter-spacing:.5px; color:var(--muted); }}
  tr:last-child td {{ border-bottom:none; }}
  .mono {{ font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12.5px; }}
  .chip {{ display:inline-block; font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:11px; padding:1px 7px; border-radius:5px; margin:2px 3px 2px 0;
    border:1px solid transparent; white-space:nowrap; }}
  .chip-ok {{ background:#dcfce7; color:#14532d; border-color:#bbf7d0; }}
  .chip-warn {{ background:#fef3c7; color:#78350f; border-color:#fde68a; }}
  .chip-unenc {{ background:#fee2e2; color:#7f1d1d; border-color:#fecaca; }}
  .chip-neutral {{ background:#e2e8f0; color:#334155; border-color:#cbd5e1; }}
  .hostcard {{ background:var(--card); border:1px solid var(--line);
    border-radius:8px; padding:14px 16px; margin:10px 0; }}
  .hostcard .head {{ display:flex; justify-content:space-between;
    flex-wrap:wrap; gap:6px; align-items:baseline; }}
  .hostcard .ip {{ font-weight:700; font-family:ui-monospace,Menlo,Consolas,monospace; }}
  .hostcard .type {{ color:var(--brand2); font-weight:600; }}
  .hostcard .dns {{ color:var(--muted); font-size:12px; }}
  .svc {{ margin:8px 0 0; }}
  .svc li {{ margin:2px 0; font-size:13px; }}
  .httpline {{ font-size:12px; color:var(--muted); margin-top:6px;
    border-top:1px dashed var(--line); padding-top:6px; }}
  .legend span {{ margin-right:14px; font-size:12px; }}
  footer {{ margin-top:34px; padding-top:14px; border-top:1px solid var(--line);
    color:var(--muted); font-size:11.5px; }}
  .note {{ background:#fff7ed; border:1px solid #fed7aa; color:#7c2d12;
    border-radius:8px; padding:10px 14px; font-size:12.5px; margin:14px 0; }}
  a {{ color:var(--brand2); }}
  @media print {{
    body {{ background:#fff; }}
    .wrap {{ max-width:none; padding:0; }}
    .card,.flag,.hostcard,table {{ break-inside:avoid; }}
    header.brand {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  }}
</style>
</head>
<body>
<div class="wrap">
<header class="brand">
  <h1>{e(BRAND)}</h1>
  <div class="sub">{e(REPORT_TITLE)} &middot; read-only network discovery</div>
  <div class="site">{e(ctx['site_name'])}</div>
  <div class="meta">
    <div><span>Client</span>{e(ctx['client'])}</div>
    <div><span>Technician</span>{e(ctx['technician'])}</div>
    <div><span>Scan date</span>{e(ctx['scan_time'])}</div>
    <div><span>Ranges</span><span class="mono" style="opacity:1;text-transform:none;font-size:12px">{e(', '.join(ctx['ranges']))}</span></div>
    <div><span>Authorization</span>{e(ctx['authorization'])}</div>
    <div><span>Method</span>{e(ctx['mode'])}</div>
  </div>
</header>
""")

    parts.append('<div class="cards">')
    parts.append(f'<div class="card"><div class="n">{len(hosts)}</div>'
                 f'<div class="l">Hosts discovered</div></div>')
    parts.append(f'<div class="card"><div class="n">{total_open}</div>'
                 f'<div class="l">Open services</div></div>')
    parts.append(f'<div class="card"><div class="n">{sev_counts.get("HIGH",0)}</div>'
                 f'<div class="l">High-risk flags</div></div>')
    parts.append(f'<div class="card"><div class="n">'
                 f'{sev_counts.get("MEDIUM",0)}</div>'
                 f'<div class="l">Medium flags</div></div>')
    parts.append('</div>')

    # Flags section
    parts.append('<h2>Risk highlights</h2>')
    if not flags:
        parts.append('<p>No notable risk flags were raised by the curated '
                     'checks. That is a good sign — see the inventory below '
                     'for the full picture.</p>')
    for f in flags:
        fg, bg, bar = SEVERITY_COLORS.get(f["severity"], SEVERITY_COLORS["INFO"])
        hosts_html = "<br>".join(e(h) for h in f["hosts"])
        parts.append(f"""<div class="flag" style="border-left-color:{bar}">
  <div class="row">
    <span class="badge" style="background:{bg};color:{fg}">{e(f['severity'])}</span>
    <h3>{e(f['title'])}</h3>
  </div>
  <p>{e(f['detail'])}</p>
  <div class="fix"><b>Recommendation:</b> {e(f['fix'])}</div>
  <div class="hosts">{hosts_html}</div>
</div>""")

    # Inventory table
    parts.append('<h2>Device inventory</h2>')
    parts.append('<div class="tablewrap"><table>')
    parts.append('<tr><th>IP address</th><th>Hostname</th>'
                 '<th>Likely device</th><th>Open services</th></tr>')
    for h in hosts:
        chips = " ".join(port_chip(p) for p in h["open_ports"]) or \
            '<span class="chip chip-neutral">none open</span>'
        conf = "" if h["confidence"] == "identified" else \
            ' <span style="color:#94a3b8">(likely)</span>'
        parts.append(f"""<tr>
  <td class="mono">{e(h['ip'])}</td>
  <td>{e(h['hostname'] or '—')}</td>
  <td>{e(h['device_type'])}{conf}</td>
  <td>{chips}</td>
</tr>""")
    parts.append('</table></div>')

    # Per-host detail
    parts.append('<h2>Per-host detail</h2>')
    for h in hosts:
        dns = f'<span class="dns">{e(h["hostname"])}</span>' if h["hostname"] else ''
        parts.append(f"""<div class="hostcard">
  <div class="head">
    <span class="ip">{e(h['ip'])}</span>
    <span class="type">{e(h['device_type'])}</span>
  </div>
  {dns}
  <ul class="svc">""")
        if h["open_ports"]:
            for p in h["open_ports"]:
                meta = PORT_CATALOG.get(p, {"svc": str(p), "desc": "", "enc": True})
                enc = "" if meta["enc"] else \
                    ' <span style="color:#b91c1c">(unencrypted)</span>'
                parts.append(f'<li>{e(p)} — <b>{e(meta["svc"])}</b> '
                             f'{e(meta["desc"])}{enc}</li>')
        else:
            parts.append('<li>Host responded but no scanned ports were open.</li>')
        parts.append('</ul>')
        # HTTP banners
        for port in sorted(h["http"]):
            info = h["http"][port]
            if not isinstance(info, dict) or "error" in info:
                continue
            bits = []
            if info.get("server"):
                bits.append(f"Server: {e(info['server'])}")
            if info.get("title"):
                bits.append(f"Title: &ldquo;{e(info['title'])}&rdquo;")
            if info.get("status"):
                bits.append(f"HTTP {e(info['status'])}")
            if info.get("auth"):
                bits.append("login required")
            if bits:
                parts.append(f'<div class="httpline">:{e(port)} &rarr; '
                             + " &middot; ".join(bits) + '</div>')
        parts.append('</div>')

    # Legend + footer
    parts.append('<h2>How to read this</h2>')
    parts.append('<div class="legend">'
                 '<span><span class="chip chip-ok">443/HTTPS</span> encrypted</span>'
                 '<span><span class="chip chip-warn">3389/RDP</span> sensitive admin</span>'
                 '<span><span class="chip chip-unenc">23/Telnet</span> unencrypted</span>'
                 '<span><span class="chip chip-neutral">?</span> other</span>'
                 '</div>')
    parts.append(f"""<div class="note">
  This was a <b>read-only</b> point-in-time scan: TCP-connect probes to a
  curated port list plus HTTP banner reads. Nothing on any device was
  changed. SNMP (161) is normally UDP, so its detection here is best-effort.
  Firewalled or sleeping hosts may not appear. Device types are inferred
  from banners and open ports and marked &ldquo;likely&rdquo; where uncertain.
</div>""")
    parts.append(f"""<footer>
  Generated by the Ark Field Kit <b>netaudit</b> module for
  {e(ctx['client'])} at {e(ctx['scan_time'])}.<br>
  Authorized work only. Keep this report with the signed authorization on file.
  &copy; {datetime.now().year} {e(BRAND)}.
</footer>""")
    parts.append('</div></body></html>')
    return "\n".join(parts)


def write_report(ctx, hosts, flags, slug, log):
    fieldkit.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = fieldkit.REPORT_DIR / f"{MODULE}-{slug}-{file_stamp()}.html"
    out.write_text(build_html(ctx, hosts, flags), encoding="utf-8")
    log.log(f"  Report written: {out}")
    return out


# --------------------------------------------------------------------------
# Self-test dataset (offline, exercises the whole render path)
# --------------------------------------------------------------------------
def self_test_hosts():
    raw = [
        {"ip": "192.168.1.1", "hostname": "gateway.lan",
         "open_ports": [23, 53, 80, 443],
         "http": {80: {"server": "lighttpd/1.4", "title": "TP-Link Router Login",
                       "status": 200, "auth": True},
                  443: {"server": "lighttpd/1.4", "title": "TP-Link Router",
                        "status": 200, "auth": True}}},
        {"ip": "192.168.1.10", "hostname": "reception-pc.lan",
         "open_ports": [139, 445, 3389],
         "http": {}},
        {"ip": "192.168.1.11", "hostname": "acct-pc.lan",
         "open_ports": [139, 445, 3389, 5900], "http": {}},
        {"ip": "192.168.1.20", "hostname": "hp-printer.lan",
         "open_ports": [80, 161, 631, 9100],
         "http": {80: {"server": "HP HTTP Server", "title": "HP LaserJet MFP",
                       "status": 200, "auth": False}}},
        {"ip": "192.168.1.30", "hostname": "nas.lan",
         "open_ports": [22, 80, 443, 445, 8080],
         "http": {80: {"server": "nginx", "title": "Synology DiskStation",
                       "status": 200, "auth": True},
                  8080: {"server": "nginx", "title": "DSM Login",
                         "status": 200, "auth": True}}},
        {"ip": "192.168.1.40", "hostname": None,
         "open_ports": [80], "http": {80: {"server": "GoAhead-Webs",
                                           "title": "IP Camera", "status": 200}}},
        {"ip": "192.168.1.50", "hostname": "web01.lan",
         "open_ports": [22, 80, 443, 3306],
         "http": {80: {"server": "Apache/2.4.41", "title": "Intranet",
                       "status": 200},
                  443: {"server": "Apache/2.4.41", "title": "Intranet",
                        "status": 200}}},
        {"ip": "192.168.1.60", "hostname": "old-server.lan",
         "open_ports": [21, 23, 25, 139, 445], "http": {}},
    ]
    for h in raw:
        h.setdefault("http", {})
        label, conf = guess_device_type(h)
        h["device_type"] = label
        h["confidence"] = conf
    return raw


def run_self_test(args):
    slug = "selftest"
    log = fieldkit.Logger(MODULE, slug)
    log.log("SELF-TEST: rendering HTML report from a built-in fake dataset "
            "(no network activity).")
    hosts = self_test_hosts()
    flags = compute_flags(hosts)
    ctx = {
        "site_name": "Demo Site (self-test)",
        "client": "Example Client LLC",
        "technician": "Ark Web Solutions",
        "scan_time": fieldkit.timestamp(),
        "ranges": ["192.168.1.0/24"],
        "authorization": "SELF-TEST — no real system was scanned",
        "mode": "Read-only TCP scan (simulated)",
    }
    out = write_report(ctx, hosts, flags, slug, log)
    log.log(f"SELF-TEST complete: {len(hosts)} hosts, {len(flags)} flags.")
    log.close()
    print(f"\nSelf-test report: {out}")
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def build_parser():
    parser = fieldkit.base_parser(
        "Ark Field Kit — read-only LAN discovery & audit -> HTML report.")
    # Make the config optional so --self-test can run standalone.
    for action in parser._actions:
        if action.dest == "config":
            action.nargs = "?"
            action.default = None
            action.help = "path to your filled-in config JSON (see config.example.json)"
    parser.add_argument("--self-test", action="store_true",
                        help="render a demo report from a built-in fake dataset "
                             "(no config, no network) and exit")
    parser.add_argument("--timeout", type=float, default=None,
                        help=f"per-probe TCP timeout in seconds "
                             f"(default {DEFAULT_TIMEOUT}, or config)")
    parser.add_argument("--workers", type=int, default=None,
                        help=f"concurrent probes (default {DEFAULT_WORKERS}, or config)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.self_test:
        run_self_test(args)
        return 0

    if not args.config:
        sys.exit("No config given. Provide a config JSON, or use --self-test.\n"
                 "Copy config.example.json, fill it in, and pass its path.")

    config = fieldkit.load_config(args.config, required=["site_name", "cidrs"])
    site_name = config["site_name"]
    cidrs = config["cidrs"]
    if not isinstance(cidrs, list) or not cidrs:
        sys.exit("Config field 'cidrs' must be a non-empty list, "
                 'e.g. ["192.168.1.0/24"].')

    ports = list(DEFAULT_PORTS)
    extra = config.get("extra_ports") or []
    if not isinstance(extra, list):
        sys.exit("Config field 'extra_ports' must be a list of port numbers.")
    for p in extra:
        try:
            pv = int(p)
        except (TypeError, ValueError):
            sys.exit(f"extra_ports contains a non-numeric value: {p!r}")
        if not (0 < pv < 65536):
            sys.exit(f"extra_ports value out of range: {pv}")
        if pv not in ports:
            ports.append(pv)
    ports.sort()

    timeout = args.timeout if args.timeout is not None else \
        float(config.get("timeout", DEFAULT_TIMEOUT))
    workers = args.workers if args.workers is not None else \
        int(config.get("workers", DEFAULT_WORKERS))

    slug = slugify(site_name)
    log = fieldkit.Logger(MODULE, slug)
    log.log(f"Mode: {fieldkit.mode_label(args.apply)}  (netaudit is read-only)")
    log.log(f"Site: {site_name}")

    # Validate ranges are private BEFORE anything else (dry run and apply).
    try:
        ranges = validate_cidrs(cidrs)
    except ValueError as ex:
        log.log(f"ERROR: {ex}")
        log.close()
        sys.exit(str(ex))

    total_hosts = sum(c for _, c in ranges)
    log.log("Scan plan:")
    for cidr, count in ranges:
        log.log(f"  - {cidr}  ({count} hosts)")
    log.log(f"  Ports ({len(ports)}): "
            + ", ".join(port_label(p) for p in ports))
    log.log(f"  Estimated probes: {total_hosts * len(ports)} "
            f"(timeout {timeout}s, {workers} workers)")

    if total_hosts > BIG_SCAN_WARN:
        log.log(f"  NOTE: large scope ({total_hosts} hosts) — this may take a "
                f"while. Narrow 'cidrs' if that is not intended.")

    if not args.apply:
        log.log("")
        log.log("DRY RUN — no packets sent. Review the plan above.")
        log.log("Re-run with --apply to perform the scan "
                "(you will confirm authorization first).")
        log.log("Tip: --self-test renders a sample report with no network.")
        log.close()
        print("\nDry run complete. Add --apply to scan for real.")
        return 0

    # --apply: confirm authorization, then scan.
    fieldkit.confirm_authorization(args, site_name, log)

    ctx = {
        "site_name": site_name,
        "client": config.get("client", site_name),
        "technician": config.get("technician", BRAND),
        "scan_time": fieldkit.timestamp(),
        "ranges": [c for c, _ in ranges],
        "authorization": getattr(args, "authorized", None)
        or "Confirmed interactively by operator",
        "mode": "Read-only TCP-connect scan + HTTP banner read",
    }

    log.log("")
    log.log("Scanning (read-only)...")
    live = scan_network([c for c, _ in ranges], ports, timeout, workers, log)
    hosts = assemble_hosts(live, timeout, log)
    flags = compute_flags(hosts)
    log.log(f"Flags raised: {len(flags)}")
    out = write_report(ctx, hosts, flags, slug, log)
    log.close()
    print(f"\nAudit complete. Report: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
