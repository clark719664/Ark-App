# netconfig — VLANs done in an instant

Read **one** network-design JSON, get **ready-to-paste** device configs for
MikroTik RouterOS, Cisco IOS, or a UniFi controller — VLANs, DHCP, guest Wi-Fi,
and the inter-VLAN firewall rules that enforce your isolation intent.

You describe the policy in plain English (`"guest cannot reach management"`,
`"cameras isolated"`). netconfig turns it into real firewall rules **and then
sanity-checks the generated config to prove every isolation statement is
actually enforced** on every platform.

This tool **only generates text**. It never talks to a device, so it is always
safe to run. It still prints the authorization banner (you're handling a
client's network design) and logs every run.

## Quickstart (copy-paste)

```bash
cd field-kit/netconfig

# 1. See it work end-to-end, offline, no prompts (generates all 3 platforms
#    from the bundled example and verifies isolation):
python3 netconfig.py --self-test

# 2. Copy the example, edit it for your client:
cp config.example.json config.local.json
#   ...edit config.local.json (VLANs, subnets, guest Wi-Fi, firewall.intent)...

# 3. Generate your operator-default platform (MikroTik):
python3 netconfig.py config.local.json --platform mikrotik

# 4. Or generate everything at once:
python3 netconfig.py config.local.json --platform all \
        --authorized "Maple St Dental / signed 2026-01-04"
```

Generated configs and a Markdown summary land in `field-kit/reports/`; a
timestamped log lands in `field-kit/logs/`. Both are client deliverables.

> `config.local.json` is git-ignored (`*.local.json`), so client details never
> get committed. No secrets go in the file anyway — Wi-Fi passphrases are set on
> the device at apply time, never stored here.

## Options

| Flag | Meaning |
|---|---|
| `config` (positional) | Your design JSON. Omit it to use `config.example.json`. |
| `--platform mikrotik\|cisco\|unifi\|all` | Which config to generate. Default `mikrotik`. |
| `--authorized "Client / date"` | Record signed authorization (skips the interactive prompt, for logging). |
| `--outdir DIR` | Where to write configs (default `field-kit/reports/`). |
| `--no-print` | Write the files but don't echo full configs to the terminal. |
| `--self-test` | Offline: generate all 3 platforms from the example, assert expected content, exit non-zero on failure. |

There is no `--apply`: netconfig never changes a device. Applying is you
reviewing the output and pasting it in.

## The design file

Copy `config.example.json` — a realistic 4-VLAN small office (management,
staff, cameras, guest) — and edit it. Key sections:

- **`site`, `operator`, `wan`, `lan`** — labels + the WAN interface and the
  LAN bridge/trunk ports (MikroTik).
- **`vlans[]`** — each needs a unique `id` (1–4094), `name`, `subnet` (RFC-1918
  CIDR, no overlaps), `gateway` (inside the subnet), `internet` (true/false),
  and an optional `dhcp` block (`start`/`end` inside the subnet, `dns`, `lease`
  like `1d` / `12h` / `2h`).
- **`guest_wifi`** — `ssid`, the `vlan` id it rides on, `client_isolation`,
  optional bandwidth caps.
- **`firewall.inter_vlan_default`** — `deny` (recommended) or `allow`.
- **`firewall.intent[]`** — plain-English policy (see below).
- **`firewall.extra_rules[]`** — optional structured rules for port-level
  control, e.g. "staff may reach cameras, but only RTSP + the NVR web UI".

Everything is validated on load. A bad VLAN id, an out-of-subnet gateway or
DHCP range, overlapping subnets, or an intent line it can't parse **stops the
run and tells you the exact field** — a non-coder can fix it and re-run.

## Writing firewall intent (plain English)

`inter_vlan_default: "deny"` means nothing crosses VLANs unless you allow it.
Then list the exceptions and isolations in `firewall.intent`. Accepted forms
(case-insensitive; subject must be one of your VLAN names):

```
<vlan> cannot reach <vlan | internet | everything>
<vlan> can reach    <vlan | internet | everything>
<vlan> isolated                     # blocks it from every OTHER VLAN
<vlan> has no internet   /   <vlan> has internet
```

You can list targets: `guest cannot reach staff and management`. Phrasing is
flexible — `can't`, `must not`, `may access`, `is allowed to reach`, `talk to`,
`see`, etc. all work. Later lines win over earlier ones, and a genuine
contradiction is flagged as a conflict in the log.

Example (from `config.example.json`):

```json
"intent": [
  "guest cannot reach management",
  "guest cannot reach staff",
  "guest cannot reach cameras",
  "cameras cannot reach the internet",
  "cameras isolated",
  "staff can reach cameras",
  "management can reach everything"
]
```

## What each platform gets

- **mikrotik** (`.rsc`) — RouterOS script: bridge with VLAN filtering, VLAN
  interfaces, `/ip address`, pools, DHCP servers, NAT (internet VLANs only),
  and a stateful `/ip firewall filter` forward chain implementing the policy,
  plus a **conservative input chain** that won't lock you out mid-paste.
- **cisco** (`.ios.txt`) — IOS: `vlan` defs, SVIs with `ip address`, `ip dhcp`
  pools with exclusions, and one extended ACL per VLAN applied inbound on its
  SVI. Return traffic for allowed flows is handled with `permit tcp …
  established` lines (TCP; a UDP caveat is noted in the file).
- **unifi** (`.json`) — a pure, valid JSON document: `networks`, `wlans`, and
  ordered `firewall_rules` (LAN_IN) you recreate in the controller, with an
  embedded `_summary` and `_how_to_apply`.

## Safety notes

- **Review before you paste**, and keep out-of-band (console / Winbox-MAC)
  access — a firewall paste can drop your management session.
- The tool never weakens security silently. The MikroTik input chain's final
  "drop everything else" is left **commented with a warning** so a paste can't
  lock you out; you uncomment it once you've confirmed management access.
- No Wi-Fi passphrases in the design file — set them on the device at runtime.

## Testing

```bash
python3 -c "import py_compile; py_compile.compile('netconfig.py', doraise=True)"
python3 netconfig.py --help
python3 netconfig.py --self-test        # generates all 3, asserts, verifies isolation
```

`--self-test` exits non-zero if any platform is missing an expected VLAN or an
isolation rule, so it's safe to wire into CI.
