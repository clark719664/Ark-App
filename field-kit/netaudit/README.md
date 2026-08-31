# netaudit — Network discovery & audit

Walk into a client site, discover every live device on the authorized private
LAN ranges, fingerprint what each one is and which services it exposes, and
produce a clean, printable HTML report the client (and their cyber-insurance
auditor) can read.

**This tool is READ-ONLY.** It makes TCP-connect probes to a curated port list
and reads HTTP banners where a web service answers. It never changes a device.
It is still gated the field-kit way: it prints the authorization banner, makes
you confirm you have permission, and refuses to scan public IP ranges.

## Quickstart

```bash
# 1. See the output right now with a built-in demo (no network, no config):
python3 netaudit.py --self-test
#    -> writes an HTML report to field-kit/reports/

# 2. Copy the config and fill in the client's details:
cp config.example.json mysite.json
#    edit mysite.json: site_name + the private ranges to scan

# 3. Dry run — validates ranges, prints the exact scan plan, sends NO packets:
python3 netaudit.py mysite.json

# 4. Run the real (read-only) scan and generate the report:
python3 netaudit.py mysite.json --apply
#    You will confirm authorization. To log a signed authorization instead:
python3 netaudit.py mysite.json --apply --authorized "Joe's HVAC / signed 2026-01-04"
```

The report lands in `field-kit/reports/netaudit-<site>-<timestamp>.html` and a
full log in `field-kit/logs/`. Open the HTML in any browser and print to PDF for
the client.

## Config fields (`config.example.json`)

| Field | Required | What it is |
|---|---|---|
| `site_name` | yes | Site/building name, shown on the report. |
| `cidrs` | yes | List of **private** ranges to scan, CIDR form, e.g. `["192.168.1.0/24"]`. Public ranges are refused. |
| `client` | no | Legal client name for the report + invoice trail. |
| `technician` | no | Who ran it. Defaults to Ark Web Solutions. |
| `extra_ports` | no | Extra TCP ports to probe on top of the curated list. |
| `timeout` | no | Seconds per TCP probe (default `0.6`). |
| `workers` | no | Concurrent probes (default `120`). |

`--timeout` and `--workers` on the command line override the config.

## What it checks

**Curated ports:** 21 FTP, 22 SSH, 23 Telnet, 25/587 SMTP, 53 DNS, 80/443
HTTP(S), 139 NetBIOS, 161 SNMP, 445 SMB, 631 IPP, 3306 MySQL, 3389 RDP, 5900
VNC, 8080/8443 admin web, 9100 raw print (add more with `extra_ports`).

For each live host it records the open ports, does reverse DNS, grabs the HTTP
`Server` header and page `<title>` on web ports, and infers a likely device
type (router/firewall, printer, NAS, IP camera, Windows host, Linux server).

**Risk highlights** flag what a client cares about: Telnet enabled, VNC exposed,
RDP reachable across the whole LAN, legacy NetBIOS/SMBv1-era networking, SNMP
management, plain-HTTP admin panels, LAN-reachable databases, and unencrypted
services — each with the affected hosts and a plain-English recommendation.

## Notes & limits

- SNMP (161) is normally UDP; TCP-connect detection of it is best-effort.
- Firewalled or sleeping hosts may not answer and won't appear.
- Device types are inferred and marked "likely" where uncertain — verify before
  acting on anything surprising.
- Standard library only. Runs on any laptop / WSL with nothing to install.

## Testing this module

```bash
python3 -c "import py_compile; py_compile.compile('netaudit.py', doraise=True)"
python3 netaudit.py --help
python3 netaudit.py --self-test   # produces a valid HTML report offline
```
