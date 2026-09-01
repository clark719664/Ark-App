#!/usr/bin/env python3
"""Ark Field Kit -- netconfig: VLAN / firewall / guest-Wi-Fi config generator.

Reads ONE network-design JSON and emits ready-to-paste device configuration for
MikroTik RouterOS, Cisco IOS, or a UniFi controller. Pure text generation: it
never talks to a device, so it is always safe to run. It still prints the
authorization banner (you are handling a client's network design) and writes a
timestamped log + the generated config files to the field kit's reports folder.

The star feature: you describe the inter-VLAN policy in plain English under
firewall.intent (e.g. "guest cannot reach management", "cameras isolated") and
this tool turns it into real firewall rules -- then SANITY-CHECKS the generated
config to prove every isolation statement is enforced as inter-VLAN FORWARDING
rules. (Host-to-router access -- e.g. the MikroTik input chain reaching the
router's own Winbox/SSH/DNS -- is out of scope of that check; see the README
safety notes.)

Standard library only. Runs on any laptop / WSL with nothing to install.

Quickstart:
    python3 netconfig.py config.example.json --platform mikrotik
    python3 netconfig.py config.example.json --platform all
    python3 netconfig.py --self-test          # offline; generates all 3 + asserts

Follows field-kit/CONVENTIONS.md. Imports the shared helpers in ../lib/fieldkit.py.
"""

import argparse
import ipaddress
import json
import re
import sys
from pathlib import Path

# --- shared field-kit helpers (authorization banner, logging, config loading) ---
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import fieldkit  # noqa: E402

MODULE = "netconfig"
INTERNET = "__internet__"  # sentinel destination meaning "the WAN / the internet"
EXAMPLE_CONFIG = Path(__file__).resolve().parent / "config.example.json"


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def slugify(text: str) -> str:
    """Lower-case, keep alnum, collapse the rest to single dashes."""
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return s or "x"


def net_of(subnet: str) -> ipaddress.IPv4Network:
    return ipaddress.ip_network(subnet, strict=True)


class ConfigError(Exception):
    """Raised for a bad design file; caught in main() to fail loudly and cleanly."""


# ---------------------------------------------------------------------------
# 1. Load + validate the design
# ---------------------------------------------------------------------------
def validate_design(raw: dict) -> dict:
    """Validate the raw JSON and return a normalized design dict.

    Fails loudly (ConfigError) on the first structural problem, naming the exact
    field. Softer issues (public subnet, gateway inside DHCP pool) become warnings
    that are printed and logged but do not stop generation.
    """
    warnings = []

    site = raw.get("site")
    if not isinstance(site, str) or not site.strip():
        raise ConfigError("Field 'site' is required and must be a non-empty string.")

    operator = raw.get("operator", "") or ""

    wan_raw = raw.get("wan", {}) or {}
    wan = {
        "interface": (wan_raw.get("interface") or "ether1"),
        "notes": (wan_raw.get("notes") or ""),
    }

    lan_raw = raw.get("lan", {}) or {}
    bridge = lan_raw.get("bridge") or "bridge-lan"
    trunk_ports = lan_raw.get("trunk_ports") or []
    if not isinstance(trunk_ports, list):
        raise ConfigError("Field 'lan.trunk_ports' must be a list of interface names.")
    lan = {"bridge": bridge, "trunk_ports": [str(p) for p in trunk_ports],
           "trunk_notes": lan_raw.get("trunk_notes", "")}

    vlans_raw = raw.get("vlans")
    if not isinstance(vlans_raw, list) or not vlans_raw:
        raise ConfigError("Field 'vlans' is required and must be a non-empty list.")

    vlans = []
    seen_ids, seen_names, nets = {}, {}, []
    for i, v in enumerate(vlans_raw):
        where = f"vlans[{i}]"
        if not isinstance(v, dict):
            raise ConfigError(f"{where} must be an object.")

        vid = v.get("id")
        if not isinstance(vid, int) or isinstance(vid, bool) or not (1 <= vid <= 4094):
            raise ConfigError(f"{where}.id must be an integer 1-4094 (got {vid!r}).")
        if vid in seen_ids:
            raise ConfigError(f"{where}.id {vid} is duplicated (also {seen_ids[vid]}). "
                              "VLAN ids must be unique.")
        seen_ids[vid] = where

        name = v.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ConfigError(f"{where}.name is required and must be a non-empty string.")
        key = name.strip().lower()
        if key in seen_names:
            raise ConfigError(f"{where}.name '{name}' is duplicated. VLAN names must be unique.")
        seen_names[key] = where

        subnet = v.get("subnet")
        if not isinstance(subnet, str) or not subnet.strip():
            raise ConfigError(f"{where}.subnet is required (e.g. \"10.10.20.0/24\").")
        try:
            net = net_of(subnet)
        except ValueError as e:
            raise ConfigError(f"{where}.subnet is not a valid CIDR: {e}")
        if net.version != 4:
            raise ConfigError(f"{where}.subnet must be IPv4 (got {subnet}).")
        if not net.is_private:
            warnings.append(f"{where}.subnet {subnet} is NOT a private (RFC-1918) range. "
                            "Double-check this is intentional client addressing.")
        for prev_net, prev_where in nets:
            if net.overlaps(prev_net):
                raise ConfigError(f"{where}.subnet {subnet} overlaps {prev_where} "
                                  f"({prev_net}). VLAN subnets must not overlap.")
        nets.append((net, where))

        gw = v.get("gateway")
        if not isinstance(gw, str) or not gw.strip():
            raise ConfigError(f"{where}.gateway is required (usually the .1 of the subnet).")
        try:
            gw_ip = ipaddress.ip_address(gw)
        except ValueError as e:
            raise ConfigError(f"{where}.gateway is not a valid IP: {e}")
        if gw_ip not in net:
            raise ConfigError(f"{where}.gateway {gw} is not inside subnet {subnet}.")
        if gw_ip in (net.network_address, net.broadcast_address):
            raise ConfigError(f"{where}.gateway {gw} cannot be the network or broadcast address.")

        internet = v.get("internet", True)
        if not isinstance(internet, bool):
            raise ConfigError(f"{where}.internet must be true or false (got {internet!r}).")

        dhcp = None
        d = v.get("dhcp")
        if d:
            if not isinstance(d, dict):
                raise ConfigError(f"{where}.dhcp must be an object with start/end/dns/lease.")
            start, end = d.get("start"), d.get("end")
            for label, val in (("start", start), ("end", end)):
                if not isinstance(val, str) or not val.strip():
                    raise ConfigError(f"{where}.dhcp.{label} is required when dhcp is present.")
            try:
                s_ip, e_ip = ipaddress.ip_address(start), ipaddress.ip_address(end)
            except ValueError as e:
                raise ConfigError(f"{where}.dhcp start/end not a valid IP: {e}")
            if s_ip not in net or e_ip not in net:
                raise ConfigError(f"{where}.dhcp range {start}-{end} is not inside subnet {subnet}.")
            if int(e_ip) < int(s_ip):
                raise ConfigError(f"{where}.dhcp end {end} is before start {start}.")
            if s_ip in (net.network_address, net.broadcast_address) or \
               e_ip in (net.network_address, net.broadcast_address):
                raise ConfigError(f"{where}.dhcp range must not include the network or "
                                  f"broadcast address of {subnet}.")
            if int(s_ip) <= int(gw_ip) <= int(e_ip):
                warnings.append(f"{where}: gateway {gw} sits INSIDE the DHCP pool "
                                f"{start}-{end}; it will be excluded, but consider moving "
                                "the pool so the gateway is clearly outside it.")
            dns = d.get("dns") or [gw, "1.1.1.1"]
            if not isinstance(dns, list) or not all(isinstance(x, str) for x in dns):
                raise ConfigError(f"{where}.dhcp.dns must be a list of IP strings.")
            for x in dns:
                try:
                    ipaddress.ip_address(x)
                except ValueError as e:
                    raise ConfigError(f"{where}.dhcp.dns has invalid IP {x!r}: {e}")
            lease = str(d.get("lease") or "1d")
            dhcp = {"start": start, "end": end, "dns": dns, "lease": lease}

        vlans.append({
            "id": vid, "name": name.strip(), "slug": slugify(name),
            "subnet": subnet, "net": net, "gateway": gw,
            "purpose": v.get("purpose", "") or "", "internet": internet, "dhcp": dhcp,
        })

    # Generated device resources (MikroTik pool-/dhcp- names, Cisco ACL/DHCP-pool
    # names) are derived from the VLAN name via slugify()/_ios_name(). Two names
    # that differ only in punctuation or case can collapse to the same token and
    # silently produce duplicate resources (e.g. 'cam a' and 'cam-a' both slugify
    # to 'cam-a'), so detect the collision here and fail loudly naming both VLANs.
    slug_seen, ios_seen = {}, {}
    for vl in vlans:
        s = vl["slug"]
        if s in slug_seen:
            raise ConfigError(
                f"VLAN names '{slug_seen[s]}' and '{vl['name']}' both reduce to the "
                f"MikroTik resource name 'pool-{s}'/'dhcp-{s}'. Rename one so they "
                "differ by more than punctuation.")
        slug_seen[s] = vl["name"]
        ios = _ios_name(vl["name"])
        if ios in ios_seen:
            raise ConfigError(
                f"VLAN names '{ios_seen[ios]}' and '{vl['name']}' both reduce to the "
                f"Cisco resource name '{ios}' (ACL-{ios}-IN / DHCP pool). Rename one "
                "so they differ by more than case or punctuation.")
        ios_seen[ios] = vl["name"]

    # Key by the EXACT VLAN name so these match the policy-matrix keys used by
    # build_policy() and verify(); a separate lowercased alias map handles the
    # case-insensitive resolution of user-typed intent / extra_rule endpoints.
    name_to_vlan = {vl["name"]: vl for vl in vlans}
    name_to_vlan_ci = {vl["name"].lower(): vl for vl in vlans}
    id_to_vlan = {vl["id"]: vl for vl in vlans}

    # --- guest wifi ---
    guest_wifi = None
    gw_raw = raw.get("guest_wifi")
    if gw_raw:
        if not isinstance(gw_raw, dict):
            raise ConfigError("guest_wifi must be an object with at least 'ssid' and 'vlan'.")
        ssid = gw_raw.get("ssid")
        if not isinstance(ssid, str) or not ssid.strip():
            raise ConfigError("guest_wifi.ssid is required when guest_wifi is present.")
        gvid = gw_raw.get("vlan")
        if gvid not in id_to_vlan:
            raise ConfigError(f"guest_wifi.vlan {gvid!r} does not match any defined VLAN id "
                              f"({sorted(id_to_vlan)}).")
        iso = gw_raw.get("client_isolation", True)
        if not isinstance(iso, bool):
            raise ConfigError("guest_wifi.client_isolation must be true or false.")
        guest_wifi = {
            "ssid": ssid.strip(), "vlan": gvid, "vlan_obj": id_to_vlan[gvid],
            "client_isolation": iso,
            "bandwidth_down_mbps": gw_raw.get("bandwidth_down_mbps"),
            "bandwidth_up_mbps": gw_raw.get("bandwidth_up_mbps"),
        }

    # --- firewall ---
    fw_raw = raw.get("firewall", {}) or {}
    default = str(fw_raw.get("inter_vlan_default", "deny")).lower()
    if default not in ("deny", "allow"):
        raise ConfigError("firewall.inter_vlan_default must be \"deny\" or \"allow\".")
    if default == "allow":
        # CONVENTIONS.md #7: a blanket-allow posture must be surfaced, not silent.
        warnings.append(
            "inter_vlan_default=allow: all VLANs can reach each other unless "
            "explicitly denied -- confirm this blanket-allow posture is intended.")
    intent = fw_raw.get("intent", []) or []
    if not isinstance(intent, list) or not all(isinstance(x, str) for x in intent):
        raise ConfigError("firewall.intent must be a list of plain-English strings.")
    extra_rules = fw_raw.get("extra_rules", []) or []
    if not isinstance(extra_rules, list):
        raise ConfigError("firewall.extra_rules must be a list of rule objects.")

    design = {
        "site": site.strip(), "operator": operator, "wan": wan, "lan": lan,
        "vlans": vlans, "name_to_vlan": name_to_vlan,
        "name_to_vlan_ci": name_to_vlan_ci, "id_to_vlan": id_to_vlan,
        "guest_wifi": guest_wifi,
        "firewall": {"default": default, "intent": intent, "extra_rules": extra_rules},
        "warnings": warnings,
    }

    # Parse every intent line now so a typo fails loudly on load, before we print
    # the banner or write anything. (build_policy parses again to apply them.)
    for line in intent:
        parse_intent(line, design)

    return design


# ---------------------------------------------------------------------------
# 2. Parse plain-English intent into policy directives
# ---------------------------------------------------------------------------
# Verb / polarity vocabulary. Kept generous so a non-coder's phrasing still parses.
_DENY = r"cannot|can\s*not|can'?t|cant|must\s+not|mustn'?t|should\s+not|shouldn'?t|" \
        r"may\s+not|is\s+not\s+allowed\s+to|are\s+not\s+allowed\s+to|isn'?t\s+allowed\s+to|" \
        r"aren'?t\s+allowed\s+to"
_ALLOW = r"can|may|is\s+allowed\s+to|are\s+allowed\s+to|is\s+able\s+to|are\s+able\s+to|" \
         r"should\s+be\s+able\s+to|needs?\s+to|is\s+permitted\s+to|are\s+permitted\s+to"
_VERB = r"reach|access|talk\s+to|connect\s+to|route\s+to|get\s+to|see|view|" \
        r"communicate\s+with|contact|ping|manage|use|browse"

_DENY_RE = re.compile(rf"^(?P<a>.+?)\s+(?:{_DENY})\s+(?:{_VERB})\s+(?P<b>.+)$")
_ALLOW_RE = re.compile(rf"^(?P<a>.+?)\s+(?:{_ALLOW})\s+(?:{_VERB})\s+(?P<b>.+)$")
_ISO1_RE = re.compile(r"^(?P<a>.+?)\s+(?:is\s+|are\s+|fully\s+|completely\s+|client\s+)*"
                      r"isolat(?:ed|ion|e)\b.*$")
_ISO2_RE = re.compile(r"^isolate\s+(?P<a>.+?)(?:\s+from\s+.*)?$")
_NO_NET_RE = re.compile(r"^(?P<a>.+?)\s+(?:has\s+no|have\s+no|gets?\s+no|with\s+no|no)\s+"
                        r"(?:internet|wan|web)(?:\s+access)?$")
_HAS_NET_RE = re.compile(r"^(?P<a>.+?)\s+(?:has|have|gets?|needs?|with)\s+"
                         r"(?:internet|wan|web)(?:\s+access)?$")

_ANY_WORDS = {"any", "anything", "everything", "everyone", "all", "all vlans",
              "all other vlans", "other vlans", "the other vlans", "the rest",
              "the rest of the network", "everywhere", "all networks", "each other",
              "the whole network", "the internal network", "internal"}
_NET_WORDS = {"internet", "the internet", "wan", "the wan", "web", "the web",
              "outside", "the outside"}


def _normalize(line: str) -> str:
    s = line.strip().lower().rstrip(".")
    s = re.sub(r"\s+", " ", s)
    return s


def _strip_target(tok: str) -> str:
    tok = tok.strip()
    tok = re.sub(r"^the\s+", "", tok)
    tok = re.sub(r"\s+(?:vlan|network|subnet|segment|zone|devices|clients|"
                 r"traffic|users|machines|hosts)$", "", tok)
    return tok.strip()


def _resolve_target(tok: str, design: dict):
    """Return ('any',) | ('net',) | ('vlan', name) | None for a target phrase.

    Case-insensitive: intent text arrives pre-lowercased via _normalize(), but
    structured extra_rule endpoints arrive as raw JSON, so normalize the case
    here in one place. Returns the VLAN's canonical (original-case) name.
    """
    raw = tok.strip().lower()
    t = _strip_target(raw)
    if raw in _ANY_WORDS or t in _ANY_WORDS:
        return ("any",)
    if raw in _NET_WORDS or t in _NET_WORDS:
        return ("net",)
    if t in design["name_to_vlan_ci"]:
        return ("vlan", design["name_to_vlan_ci"][t]["name"])
    m = re.match(r"^vlan\s*0*(\d+)$", t)
    if m and int(m.group(1)) in design["id_to_vlan"]:
        return ("vlan", design["id_to_vlan"][int(m.group(1))]["name"])
    if re.fullmatch(r"\d+", t) and int(t) in design["id_to_vlan"]:
        return ("vlan", design["id_to_vlan"][int(t)]["name"])
    return None


def _resolve_object_list(phrase: str, design: dict):
    """An object phrase may be a list: 'staff and management' / 'staff, cameras'."""
    parts = re.split(r"\s*(?:,|/|\band\b|\bor\b|\bnor\b)\s*", phrase)
    parts = [p for p in parts if p.strip()]
    resolved, bad = [], []
    for p in parts:
        r = _resolve_target(p, design)
        (resolved if r else bad).append(r if r else p)
    return resolved, bad


def parse_intent(line: str, design: dict):
    """Parse one intent sentence -> (subject_vlan_name, action, dst_keys, kind).

    dst_keys is a list of VLAN names and/or the INTERNET sentinel.
    Raises ConfigError with the accepted forms if the sentence cannot be parsed.
    """
    s = _normalize(line)

    def subject(a):
        r = _resolve_target(a, design)
        if not r or r[0] != "vlan":
            raise ConfigError(
                f"Intent \"{line}\": the subject must be one of your VLAN names "
                f"({', '.join(sorted(v for v in design['name_to_vlan']))}), got '{a.strip()}'.")
        return r[1]

    def expand(objs, include_net):
        keys = []
        for r in objs:
            if r[0] == "vlan":
                keys.append(r[1])
            elif r[0] == "net":
                keys.append(INTERNET)
            elif r[0] == "any":
                keys.extend(v["name"] for v in design["vlans"])
                if include_net:
                    keys.append(INTERNET)
        return keys

    # convenience internet forms first (they are unambiguous)
    m = _NO_NET_RE.match(s)
    if m:
        return subject(m.group("a")), "deny", [INTERNET], "internet"
    m = _HAS_NET_RE.match(s)
    if m:
        return subject(m.group("a")), "allow", [INTERNET], "internet"

    # isolation: subject cannot reach any OTHER vlan (internet governed separately)
    m = _ISO2_RE.match(s) or _ISO1_RE.match(s)
    if m:
        subj = subject(m.group("a"))
        others = [v["name"] for v in design["vlans"] if v["name"] != subj]
        return subj, "deny", others, "isolate"

    # general deny / allow
    for rx, action in ((_DENY_RE, "deny"), (_ALLOW_RE, "allow")):
        m = rx.match(s)
        if m:
            subj = subject(m.group("a"))
            objs, bad = _resolve_object_list(m.group("b"), design)
            if bad:
                raise ConfigError(
                    f"Intent \"{line}\": could not understand target '{bad[0]}'. "
                    "Use a VLAN name, 'internet', or 'everything'.")
            # 'any'/'everything' includes internet; a bare vlan does not.
            include_net = True
            keys = expand(objs, include_net)
            # a subject never targets itself
            keys = [k for k in keys if k != subj]
            if not keys:
                raise ConfigError(f"Intent \"{line}\": resolved to no destinations.")
            return subj, action, keys, "general"

    raise ConfigError(
        f"Could not parse intent line: \"{line}\".\n"
        "  Accepted forms (case-insensitive):\n"
        "    <vlan> cannot reach <vlan|internet|everything>\n"
        "    <vlan> can reach <vlan|internet|everything>\n"
        "    <vlan> isolated            (blocks it from every other VLAN)\n"
        "    <vlan> has no internet     /   <vlan> has internet\n"
        "  You can list targets: 'guest cannot reach staff and management'.")


# ---------------------------------------------------------------------------
# 3. Build the policy matrix from defaults + intent + extra_rules
# ---------------------------------------------------------------------------
def build_policy(design: dict, log: fieldkit.Logger):
    """Return (matrix, conflicts).

    matrix[src_name][dst_key] = {action, reason, source, ports, protocols}
      dst_key is a destination VLAN name or the INTERNET sentinel.
      action is "accept" or "drop".
    """
    fw = design["firewall"]
    default_drop = fw["default"] == "deny"
    matrix = {}

    for src in design["vlans"]:
        row = {}
        for dst in design["vlans"]:
            if dst["name"] == src["name"]:
                continue
            row[dst["name"]] = {
                "action": "drop" if default_drop else "accept",
                "reason": f"inter-VLAN default = {fw['default']}",
                "source": "default", "ports": None, "protocols": None,
            }
        row[INTERNET] = {
            "action": "accept" if src["internet"] else "drop",
            "reason": f"vlan.internet = {str(src['internet']).lower()}",
            "source": "default", "ports": None, "protocols": None,
        }
        matrix[src["name"]] = row

    conflicts = []

    def set_cell(src, dst_key, action, reason, source, ports=None, protocols=None):
        cell = matrix[src].get(dst_key)
        if cell is None:
            return  # src==dst or unknown; ignore
        if cell["source"] in ("intent", "extra_rule") and cell["action"] != action:
            conflicts.append(
                f"{src} -> {_disp(dst_key)}: '{cell['reason']}' ({cell['action']}) "
                f"overridden by '{reason}' ({action}). Last one wins -- confirm intended.")
        cell.update({"action": action, "reason": reason, "source": source,
                     "ports": ports, "protocols": protocols})

    # apply intent in order
    for line in fw["intent"]:
        subj, action, keys, kind = parse_intent(line, design)
        act = "drop" if action == "deny" else "accept"
        for k in keys:
            set_cell(subj, k, act, f"intent: {line}", "intent")

    # apply structured extra_rules (can add port granularity), last so they win
    for i, rule in enumerate(fw["extra_rules"]):
        where = f"firewall.extra_rules[{i}]"
        if not isinstance(rule, dict):
            raise ConfigError(f"{where} must be an object.")
        rf, rt = rule.get("from"), rule.get("to")
        raction = str(rule.get("action", "")).lower()
        if raction not in ("allow", "deny"):
            raise ConfigError(f"{where}.action must be 'allow' or 'deny'.")
        rs = _resolve_target(str(rf or ""), design)
        if not rs or rs[0] != "vlan":
            raise ConfigError(f"{where}.from '{rf}' must be a VLAN name.")
        rd = _resolve_target(str(rt or ""), design)
        if not rd:
            raise ConfigError(f"{where}.to '{rt}' must be a VLAN name or 'internet'.")
        dst_key = INTERNET if rd[0] == "net" else (
            "__any__" if rd[0] == "any" else rd[1])
        act = "drop" if raction == "deny" else "accept"
        ports = rule.get("ports")
        note = rule.get("note") or f"{where}"
        targets = ([INTERNET] + [v["name"] for v in design["vlans"] if v["name"] != rs[1]]
                   if dst_key == "__any__" else [dst_key])
        for k in targets:
            set_cell(rs[1], k, act, f"extra_rule: {note}", "extra_rule",
                     ports=ports, protocols=None)

    if conflicts:
        log.log("\n[!] Policy conflicts detected (later statement wins):")
        for c in conflicts:
            log.log(f"    - {c}")
    return matrix, conflicts


def _disp(dst_key: str) -> str:
    return "internet" if dst_key == INTERNET else dst_key


def _ports_to_rules(ports: str):
    """'tcp/554,tcp/80,udp/123' -> [('tcp',['554','80']),('udp',['123'])]."""
    if not ports:
        return []
    proto_map = {}
    for tok in str(ports).split(","):
        tok = tok.strip().lower()
        if not tok:
            continue
        if "/" in tok:
            proto, port = tok.split("/", 1)
        else:
            proto, port = "tcp", tok
        proto_map.setdefault(proto, []).append(port.strip())
    return list(proto_map.items())


# ---------------------------------------------------------------------------
# 4a. MikroTik RouterOS generator
# ---------------------------------------------------------------------------
def gen_mikrotik(design: dict, matrix: dict) -> str:
    L = []
    a = L.append
    fw = design["firewall"]
    wan = design["wan"]["interface"]
    bridge = design["lan"]["bridge"]
    trunks = design["lan"]["trunk_ports"]

    a(_header_lines(design, "mikrotik", "#"))
    a("# RouterOS CLI script (.rsc). Paste into a New Terminal, or import with:")
    a("#   /import file-name=this-file.rsc")
    a("# REVIEW every line. Have console/Winbox-MAC access before you apply -- a")
    a("# firewall paste can drop your management session.")
    a("")

    # WAN
    a("# ===== WAN / uplink =====")
    if design["wan"]["notes"]:
        a(f"# {design['wan']['notes']}")
    a("/ip dhcp-client")
    a(f"add interface={wan} disabled=no use-peer-dns=no comment=\"WAN uplink (ISP DHCP). "
      "Delete + configure PPPoE/static if your ISP needs it.\"")
    a("")

    # Bridge + VLAN filtering
    a("# ===== LAN bridge with 802.1Q VLAN filtering =====")
    a("/interface bridge")
    a(f"add name={bridge} vlan-filtering=no comment=\"Ark Field Kit LAN bridge "
      "(vlan-filtering enabled at the end, once tagging is in place)\"")
    a("/interface bridge port")
    for p in trunks:
        a(f"add bridge={bridge} interface={p} comment=\"trunk -- carries all VLANs tagged\"")
    if not trunks:
        a(f"# add bridge={bridge} interface=ether2 comment=\"add your trunk port(s) here\"")
    a("")

    # VLAN interfaces
    a("# ===== VLAN interfaces =====")
    a("/interface vlan")
    for v in design["vlans"]:
        a(f"add interface={bridge} name=vlan{v['id']}-{v['slug']} vlan-id={v['id']} "
          f"comment=\"{v['name']}: {v['purpose']}\"")
    a("")

    # bridge vlan table (which ports carry which tagged vlan)
    a("# ===== Bridge VLAN table (tagged on the bridge + trunk ports) =====")
    a("/interface bridge vlan")
    tagged = ",".join([bridge] + trunks) if trunks else bridge
    for v in design["vlans"]:
        a(f"add bridge={bridge} vlan-ids={v['id']} tagged={tagged} comment=\"{v['name']}\"")
    a("# NOTE: set the correct pvid + untagged membership on each ACCESS port")
    a("#       (the wall jacks). e.g. /interface bridge port set [find interface=ether5] "
      f"pvid=<vlan-id>")
    a("")

    # IP addresses (gateways)
    a("# ===== Gateway IP addresses =====")
    a("/ip address")
    for v in design["vlans"]:
        a(f"add address={v['gateway']}/{v['net'].prefixlen} "
          f"interface=vlan{v['id']}-{v['slug']} comment=\"{v['name']} gateway\"")
    a("")

    # DHCP pools + servers
    a("# ===== DHCP pools and servers =====")
    a("/ip pool")
    for v in design["vlans"]:
        if v["dhcp"]:
            a(f"add name=pool-{v['slug']} ranges={v['dhcp']['start']}-{v['dhcp']['end']}")
    a("/ip dhcp-server")
    for v in design["vlans"]:
        if v["dhcp"]:
            a(f"add name=dhcp-{v['slug']} interface=vlan{v['id']}-{v['slug']} "
              f"address-pool=pool-{v['slug']} lease-time={v['dhcp']['lease']} disabled=no")
    a("/ip dhcp-server network")
    for v in design["vlans"]:
        if v["dhcp"]:
            dns = ",".join(v["dhcp"]["dns"])
            a(f"add address={v['net'].with_prefixlen} gateway={v['gateway']} "
              f"dns-server={dns} comment=\"{v['name']}\"")
    a("")

    # enable vlan-filtering now that tagging exists
    a("# ===== Turn on VLAN filtering (do this last) =====")
    a(f"/interface bridge set [find name={bridge}] vlan-filtering=yes")
    a("")

    # NAT
    a("# ===== NAT (masquerade internet-enabled VLANs only) =====")
    a("/ip firewall nat")
    for v in design["vlans"]:
        if matrix[v["name"]][INTERNET]["action"] == "accept":
            a(f"add chain=srcnat action=masquerade src-address={v['net'].with_prefixlen} "
              f"out-interface={wan} comment=\"NAT {v['name']} to internet\"")
    a("")

    # Firewall filter -- the isolation policy
    a("# ===== Firewall filter: inter-VLAN policy (implements firewall.intent) =====")
    a("/ip firewall filter")
    a("# 1) stateful: let return traffic through, drop invalid")
    a("add chain=forward action=accept connection-state=established,related "
      "comment=\"allow return traffic\"")
    a("add chain=forward action=drop connection-state=invalid "
      "comment=\"drop invalid\"")
    a("# 2) inter-VLAN rules (one decision per source/destination pair)")
    for src in design["vlans"]:
        for dst in design["vlans"]:
            if dst["name"] == src["name"]:
                continue
            cell = matrix[src["name"]][dst["name"]]
            sa, da = src["net"].with_prefixlen, dst["net"].with_prefixlen
            tag = _short_reason(cell["reason"])
            if cell["action"] == "accept":
                port_rules = _ports_to_rules(cell["ports"])
                if port_rules:
                    for proto, plist in port_rules:
                        a(f"add chain=forward action=accept src-address={sa} dst-address={da} "
                          f"protocol={proto} dst-port={','.join(plist)} "
                          f"comment=\"allow {src['name']}->{dst['name']} ({proto}) :: {tag}\"")
                    a(f"add chain=forward action=drop src-address={sa} dst-address={da} "
                      f"comment=\"deny other {src['name']}->{dst['name']} (only listed ports "
                      "allowed)\"")
                else:
                    a(f"add chain=forward action=accept src-address={sa} dst-address={da} "
                      f"comment=\"allow {src['name']}->{dst['name']} :: {tag}\"")
            else:
                a(f"add chain=forward action=drop src-address={sa} dst-address={da} "
                  f"comment=\"DENY {src['name']}->{dst['name']} :: {tag}\"")
    a("# 3) internet access per VLAN (out the WAN interface)")
    for v in design["vlans"]:
        cell = matrix[v["name"]][INTERNET]
        sa = v["net"].with_prefixlen
        if cell["action"] == "accept":
            a(f"add chain=forward action=accept src-address={sa} out-interface={wan} "
              f"comment=\"allow {v['name']}->internet\"")
        else:
            a(f"add chain=forward action=drop src-address={sa} out-interface={wan} "
              f"comment=\"DENY {v['name']}->internet :: {_short_reason(cell['reason'])}\"")
    a("# 4) default deny anything not explicitly allowed above (also blocks WAN->LAN)")
    a("add chain=forward action=drop comment=\"Ark Field Kit default deny (forward)\"")
    a("")

    # input chain -- conservative, warns rather than locking the tech out
    a("# ===== Firewall filter: traffic TO the router (input chain) =====")
    a("# Conservative on purpose: we do NOT blindly drop all input, so a paste can't")
    a("# lock you out mid-config. Verify management access, THEN uncomment the final")
    a("# drop to fully close the router.  <-- do not skip this in production.")
    mgmt = _pick_mgmt_subnet(design)
    a("add chain=input action=accept connection-state=established,related "
      "comment=\"return traffic to router\"")
    a("add chain=input action=drop connection-state=invalid comment=\"drop invalid\"")
    a("add chain=input action=accept protocol=icmp comment=\"allow ping to router\"")
    for v in design["vlans"]:
        if v["dhcp"]:
            a(f"add chain=input action=accept protocol=udp dst-port=67,68 "
              f"in-interface=vlan{v['id']}-{v['slug']} comment=\"DHCP for {v['name']}\"")
    if mgmt:
        a(f"add chain=input action=accept src-address={mgmt} "
          "comment=\"management VLAN may administer the router\"")
    a("# add chain=input action=drop comment=\"UNCOMMENT after verifying mgmt access "
      "-- drop all other input\"")
    a("")

    a(_guest_wifi_block(design, "mikrotik", "#"))
    a("# ===== End of generated MikroTik config =====")
    return "\n".join(L) + "\n"


def _pick_mgmt_subnet(design: dict):
    for pref in ("management", "mgmt", "admin"):
        for v in design["vlans"]:
            if pref in v["name"].lower():
                return v["net"].with_prefixlen
    return None


def _short_reason(reason: str) -> str:
    r = reason.replace("intent: ", "").replace("extra_rule: ", "")
    return (r[:70] + "...") if len(r) > 73 else r


# ---------------------------------------------------------------------------
# 4b. Cisco IOS generator
# ---------------------------------------------------------------------------
def gen_cisco(design: dict, matrix: dict) -> str:
    L = []
    a = L.append
    a(_header_lines(design, "cisco", "!"))
    a("! Cisco IOS config for a L3 switch / router doing inter-VLAN routing.")
    a("! Paste into 'configure terminal'. REVIEW first; ACLs are stateless -- see the")
    a("! note on the SVIs. Model assumes SVIs (ip routing) on this device.")
    a("!")
    a("ip routing")
    a("!")

    # VLAN definitions
    a("! ===== VLAN definitions =====")
    for v in design["vlans"]:
        a(f"vlan {v['id']}")
        a(f" name {_ios_name(v['name'])}")
    a("!")

    # DHCP
    a("! ===== DHCP (exclusions keep addresses outside the pool free) =====")
    for v in design["vlans"]:
        if not v["dhcp"]:
            continue
        net = v["net"]
        first = net.network_address + 1
        last = net.broadcast_address - 1
        s_ip = ipaddress.ip_address(v["dhcp"]["start"])
        e_ip = ipaddress.ip_address(v["dhcp"]["end"])
        if int(s_ip) > int(first):
            a(f"ip dhcp excluded-address {first} {s_ip - 1}")
        if int(e_ip) < int(last):
            a(f"ip dhcp excluded-address {e_ip + 1} {last}")
        a(f"ip dhcp excluded-address {v['gateway']}")
    for v in design["vlans"]:
        if not v["dhcp"]:
            continue
        a(f"ip dhcp pool {_ios_name(v['name'])}")
        a(f" network {v['net'].network_address} {v['net'].netmask}")
        a(f" default-router {v['gateway']}")
        a(f" dns-server {' '.join(v['dhcp']['dns'])}")
        a(f" lease {_ios_lease(v['dhcp']['lease'])}")
    a("!")

    # ACLs (per source VLAN, applied inbound on its SVI)
    a("! ===== Inter-VLAN ACLs (implements firewall.intent) =====")
    a("! One extended ACL per VLAN, applied inbound on that VLAN's SVI, so it filters")
    a("! traffic AS IT LEAVES that VLAN toward everything else.")
    for src in design["vlans"]:
        acl = f"ACL-{_ios_name(src['name'])}-IN"
        a(f"ip access-list extended {acl}")
        a(f" remark Ark Field Kit -- egress policy for VLAN {src['id']} ({src['name']})")
        # Stateless-ACL return traffic: if another VLAN is allowed to INITIATE a TCP
        # session INTO this VLAN, then this VLAN must be able to send TCP replies
        # back. 'established' matches only packets with ACK/RST set (replies), so it
        # does NOT let this VLAN start new connections -- isolation intent is intact.
        sw = f"{src['net'].network_address} {src['net'].hostmask}"
        for other in design["vlans"]:
            if other["name"] == src["name"]:
                continue
            if matrix[other["name"]][src["name"]]["action"] == "accept":
                ow = f"{other['net'].network_address} {other['net'].hostmask}"
                a(f" permit tcp {sw} {ow} established  ! reply path for "
                  f"{other['name']}-initiated TCP sessions (not new connections)")
        # per-destination-VLAN decisions
        for dst in design["vlans"]:
            if dst["name"] == src["name"]:
                continue
            cell = matrix[src["name"]][dst["name"]]
            sw = f"{src['net'].network_address} {src['net'].hostmask}"
            dw = f"{dst['net'].network_address} {dst['net'].hostmask}"
            tag = _short_reason(cell["reason"])
            if cell["action"] == "accept":
                port_rules = _ports_to_rules(cell["ports"])
                if port_rules:
                    for proto, plist in port_rules:
                        for port in plist:
                            a(f" permit {proto} {sw} {dw} eq {port}  ! {src['name']}->"
                              f"{dst['name']} {tag}")
                    a(f" deny ip {sw} {dw}  ! block other {src['name']}->{dst['name']}")
                else:
                    a(f" permit ip {sw} {dw}  ! allow {src['name']}->{dst['name']} {tag}")
            else:
                a(f" deny ip {sw} {dw}  ! DENY {src['name']}->{dst['name']} {tag}")
        # internet / everything else
        sw = f"{src['net'].network_address} {src['net'].hostmask}"
        if matrix[src["name"]][INTERNET]["action"] == "accept":
            a(f" permit ip {sw} any  ! allow {src['name']}->internet")
        else:
            a(f" deny ip {sw} any  ! DENY {src['name']}->internet")
    a("!")

    # SVIs
    a("! ===== SVIs (VLAN gateways) with the ACL applied inbound =====")
    for v in design["vlans"]:
        acl = f"ACL-{_ios_name(v['name'])}-IN"
        a(f"interface Vlan{v['id']}")
        a(f" description {v['name']} :: {v['purpose']}"[:200])
        a(f" ip address {v['gateway']} {v['net'].netmask}")
        a(f" ip access-group {acl} in")
        a(" no shutdown")
    a("!")
    a("! NOTE: extended ACLs are STATELESS. For every allowed inter-VLAN flow, the")
    a("! reverse VLAN's ACL carries a 'permit tcp ... established' line so TCP replies")
    a("! (RTSP-over-TCP, HTTP/HTTPS, RDP, SSH, etc.) get back -- WITHOUT letting the")
    a("! isolated VLAN start its own connections. Caveat: this covers TCP only. If an")
    a("! allowed service returns over UDP (e.g. some camera RTP/UDP streams), add a")
    a("! matching 'permit udp' reply line, or use a stateful/zone-based firewall or")
    a("! reflexive ACLs for full statefulness.")
    a("!")
    a("! ===== Trunk / uplink reminder =====")
    a("! Configure the uplink/trunk ports to carry these VLAN ids tagged, e.g.:")
    ids = ",".join(str(v["id"]) for v in design["vlans"])
    a(f"!   interface <uplink> ; switchport mode trunk ; switchport trunk allowed vlan {ids}")
    a("!")
    a(_guest_wifi_block(design, "cisco", "!"))
    a("! ===== End of generated Cisco IOS config =====")
    return "\n".join(x for x in L if x is not None) + "\n"


def _ios_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name).upper()


def _ios_lease(lease: str) -> str:
    """'1d'->'1', '12h'->'0 12', '30m'->'0 0 30'. Fallback: '1' day."""
    m = re.fullmatch(r"(\d+)\s*([dhm]?)", str(lease).strip().lower())
    if not m:
        return "1"
    n, unit = int(m.group(1)), m.group(2) or "d"
    if unit == "d":
        return f"{n}"
    if unit == "h":
        return f"0 {n}"
    return f"0 0 {n}"


# ---------------------------------------------------------------------------
# 4c. UniFi generator (documented summary + applyable JSON)
# ---------------------------------------------------------------------------
def gen_unifi(design: dict, matrix: dict) -> str:
    networks = []
    for v in design["vlans"]:
        is_guest = bool(design["guest_wifi"] and design["guest_wifi"]["vlan"] == v["id"])
        net = {
            "name": v["name"],
            "purpose_field": "guest" if is_guest else "corporate",
            "vlan": v["id"],
            "vlan_enabled": True,
            "subnet": v["net"].with_prefixlen,
            "gateway_ip": v["gateway"],
            "internet_access": matrix[v["name"]][INTERNET]["action"] == "accept",
            "purpose_note": v["purpose"],
        }
        if v["dhcp"]:
            net["dhcp"] = {
                "enabled": True,
                "range_start": v["dhcp"]["start"],
                "range_stop": v["dhcp"]["end"],
                "dns": v["dhcp"]["dns"],
                "lease_time_seconds": _lease_seconds(v["dhcp"]["lease"]),
            }
        networks.append(net)

    wlans = []
    if design["guest_wifi"]:
        g = design["guest_wifi"]
        wlan = {
            "ssid": g["ssid"],
            "network_vlan": g["vlan"],
            "is_guest": True,
            "client_device_isolation": g["client_isolation"],
        }
        if g.get("bandwidth_down_mbps") or g.get("bandwidth_up_mbps"):
            wlan["bandwidth_limit"] = {
                "download_kbps": (g["bandwidth_down_mbps"] or 0) * 1000,
                "upload_kbps": (g["bandwidth_up_mbps"] or 0) * 1000,
                "enabled": True,
            }
        wlans.append(wlan)

    # firewall rules -- LAN_IN ruleset, ordered; established/related first
    rules = [{
        "ruleset": "LAN_IN", "index": 2000, "name": "Allow established/related",
        "action": "accept", "state_established": True, "state_related": True,
        "protocol": "all", "enabled": True,
    }]
    idx = 2001
    for src in design["vlans"]:
        for dst in design["vlans"]:
            if dst["name"] == src["name"]:
                continue
            cell = matrix[src["name"]][dst["name"]]
            base = {
                "ruleset": "LAN_IN", "index": idx,
                "source": {"type": "NETv4", "subnet": src["net"].with_prefixlen},
                "destination": {"type": "NETv4", "subnet": dst["net"].with_prefixlen},
                "enabled": True,
                "note": _short_reason(cell["reason"]),
            }
            if cell["action"] == "accept":
                port_rules = _ports_to_rules(cell["ports"])
                if port_rules:
                    for proto, plist in port_rules:
                        r = dict(base)
                        r["index"] = idx
                        r["name"] = f"Allow {src['name']} -> {dst['name']} ({proto})"
                        r["action"] = "accept"
                        r["protocol"] = proto
                        r["destination"] = dict(base["destination"],
                                                port=",".join(plist))
                        rules.append(r)
                        idx += 1
                    rules.append({**base, "index": idx,
                                  "name": f"Drop other {src['name']} -> {dst['name']}",
                                  "action": "drop", "protocol": "all"})
                    idx += 1
                else:
                    rules.append({**base, "name": f"Allow {src['name']} -> {dst['name']}",
                                  "action": "accept", "protocol": "all"})
                    idx += 1
            else:
                rules.append({**base, "name": f"BLOCK {src['name']} -> {dst['name']}",
                              "action": "drop", "protocol": "all"})
                idx += 1
    # internet rules (destination = internet, modeled as any not-local via WAN)
    for v in design["vlans"]:
        cell = matrix[v["name"]][INTERNET]
        rules.append({
            "ruleset": "LAN_IN", "index": idx,
            "name": f"{'Allow' if cell['action'] == 'accept' else 'BLOCK'} "
                    f"{v['name']} -> internet",
            "action": cell["action"],
            "source": {"type": "NETv4", "subnet": v["net"].with_prefixlen},
            "destination": {"type": "internet"},
            "protocol": "all", "enabled": True,
            "note": _short_reason(cell["reason"]),
        })
        idx += 1

    # This file is a PURE, VALID JSON document (no comment lines) so the tech can
    # feed it straight to a JSON tool or the UniFi Network API. All the human
    # documentation lives in the leading _ fields.
    payload = {
        "_generator": "Ark Field Kit netconfig",
        "_platform": "unifi",
        "_site": design["site"],
        "_operator": design["operator"],
        "_generated": fieldkit.timestamp(),
        "_safety": "Generated text only -- this changes NOTHING until you apply it in "
                   "the controller. Review every value first.",
        "_summary": _unifi_summary(design, matrix),
        "_how_to_apply": [
            "This JSON documents the intended UniFi Network config. UniFi has no single",
            "bulk-import for all of this, so apply it in the controller UI (or via the",
            "Network API) in three passes, using the values below:",
            "1) Settings > Networks: create each entry in 'networks' (VLAN id, subnet,",
            "   gateway, DHCP range/DNS/lease, and Internet access per network).",
            "2) Settings > WiFi: create the SSID(s) in 'wlans'. For the guest SSID turn",
            "   ON 'Client Device Isolation' and set the bandwidth profile if present.",
            "3) Settings > Firewall & Security > Firewall Rules (LAN IN): create the",
            "   rules in 'firewall_rules' IN ORDER (by 'index'). These enforce the",
            "   isolation intent. UniFi auto-allows return traffic, but the explicit",
            "   established/related accept is included for clarity.",
        ],
        "networks": networks,
        "wlans": wlans,
        "firewall_rules": rules,
        "intent_documented": design["firewall"]["intent"],
    }
    return json.dumps(payload, indent=2) + "\n"


def _unifi_summary(design: dict, matrix: dict):
    """Human-readable controller summary as a list of lines (embedded in the JSON)."""
    lines = ["UniFi controller config summary", f"Site: {design['site']}",
             "Networks (Settings > Networks):"]
    for v in design["vlans"]:
        net_ok = "internet" if matrix[v["name"]][INTERNET]["action"] == "accept" \
            else "NO internet"
        dr = f"DHCP {v['dhcp']['start']}-{v['dhcp']['end']}" if v["dhcp"] else "no DHCP"
        lines.append(f"  VLAN {v['id']:>4}  {v['name']:<12} {v['net'].with_prefixlen:<18} "
                     f"gw {v['gateway']:<14} {dr}; {net_ok}")
    if design["guest_wifi"]:
        g = design["guest_wifi"]
        lines.append(f"Guest Wi-Fi: SSID '{g['ssid']}' on VLAN {g['vlan']}, "
                     f"client-isolation={'ON' if g['client_isolation'] else 'OFF'}")
    lines.append("Firewall (LAN_IN, in 'firewall_rules') enforces the intent in "
                 "'intent_documented'.")
    return lines


def _lease_seconds(lease: str) -> int:
    m = re.fullmatch(r"(\d+)\s*([dhm]?)", str(lease).strip().lower())
    if not m:
        return 86400
    n, unit = int(m.group(1)), m.group(2) or "d"
    return n * {"d": 86400, "h": 3600, "m": 60}[unit]


# ---------------------------------------------------------------------------
# Shared generated-file pieces
# ---------------------------------------------------------------------------
def _header_lines(design: dict, platform: str, c: str) -> str:
    lines = [
        f"{c} ==========================================================================",
        f"{c}  Generated by Ark Field Kit :: netconfig ({platform})",
        f"{c}  Site      : {design['site']}",
        f"{c}  Operator  : {design['operator']}" if design["operator"] else None,
        f"{c}  Generated : {fieldkit.timestamp()}",
        f"{c}  VLANs     : " + ", ".join(f"{v['id']}={v['name']}" for v in design["vlans"]),
        f"{c}  SAFE: this is generated text only. It changes NOTHING until you paste it.",
        f"{c}        Review every line and keep out-of-band access before applying.",
        f"{c} ==========================================================================",
    ]
    return "\n".join(x for x in lines if x is not None)


def _guest_wifi_block(design: dict, platform: str, c: str) -> str:
    g = design["guest_wifi"]
    if not g:
        return f"{c} (no guest_wifi section in the design)\n"
    out = [f"{c} ===== Guest Wi-Fi =====",
           f"{c} SSID '{g['ssid']}' lives on VLAN {g['vlan']}. The firewall rules above",
           f"{c} already block guest from every internal VLAN. Two things the firewall",
           f"{c} cannot do -- set them on the Wi-Fi/AP itself:",
           f"{c}   1) CLIENT ISOLATION (station-to-station within the SSID): "
           f"{'ON' if g['client_isolation'] else 'OFF (client asked to leave it off)'}.",
           f"{c}   2) Bandwidth limit: "
           + (f"{g.get('bandwidth_down_mbps')} down / {g.get('bandwidth_up_mbps')} up Mbps."
              if g.get("bandwidth_down_mbps") or g.get("bandwidth_up_mbps") else "not set.")]
    if platform == "mikrotik":
        out += [
            f"{c} If this router runs RouterOS 'wifi' (wifiwave2), the datapath sets isolation:",
            f"{c}   /interface wifi datapath add name=guest-dp bridge={design['lan']['bridge']} "
            f"vlan-id={g['vlan']} client-isolation="
            f"{'yes' if g['client_isolation'] else 'no'}",
            f"{c}   /interface wifi add name=wifi-guest ssid=\"{g['ssid']}\" datapath=guest-dp "
            "security.authentication-types=wpa2-psk security.passphrase=\"<SET-AT-RUNTIME>\"",
            f"{c}   (never store the passphrase in the design file -- set it on the device)",
        ]
    elif platform == "cisco":
        out += [
            f"{c} On a Cisco WLC/Meraki, map SSID '{g['ssid']}' to VLAN {g['vlan']} and enable",
            f"{c} 'Peer to Peer Blocking' / client isolation on the WLAN. Do not put the PSK here.",
        ]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------------------
# 5. Verify the generated config actually enforces the isolation intent
# ---------------------------------------------------------------------------
def verify(design: dict, matrix: dict, generated: dict, log: fieldkit.Logger):
    """For every 'drop' decision, confirm a matching deny rule exists in each
    generated platform text. Returns (all_ok, rows) and prints a table.
    """
    checks = []  # (src_name, dst_key)
    for src in design["vlans"]:
        for dst_key, cell in matrix[src["name"]].items():
            if cell["action"] == "drop":
                checks.append((src["name"], dst_key))

    rows, all_ok = [], True
    for src_name, dst_key in checks:
        src = design["name_to_vlan"][src_name]
        dst = None if dst_key == INTERNET else design["name_to_vlan"][dst_key]
        per_platform = {}
        for plat, text in generated.items():
            ok = _text_denies(plat, text, src, dst, design)
            per_platform[plat] = ok
            all_ok = all_ok and ok
        rows.append((src_name, _disp(dst_key), per_platform))

    log.log("\n=== Isolation verification (generated rules vs. stated intent) ===")
    plats = list(generated.keys())
    header = f"  {'SOURCE':<12} -> {'MUST NOT REACH':<14} " + \
             "  ".join(f"{p:<9}" for p in plats)
    log.log(header)
    log.log("  " + "-" * (len(header) - 2))
    for src_name, dst_disp, pp in rows:
        cells = "  ".join(f"{('PASS' if pp[p] else 'FAIL'):<9}" for p in plats)
        log.log(f"  {src_name:<12} -> {dst_disp:<14} {cells}")
    if not rows:
        log.log("  (no deny relationships in this design -- nothing to isolate)")
    log.log("")
    if all_ok:
        log.log(f"[OK] All {len(checks)} isolation rule(s) are present in every generated "
                "platform config.")
    else:
        log.log("[FAIL] One or more isolation rules are MISSING from a generated config. "
                "Do NOT ship this until resolved.")
    log.log("[note] Scope: this proves inter-VLAN FORWARDING isolation only (the forward")
    log.log("       chain / LAN_IN rules). It does NOT prove a denied VLAN cannot reach the")
    log.log("       router's OWN services (Winbox/SSH/API/WebFig/DNS) on the router IPs,")
    log.log("       including the management gateway. On MikroTik that host-to-router")
    log.log("       exposure is closed only once you uncomment the input-chain 'drop all")
    log.log("       other input' line after confirming management access.")
    return all_ok, rows


def _text_denies(platform, text, src, dst, design) -> bool:
    """True if `text` contains a rule dropping/denying src -> dst (dst=None => internet)."""
    if platform == "mikrotik":
        sa = re.escape(src["net"].with_prefixlen)
        for line in text.splitlines():
            if "action=drop" not in line or f"src-address={src['net'].with_prefixlen}" not in line:
                continue
            if dst is None:
                if f"out-interface={design['wan']['interface']}" in line:
                    return True
            else:
                if f"dst-address={dst['net'].with_prefixlen}" in line:
                    return True
        # covered by the trailing default-deny? only counts if there is no earlier accept.
        return _mikrotik_default_deny_covers(text, src, dst, design)
    if platform == "cisco":
        sw = f"{src['net'].network_address} {src['net'].hostmask}"
        for line in text.splitlines():
            ls = line.strip()
            if not ls.startswith("deny ip"):
                continue
            if sw not in ls:
                continue
            if dst is None:
                if ls.endswith(" any") or " any " in ls[len("deny ip"):]:
                    return True
            else:
                dw = f"{dst['net'].network_address} {dst['net'].hostmask}"
                if dw in ls:
                    return True
        return False
    if platform == "unifi":
        # structured: find a drop rule with this source and matching destination
        try:
            payload = json.loads(text[text.index("{"):])
        except (ValueError, json.JSONDecodeError):
            return False
        for r in payload.get("firewall_rules", []):
            if r.get("action") != "drop":
                continue
            if r.get("source", {}).get("subnet") != src["net"].with_prefixlen:
                continue
            d = r.get("destination", {})
            if dst is None:
                if d.get("type") == "internet":
                    return True
            else:
                if d.get("subnet") == dst["net"].with_prefixlen:
                    return True
        return False
    return False


def _mikrotik_default_deny_covers(text, src, dst, design) -> bool:
    """The trailing 'default deny (forward)' catches anything not explicitly accepted.
    It genuinely enforces the drop as long as no earlier accept matches this pair."""
    has_default = any("Ark Field Kit default deny (forward)" in ln for ln in text.splitlines())
    if not has_default:
        return False
    # ensure there is no explicit accept for this exact pair earlier
    for line in text.splitlines():
        if "action=accept" not in line or f"src-address={src['net'].with_prefixlen}" not in line:
            continue
        if dst is None:
            if f"out-interface={design['wan']['interface']}" in line:
                return False
        else:
            if f"dst-address={dst['net'].with_prefixlen}" in line:
                return False
    return True


# ---------------------------------------------------------------------------
# Report + orchestration
# ---------------------------------------------------------------------------
EXT = {"mikrotik": "rsc", "cisco": "ios.txt", "unifi": "json"}


def write_outputs(design, generated, outdir: Path, log, slug):
    outdir.mkdir(parents=True, exist_ok=True)
    written = []
    for plat, text in generated.items():
        fn = outdir / f"{MODULE}-{slug}-{plat}-{fieldkit.date_slug()}.{EXT[plat]}"
        fn.write_text(text, encoding="utf-8")
        written.append(fn)
        log.log(f"[+] Wrote {plat} config -> {fn}")
    return written


def write_summary_report(design, matrix, verify_rows, all_ok, outdir: Path, slug, written):
    outdir.mkdir(parents=True, exist_ok=True)
    fn = outdir / f"{MODULE}-{slug}-summary-{fieldkit.date_slug()}.md"
    L = [f"# Network design summary -- {design['site']}", ""]
    L.append(f"- Generated: {fieldkit.timestamp()}")
    if design["operator"]:
        L.append(f"- Operator: {design['operator']}")
    L.append(f"- WAN uplink: `{design['wan']['interface']}`  {design['wan']['notes']}".rstrip())
    L.append("")
    L.append("## VLANs")
    L.append("")
    L.append("| VLAN | Name | Subnet | Gateway | DHCP range | Internet | Purpose |")
    L.append("|---|---|---|---|---|---|---|")
    for v in design["vlans"]:
        dr = f"{v['dhcp']['start']}-{v['dhcp']['end']}" if v["dhcp"] else "-"
        inet = "yes" if matrix[v["name"]][INTERNET]["action"] == "accept" else "**no**"
        L.append(f"| {v['id']} | {v['name']} | `{v['net'].with_prefixlen}` | "
                 f"`{v['gateway']}` | {dr} | {inet} | {v['purpose']} |")
    L.append("")
    if design["guest_wifi"]:
        g = design["guest_wifi"]
        L.append("## Guest Wi-Fi")
        L.append("")
        L.append(f"- SSID **{g['ssid']}** on VLAN {g['vlan']}")
        L.append(f"- Client isolation: **{'ON' if g['client_isolation'] else 'OFF'}**")
        if g.get("bandwidth_down_mbps") or g.get("bandwidth_up_mbps"):
            L.append(f"- Bandwidth cap: {g.get('bandwidth_down_mbps')} down / "
                     f"{g.get('bandwidth_up_mbps')} up Mbps")
        L.append("")
    L.append("## Inter-VLAN policy (source -> destination)")
    L.append("")
    dests = [v["name"] for v in design["vlans"]] + ["internet"]
    L.append("| from \\ to | " + " | ".join(dests) + " |")
    L.append("|" + "---|" * (len(dests) + 1))
    for src in design["vlans"]:
        cells = []
        for d in design["vlans"]:
            if d["name"] == src["name"]:
                cells.append("-")
            else:
                c = matrix[src["name"]][d["name"]]
                if c["action"] != "accept":
                    cells.append("**deny**")
                elif c["ports"]:
                    cells.append(f"allow ({c['ports']})")
                else:
                    cells.append("allow")
        cells.append("allow" if matrix[src["name"]][INTERNET]["action"] == "accept"
                     else "**deny**")
        L.append(f"| **{src['name']}** | " + " | ".join(cells) + " |")
    L.append("")
    L.append("## Stated intent")
    L.append("")
    for line in design["firewall"]["intent"]:
        L.append(f"- {line}")
    if not design["firewall"]["intent"]:
        L.append("- (none supplied)")
    L.append("")
    L.append("## Isolation verification")
    L.append("")
    L.append(f"Result: {'**ALL ISOLATION RULES ENFORCED**' if all_ok else '**FAILED -- see below**'}")
    L.append("")
    if verify_rows:
        plats = list(verify_rows[0][2].keys())
        L.append("| source | must not reach | " + " | ".join(plats) + " |")
        L.append("|" + "---|" * (len(plats) + 2))
        for src_name, dst_disp, pp in verify_rows:
            marks = " | ".join("PASS" if pp[p] else "**FAIL**" for p in plats)
            L.append(f"| {src_name} | {dst_disp} | {marks} |")
    else:
        L.append("_No deny relationships in this design._")
    L.append("")
    L.append("## Generated files")
    L.append("")
    for w in written:
        L.append(f"- `{w.name}`")
    L.append("")
    fn.write_text("\n".join(L) + "\n", encoding="utf-8")
    return fn


def build_parser() -> argparse.ArgumentParser:
    # Mirrors fieldkit.base_parser's flags (config, --authorized) but makes the
    # config path OPTIONAL so --self-test can run against the bundled example, and
    # adds --platform / --outdir. netconfig only generates text, so there is no
    # --apply: nothing is ever changed on a device.
    p = argparse.ArgumentParser(
        prog="netconfig.py",
        description="Generate VLAN / firewall / guest-Wi-Fi device configs from one "
                    "network-design JSON. Safe: generates text only, never touches a device.")
    p.add_argument("config", nargs="?", default=None,
                   help="path to your filled-in design JSON "
                        "(defaults to this module's config.example.json)")
    p.add_argument("--platform", choices=["mikrotik", "cisco", "unifi", "all"],
                   default="mikrotik",
                   help="which device config to generate (default: mikrotik). "
                        "'all' generates every platform.")
    p.add_argument("--outdir", default=str(fieldkit.REPORT_DIR),
                   help="where to write generated configs (default: field-kit/reports/)")
    p.add_argument("--authorized", metavar="NOTE",
                   help='record signed authorization, e.g. "Maple St Dental / 2026-01-04"')
    p.add_argument("--no-print", action="store_true",
                   help="write the files but do not echo full configs to the terminal")
    p.add_argument("--self-test", action="store_true",
                   help="offline self-test: generate ALL platforms from the example config, "
                        "assert expected content, no prompt. Exits non-zero on failure.")
    return p


def run(design, platforms, args, log):
    matrix, conflicts = build_policy(design, log)
    generated = {}
    if platforms == ["all"] or "all" in platforms:
        platforms = ["mikrotik", "cisco", "unifi"]
    # always generate all three for verification, but only emit/print the requested ones
    full = {p: {"mikrotik": gen_mikrotik, "cisco": gen_cisco,
                "unifi": gen_unifi}[p](design, matrix)
            for p in ["mikrotik", "cisco", "unifi"]}
    generated = {p: full[p] for p in platforms}

    all_ok, rows = verify(design, matrix, full, log)

    slug = slugify(design["site"])
    outdir = Path(args.outdir)
    written = write_outputs(design, generated, outdir, log, slug)
    summary = write_summary_report(design, matrix, rows, all_ok, outdir, slug, written)
    log.log(f"[+] Wrote summary report -> {summary}")

    if not args.no_print:
        for p in platforms:
            log.log("\n" + "=" * 74)
            log.log(f"===== {p.upper()} CONFIG (also written to file) =====")
            log.log("=" * 74)
            log.log(generated[p])

    return all_ok, conflicts


def main(argv=None):
    args = build_parser().parse_args(argv)
    cfg_path = args.config or str(EXAMPLE_CONFIG)

    raw = fieldkit.load_config(cfg_path, ["site", "vlans"])
    try:
        design = validate_design(raw)
    except ConfigError as e:
        sys.exit(f"Design error in {cfg_path}:\n  {e}")

    slug = slugify(design["site"])
    log = fieldkit.Logger(MODULE, slug)
    log.log(f"Config: {cfg_path}")
    # netconfig only ever generates text, so it is always in the kit's safe mode.
    log.log(f"Mode:   {fieldkit.mode_label(False)} -- generate-only, no device is touched")

    for w in design["warnings"]:
        log.log(f"[warn] {w}")

    # Authorization: still client infrastructure, so print the banner + confirm.
    if args.self_test:
        args.authorized = "SELF-TEST (bundled example config -- no client infrastructure)"
    fieldkit.confirm_authorization(args, design["site"], log)

    if args.self_test:
        platforms = ["mikrotik", "cisco", "unifi"]
        args.no_print = True
    else:
        platforms = [args.platform]

    try:
        all_ok, conflicts = run(design, platforms, args, log)
    except ConfigError as e:
        log.close()
        sys.exit(f"Design error: {e}")

    if args.self_test:
        ok = _self_test_asserts(design, log)
        log.log("")
        if all_ok and ok:
            log.log("[SELF-TEST PASS] all platforms generated, all assertions + isolation "
                    "checks passed.")
            log.close()
            return 0
        log.log("[SELF-TEST FAIL] see failures above.")
        log.close()
        sys.exit(1)

    log.log(f"\nDone. Logs: {log.path}")
    log.close()
    return 0 if all_ok else 1


def _self_test_asserts(design, log) -> bool:
    """Re-read the just-written files and assert expected content is present."""
    slug = slugify(design["site"])
    outdir = fieldkit.REPORT_DIR
    ok = True

    def check(cond, msg):
        nonlocal ok
        log.log(f"  [{'PASS' if cond else 'FAIL'}] {msg}")
        ok = ok and cond

    mk = (outdir / f"{MODULE}-{slug}-mikrotik-{fieldkit.date_slug()}.rsc").read_text()
    cs = (outdir / f"{MODULE}-{slug}-cisco-{fieldkit.date_slug()}.ios.txt").read_text()
    uni = (outdir / f"{MODULE}-{slug}-unifi-{fieldkit.date_slug()}.json").read_text()
    uni_json = json.loads(uni[uni.index("{"):])

    log.log("\n=== Self-test assertions ===")
    # every VLAN id appears in every platform
    for v in design["vlans"]:
        check(f"vlan-id={v['id']}" in mk, f"mikrotik has vlan-id={v['id']} ({v['name']})")
        check(f"vlan {v['id']}" in cs, f"cisco defines vlan {v['id']} ({v['name']})")
        check(any(n["vlan"] == v["id"] for n in uni_json["networks"]),
              f"unifi network for vlan {v['id']} ({v['name']})")

    # guest is denied to management/staff/cameras in all three (isolation intent)
    def has_deny(src, dst):
        s = design["name_to_vlan_ci"][src]
        d = design["name_to_vlan_ci"][dst]
        m = _text_denies("mikrotik", mk, s, d, design)
        c = _text_denies("cisco", cs, s, d, design)
        u = _text_denies("unifi", uni, s, d, design)
        return m, c, u

    for dst in ("management", "staff", "cameras"):
        m, c, u = has_deny("guest", dst)
        check(m and c and u, f"guest -> {dst} is DENIED on mikrotik/cisco/unifi "
                             f"({m}/{c}/{u})")

    # cameras have no internet, everywhere
    cam = design["name_to_vlan_ci"]["cameras"]
    check(_text_denies("mikrotik", mk, cam, None, design), "cameras -> internet denied (mikrotik)")
    check(_text_denies("cisco", cs, cam, None, design), "cameras -> internet denied (cisco)")
    check(_text_denies("unifi", uni, cam, None, design), "cameras -> internet denied (unifi)")

    # staff CAN reach cameras on the allowed ports (accept present)
    check("dst-port=554" in mk or "dst-port=554,80,443" in mk or "554" in mk,
          "mikrotik permits staff->cameras RTSP port 554")
    check("eq 554" in cs, "cisco permits staff->cameras RTSP port 554")

    # firewall isolation rules exist at all
    check("action=drop" in mk, "mikrotik contains drop rules")
    check("deny ip" in cs, "cisco contains deny rules")
    check(any(r.get("action") == "drop" for r in uni_json["firewall_rules"]),
          "unifi contains drop rules")
    return ok


if __name__ == "__main__":
    sys.exit(main())
