#!/usr/bin/env python3
"""Ark Field Kit - Cyber-insurance readiness report builder.

Reads the JSON produced by Invoke-SecurityAudit.ps1 and turns it into a
printable HTML report that maps the machine's real security posture onto the
questions a small business is actually asked on a cyber-insurance
application (endpoint protection, patch cadence, encryption at rest, MFA,
backups, security-awareness training, incident-response plan, ...).

For each questionnaire item the report shows:
  * the client's CURRENT status (Yes / Partial / No / Needs confirmation),
  * the evidence from the host audit that supports it, and
  * the remediation Ark recommends.

Some questions (backups, email MFA, awareness training, IR plan) cannot be
answered by scanning one Windows host - the report says so honestly and
flags them for a short interview rather than guessing.

This tool is READ-ONLY: it generates a document. It never changes a system.
Standard library only. Runs on any laptop / WSL with nothing to install.

Usage:
    python3 insurance-report.py CONFIG.json --audit AUDIT.json
    python3 insurance-report.py --self-test        # render from bundled sample
"""

import html
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import fieldkit  # noqa: E402  (path set up above)

MODULE = "insurance-report"
BRAND = "Ark Web Solutions"
REPORT_TITLE = "Cyber-Insurance Readiness Report"

# Severity ordering / presentation for the host-findings section.
SEV_RANK = {"critical": 0, "warn": 1, "unknown": 2, "good": 3}
SEV_LABEL = {
    "critical": "CRITICAL",
    "warn": "NEEDS WORK",
    "unknown": "UNKNOWN",
    "good": "GOOD",
}
SEV_COLORS = {
    # (text, background, bar)
    "critical": ("#7f1d1d", "#fee2e2", "#dc2626"),
    "warn": ("#7c2d12", "#ffedd5", "#ea580c"),
    "unknown": ("#334155", "#e2e8f0", "#64748b"),
    "good": ("#14532d", "#dcfce7", "#16a34a"),
}

# Answer presentation for the questionnaire section.
ANSWER_COLORS = {
    "Yes": ("#14532d", "#dcfce7"),
    "Partial": ("#7c2d12", "#ffedd5"),
    "No": ("#7f1d1d", "#fee2e2"),
    "Needs confirmation": ("#334155", "#e2e8f0"),
}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def e(text):
    return html.escape(str(text), quote=True)


def slugify(name):
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "site").lower()).strip("-")
    return slug or "site"


def file_stamp():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def find(findings, fid):
    for f in findings:
        if f.get("id") == fid:
            return f
    return None


def sev_of(f):
    return (f or {}).get("severity", "unknown")


# --------------------------------------------------------------------------
# Map host findings -> insurance questionnaire answers
# --------------------------------------------------------------------------
# Each entry: (question, how the answer is derived).
# derive() returns dict(answer, evidence, recommendation).

def _from_finding(f, good_answer="Yes", warn_answer="Partial",
                  crit_answer="No", default_rec=""):
    """Standard mapping from a single audit finding's severity."""
    if not f:
        return {
            "answer": "Needs confirmation",
            "evidence": "The host audit did not include this check.",
            "recommendation": default_rec,
        }
    sev = sev_of(f)
    answer = {
        "good": good_answer,
        "warn": warn_answer,
        "critical": crit_answer,
    }.get(sev, "Needs confirmation")
    rec = f.get("recommendation") or default_rec
    if sev == "good":
        rec = ""  # nothing to remediate
    return {
        "answer": answer,
        "evidence": f.get("status", ""),
        "recommendation": rec,
    }


def build_questionnaire(findings):
    """Return the list of questionnaire items with client status + advice."""
    q = []

    # 1. Endpoint protection
    f = find(findings, "defender_rtp")
    m = _from_finding(f, default_rec="Deploy managed endpoint protection on "
                      "every workstation and server, with real-time "
                      "protection on and definitions auto-updating.")
    q.append({
        "question": "Do all computers and servers run endpoint "
                    "protection / antivirus?",
        "why": "Insurers expect active, updating anti-malware on every device.",
        "assessed": True,
        **m,
    })

    # 2. Patch cadence
    f = find(findings, "patching")
    m = _from_finding(f, default_rec="Enable automatic updates and patch "
                      "critical vulnerabilities within your stated cadence "
                      "(monthly at minimum).")
    q.append({
        "question": "Are operating systems and software patched on a "
                    "regular cadence?",
        "why": "Unpatched systems are the most common ransomware entry point.",
        "assessed": True,
        **m,
    })

    # 3. Encryption at rest
    f = find(findings, "bitlocker")
    m = _from_finding(f, default_rec="Enable full-disk encryption (BitLocker) "
                      "on all laptops and workstations and escrow recovery keys.")
    q.append({
        "question": "Is data encrypted at rest (full-disk encryption on "
                    "laptops and workstations)?",
        "why": "Encryption protects data if a device is lost or stolen and is "
               "a common policy requirement.",
        "assessed": True,
        **m,
    })

    # 4. MFA on remote / administrative access
    f = find(findings, "rdp")
    rdp_sev = sev_of(f)
    if f and rdp_sev == "good":
        answer = "Needs confirmation"
        evidence = ("No Remote Desktop exposure was found on this host. "
                    "Confirm that any remote access (VPN, RMM) requires MFA.")
        rec = ("Confirm MFA is enforced on any remote-access path (VPN, "
               "remote-support tool, VDI).")
    elif f and rdp_sev in ("warn", "critical"):
        answer = "No"
        evidence = f.get("status", "Remote Desktop is exposed.")
        rec = (f.get("recommendation") or "") + \
            " Put multi-factor authentication in front of all remote access."
    else:
        answer = "Needs confirmation"
        evidence = "Remote-access exposure was not determined by the host audit."
        rec = "Confirm MFA is enforced on all remote access."
    q.append({
        "question": "Is multi-factor authentication (MFA) required for "
                    "remote and administrative access?",
        "why": "MFA on remote access is now a baseline requirement on almost "
               "every cyber-insurance application.",
        "assessed": bool(f),
        "answer": answer,
        "evidence": evidence,
        "recommendation": rec,
    })

    # 5. MFA on business email  (cannot be host-audited)
    q.append({
        "question": "Is MFA enabled on business email (Microsoft 365 / "
                    "Google Workspace)?",
        "why": "Email is the most attacked account; insurers ask about it "
               "specifically.",
        "assessed": False,
        "answer": "Needs confirmation",
        "evidence": "Not determinable from a host audit - verify in the email "
                    "tenant's admin console.",
        "recommendation": "Enforce MFA for every mailbox and disable legacy "
                          "(basic) authentication.",
    })

    # 6. Backups  (cannot be host-audited reliably)
    q.append({
        "question": "Are backups performed regularly, tested, and kept "
                    "offline / immutable?",
        "why": "Recoverable backups are what turn a ransomware event into an "
               "inconvenience instead of a closure.",
        "assessed": False,
        "answer": "Needs confirmation",
        "evidence": "Backup coverage cannot be confirmed from a single host - "
                    "review the backup solution and restore logs.",
        "recommendation": "Implement the 3-2-1 rule (3 copies, 2 media, 1 "
                          "off-site/immutable) and test restores quarterly.",
    })

    # 7. Security awareness training
    q.append({
        "question": "Do staff receive security-awareness / phishing training?",
        "why": "Most breaches start with a person clicking something; insurers "
               "reward documented training.",
        "assessed": False,
        "answer": "Needs confirmation",
        "evidence": "Organizational control - not visible to a host audit.",
        "recommendation": "Run recurring phishing-awareness training and keep "
                          "completion records.",
    })

    # 8. Incident-response plan
    q.append({
        "question": "Is there a written incident-response plan?",
        "why": "Insurers ask whether you know who to call and what to do in "
               "the first hour of an incident.",
        "assessed": False,
        "answer": "Needs confirmation",
        "evidence": "Organizational control - not visible to a host audit.",
        "recommendation": "Document a one-page incident-response plan with "
                          "roles, contacts, and the insurer's breach hotline.",
    })

    return q


# --------------------------------------------------------------------------
# HTML report
# --------------------------------------------------------------------------
def build_html(audit, questionnaire):
    findings = audit.get("findings", [])
    host = audit.get("host", {})
    site = audit.get("site_name", "Client site")
    client = audit.get("client", site)

    # Count answers.
    answer_counts = {"Yes": 0, "Partial": 0, "No": 0, "Needs confirmation": 0}
    for item in questionnaire:
        answer_counts[item["answer"]] = answer_counts.get(item["answer"], 0) + 1

    summary = audit.get("summary", {})
    crit = summary.get("critical", sum(
        1 for f in findings if sev_of(f) == "critical"))
    warn = summary.get("warn", sum(1 for f in findings if sev_of(f) == "warn"))

    findings_sorted = sorted(
        findings, key=lambda f: SEV_RANK.get(sev_of(f), 9))

    p = []
    p.append(f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(BRAND)} - {e(REPORT_TITLE)} - {e(site)}</title>
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
  .meta {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
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
  .intro {{ background:var(--card); border:1px solid var(--line);
    border-radius:10px; padding:16px 18px; color:var(--muted); }}
  .q {{ background:var(--card); border:1px solid var(--line);
    border-left:5px solid var(--muted); border-radius:8px; padding:14px 16px;
    margin:12px 0; }}
  .q .head {{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }}
  .q h3 {{ margin:0; font-size:14.5px; flex:1 1 60%; }}
  .answer {{ font-size:12px; font-weight:700; padding:3px 11px;
    border-radius:20px; letter-spacing:.4px; white-space:nowrap; }}
  .q .why {{ color:var(--muted); font-size:12.5px; margin:8px 0 6px; }}
  .q .evidence {{ font-size:13px; margin:6px 0; }}
  .q .evidence b {{ color:var(--brand); }}
  .q .rec {{ font-size:13px; margin-top:6px; }}
  .q .rec b {{ color:var(--brand); }}
  .q .assessedtag {{ font-size:10.5px; text-transform:uppercase;
    letter-spacing:.5px; color:#94a3b8; }}
  table {{ width:100%; border-collapse:collapse; background:var(--card);
    border:1px solid var(--line); border-radius:8px; overflow:hidden; }}
  .tablewrap {{ overflow-x:auto; }}
  th,td {{ text-align:left; padding:9px 12px; border-bottom:1px solid var(--line);
    vertical-align:top; font-size:13px; }}
  th {{ background:#eef2f7; font-size:11px; text-transform:uppercase;
    letter-spacing:.5px; color:var(--muted); }}
  tr:last-child td {{ border-bottom:none; }}
  .badge {{ font-size:11px; font-weight:700; padding:2px 9px; border-radius:20px;
    letter-spacing:.5px; white-space:nowrap; }}
  .finding {{ background:var(--card); border:1px solid var(--line);
    border-left:5px solid var(--muted); border-radius:8px; padding:12px 16px;
    margin:10px 0; }}
  .finding .row {{ display:flex; align-items:center; gap:10px; }}
  .finding h3 {{ margin:0; font-size:14px; }}
  .finding p {{ margin:8px 0 4px; color:var(--muted); font-size:13px; }}
  .finding .fix {{ font-size:13px; }}
  .finding .fix b {{ color:var(--brand); }}
  footer {{ margin-top:34px; padding-top:14px; border-top:1px solid var(--line);
    color:var(--muted); font-size:11.5px; }}
  .note {{ background:#fff7ed; border:1px solid #fed7aa; color:#7c2d12;
    border-radius:8px; padding:10px 14px; font-size:12.5px; margin:14px 0; }}
  a {{ color:var(--brand2); }}
  @media print {{
    body {{ background:#fff; }}
    .wrap {{ max-width:none; padding:0; }}
    .card,.q,.finding,table {{ break-inside:avoid; }}
    header.brand {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  }}
</style>
</head>
<body>
<div class="wrap">
<header class="brand">
  <h1>{e(BRAND)}</h1>
  <div class="sub">{e(REPORT_TITLE)} &middot; maps your systems to your cyber-insurance application</div>
  <div class="site">{e(site)}</div>
  <div class="meta">
    <div><span>Client</span>{e(client)}</div>
    <div><span>Contact</span>{e(audit.get('contact_name') or '—')}</div>
    <div><span>Machine</span>{e(host.get('ComputerName', '—'))}</div>
    <div><span>Operating system</span>{e(host.get('OS', '—'))}</div>
    <div><span>Assessed</span>{e(audit.get('generated', '—'))}</div>
    <div><span>Technician</span>{e(audit.get('technician', BRAND))}</div>
    <div><span>Authorization</span>{e(audit.get('authorization', '—'))}</div>
  </div>
</header>
""")

    # Summary cards
    p.append('<div class="cards">')
    p.append(f'<div class="card"><div class="n">{answer_counts["Yes"]}</div>'
             f'<div class="l">Controls in place</div></div>')
    p.append(f'<div class="card"><div class="n">'
             f'{answer_counts["Partial"] + answer_counts["No"]}</div>'
             f'<div class="l">Gaps to remediate</div></div>')
    p.append(f'<div class="card"><div class="n">'
             f'{answer_counts["Needs confirmation"]}</div>'
             f'<div class="l">Need confirmation</div></div>')
    p.append(f'<div class="card"><div class="n">{crit}</div>'
             f'<div class="l">Critical host findings</div></div>')
    p.append('</div>')

    p.append('<div class="intro">This report answers the questions on a '
             'typical small-business cyber-insurance application using the '
             'evidence collected by a read-only audit of this machine. '
             '<b>Answer honestly on your application</b> - a claim can be '
             'denied if answers do not match reality. Items marked '
             '<i>&ldquo;Needs confirmation&rdquo;</i> are controls a single '
             'host scan cannot verify (backups, email MFA, training, '
             'incident-response plan); Ark can confirm these in a short '
             'interview.</div>')

    # Questionnaire section
    p.append('<h2>Cyber-insurance questionnaire mapping</h2>')
    for item in questionnaire:
        fg, bg = ANSWER_COLORS.get(item["answer"], ANSWER_COLORS["Needs confirmation"])
        bar = fg
        assessed = ("Verified by host audit" if item.get("assessed")
                    else "Not host-verifiable - needs interview")
        rec_html = ""
        if item.get("recommendation"):
            rec_html = (f'<div class="rec"><b>Ark recommends:</b> '
                        f'{e(item["recommendation"])}</div>')
        p.append(f"""<div class="q" style="border-left-color:{bar}">
  <div class="head">
    <h3>{e(item['question'])}</h3>
    <span class="answer" style="background:{bg};color:{fg}">{e(item['answer'])}</span>
  </div>
  <div class="why">{e(item['why'])}</div>
  <div class="evidence"><b>Current status:</b> {e(item['evidence'])}</div>
  {rec_html}
  <div class="assessedtag">{e(assessed)}</div>
</div>""")

    # Full host findings
    p.append('<h2>Supporting host audit findings</h2>')
    p.append('<p style="color:var(--muted);font-size:13px;margin:0 0 8px">'
             'The complete read-only checkup of this machine. These back up '
             'the answers above and list additional hardening items.</p>')
    p.append('<div class="tablewrap"><table>')
    p.append('<tr><th>Check</th><th>Severity</th><th>Status</th>'
             '<th>Category</th></tr>')
    for f in findings_sorted:
        sev = sev_of(f)
        fg, bg, _ = SEV_COLORS.get(sev, SEV_COLORS["unknown"])
        p.append(f"""<tr>
  <td>{e(f.get('title', ''))}</td>
  <td><span class="badge" style="background:{bg};color:{fg}">{e(SEV_LABEL.get(sev, sev.upper()))}</span></td>
  <td>{e(f.get('status', ''))}</td>
  <td>{e(f.get('category', ''))}</td>
</tr>""")
    p.append('</table></div>')

    # Detail cards for anything not already "good"
    actionable = [f for f in findings_sorted if sev_of(f) != "good"]
    if actionable:
        p.append('<h2>Recommended remediation</h2>')
        for f in actionable:
            sev = sev_of(f)
            fg, bg, bar = SEV_COLORS.get(sev, SEV_COLORS["unknown"])
            rec = f.get("recommendation") or "Review this item."
            p.append(f"""<div class="finding" style="border-left-color:{bar}">
  <div class="row">
    <span class="badge" style="background:{bg};color:{fg}">{e(SEV_LABEL.get(sev, sev.upper()))}</span>
    <h3>{e(f.get('title',''))}</h3>
  </div>
  <p>{e(f.get('explanation',''))}</p>
  <div class="fix"><b>Recommendation:</b> {e(rec)}</div>
</div>""")

    # Note + footer
    p.append(f"""<div class="note">
  This assessment covers the single Windows host
  <b>{e(host.get('ComputerName', 'audited machine'))}</b>. A full
  cyber-insurance posture also depends on backups, email/identity MFA,
  staff training and an incident-response plan, which are confirmed
  separately. Answer your application based on your whole environment, not
  this one machine alone.
</div>""")
    p.append(f"""<footer>
  Generated by the Ark Field Kit <b>security</b> module for
  {e(client)} at {e(datetime.now().strftime('%Y-%m-%d %H:%M'))}.<br>
  Based on a read-only host audit. Keep this report with the signed
  authorization on file. &copy; {datetime.now().year} {e(BRAND)}.
</footer>""")
    p.append('</div></body></html>')
    return "\n".join(p)


def write_report(audit, questionnaire, slug, log):
    fieldkit.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = fieldkit.REPORT_DIR / f"{MODULE}-{slug}-{file_stamp()}.html"
    out.write_text(build_html(audit, questionnaire), encoding="utf-8")
    log.log(f"  Report written: {out}")
    return out


# --------------------------------------------------------------------------
# Sample audit dataset (offline self-test)
# --------------------------------------------------------------------------
def sample_audit():
    return {
        "schema": "ark-security-audit/1",
        "module": "security-audit",
        "generated": fieldkit.timestamp(),
        "site_name": "Demo Site (self-test)",
        "client": "Example Client LLC",
        "contact_name": "Pat Example",
        "technician": "Ark Web Solutions",
        "authorization": "SELF-TEST - no real machine was audited",
        "host": {
            "ComputerName": "FRONT-DESK-01",
            "UserName": "reception",
            "Elevated": True,
            "OS": "Microsoft Windows 11 Pro",
            "OSVersion": "10.0.22631 (build 22631)",
            "Manufacturer": "Dell Inc.",
            "Model": "OptiPlex 7090",
        },
        "summary": {"good": 5, "warn": 3, "critical": 3, "unknown": 1},
        "findings": [
            {"id": "defender_rtp", "title": "Endpoint protection (antivirus)",
             "category": "Endpoint protection", "severity": "good",
             "status": "On, definitions current",
             "explanation": "Microsoft Defender is running with real-time "
                            "protection on and recent virus definitions.",
             "recommendation": ""},
            {"id": "firewall", "title": "Host firewall",
             "category": "Network protection", "severity": "critical",
             "status": "Disabled on: Public",
             "explanation": "The Windows firewall is off for the Public "
                            "profile, so the machine accepts unsolicited "
                            "inbound connections on untrusted networks.",
             "recommendation": "Enable the firewall on all profiles "
                               "(Set-NetFirewallProfile -All -Enabled True)."},
            {"id": "bitlocker", "title": "Disk encryption at rest",
             "category": "Encryption", "severity": "critical",
             "status": "System drive NOT encrypted (FullyDecrypted / protection Off)",
             "explanation": "The system drive is not encrypted. If the device "
                            "is lost or stolen its data can be read directly.",
             "recommendation": "Enable BitLocker on the system drive and "
                               "escrow the recovery key."},
            {"id": "patching", "title": "Patch cadence (Windows Update)",
             "category": "Patch management", "severity": "warn",
             "status": "Last patched 61 days ago",
             "explanation": "The machine has not installed an update in over "
                            "45 days. Patch cadence should be monthly.",
             "recommendation": "Run Windows Update and enable automatic "
                               "updates."},
            {"id": "builtin_admin", "title": "Built-in Administrator account",
             "category": "Account hygiene", "severity": "warn",
             "status": "Built-in Administrator is ENABLED",
             "explanation": "The predictable built-in Administrator account is "
                            "active, a common brute-force target.",
             "recommendation": "Disable the built-in Administrator and use "
                               "named admin accounts."},
            {"id": "local_admins", "title": "Local administrator accounts",
             "category": "Account hygiene", "severity": "good",
             "status": "2 local administrator account(s)",
             "explanation": "The local Administrators group is a reasonable size.",
             "recommendation": ""},
            {"id": "rdp", "title": "Remote Desktop (RDP) exposure",
             "category": "Remote access", "severity": "critical",
             "status": "RDP is ENABLED with Network Level Authentication OFF",
             "explanation": "Remote Desktop accepts inbound connections without "
                            "Network Level Authentication. RDP is a leading "
                            "ransomware entry point.",
             "recommendation": "Disable RDP if unused; otherwise require NLA, "
                               "restrict to a VPN/jump host, and add MFA."},
            {"id": "smb1", "title": "SMBv1 file-sharing protocol",
             "category": "Legacy protocols", "severity": "good",
             "status": "SMBv1 is disabled",
             "explanation": "The obsolete SMBv1 protocol is turned off.",
             "recommendation": ""},
            {"id": "screenlock", "title": "Automatic screen lock",
             "category": "Account hygiene", "severity": "warn",
             "status": "Locks after 30 minutes (over 15)",
             "explanation": "The machine locks when idle but the timeout is "
                            "longer than the recommended 15 minutes.",
             "recommendation": "Reduce the inactivity lock to 15 minutes "
                               "or less."},
            {"id": "password_policy", "title": "Password policy",
             "category": "Account hygiene", "severity": "good",
             "status": "Minimum length 12, lockout enabled",
             "explanation": "The local password policy meets the recommended "
                            "baseline.",
             "recommendation": ""},
            {"id": "guest", "title": "Guest account",
             "category": "Account hygiene", "severity": "good",
             "status": "Guest account is disabled",
             "explanation": "The Guest account is disabled, as recommended.",
             "recommendation": ""},
            {"id": "autorun", "title": "AutoRun / AutoPlay for removable media",
             "category": "Legacy protocols", "severity": "unknown",
             "status": "AutoRun is not fully disabled",
             "explanation": "AutoRun/AutoPlay is not disabled for all drive "
                            "types; a malicious USB device can auto-execute.",
             "recommendation": "Set NoDriveTypeAutoRun to 255."},
            {"id": "domain", "title": "Domain / workgroup membership",
             "category": "Management", "severity": "warn",
             "status": "Workgroup / standalone: WORKGROUP",
             "explanation": "The machine is not domain-joined, so security "
                            "settings are managed one-by-one and can drift.",
             "recommendation": "Consider central management so policy is "
                               "applied consistently."},
        ],
    }


def run_self_test():
    slug = "selftest"
    log = fieldkit.Logger(MODULE, slug)
    log.log("SELF-TEST: rendering the insurance report from a bundled sample "
            "audit dataset (no machine, no network).")
    # Write the sample JSON next to the module so the operator can see the
    # exact input shape Invoke-SecurityAudit.ps1 produces.
    sample_path = Path(__file__).resolve().parent / "sample-audit.json"
    audit = sample_audit()
    sample_path.write_text(json.dumps(audit, indent=2), encoding="utf-8")
    log.log(f"  Sample audit JSON: {sample_path}")
    questionnaire = build_questionnaire(audit.get("findings", []))
    out = write_report(audit, questionnaire, slug, log)
    log.log(f"SELF-TEST complete: {len(questionnaire)} questionnaire items, "
            f"{len(audit['findings'])} host findings.")
    log.close()
    print(f"\nSelf-test report: {out}")
    return out


# --------------------------------------------------------------------------
# Config validation for a real run
# --------------------------------------------------------------------------
def load_audit(path, log):
    p = Path(path)
    if not p.exists():
        log.close()
        sys.exit(f"Audit JSON not found: {path}\n"
                 "Run Invoke-SecurityAudit.ps1 first to produce it.")
    try:
        # utf-8-sig tolerates the BOM that PowerShell's Out-File -Encoding UTF8 adds.
        audit = json.loads(p.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as ex:
        log.close()
        sys.exit(f"Audit JSON is not valid JSON: {ex}")
    if not isinstance(audit, dict) or "findings" not in audit:
        log.close()
        sys.exit("Audit JSON is missing the 'findings' array - is this a "
                 "file produced by Invoke-SecurityAudit.ps1?")
    if not isinstance(audit["findings"], list):
        log.close()
        sys.exit("Audit JSON field 'findings' must be a list.")
    return audit


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def build_parser():
    parser = fieldkit.base_parser(
        "Ark Field Kit - build a cyber-insurance readiness report from a "
        "security-audit JSON.")
    # config optional so --self-test runs standalone.
    for action in parser._actions:
        if action.dest == "config":
            action.nargs = "?"
            action.default = None
            action.help = ("path to your filled-in config JSON "
                           "(see config.example.json)")
    parser.add_argument("--audit", metavar="JSON",
                        help="path to the audit JSON from Invoke-SecurityAudit.ps1")
    parser.add_argument("--self-test", action="store_true",
                        help="render a demo report from a bundled sample "
                             "audit (no config, no machine) and exit")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.self_test:
        run_self_test()
        return 0

    if not args.config:
        sys.exit("No config given. Provide a config JSON, or use --self-test.\n"
                 "Copy config.example.json, fill it in, and pass its path.")
    if not args.audit:
        sys.exit("No --audit given. Point --audit at the JSON produced by "
                 "Invoke-SecurityAudit.ps1.")

    config = fieldkit.load_config(args.config, required=["site_name"])
    site_name = config["site_name"]
    slug = slugify(site_name)

    log = fieldkit.Logger(MODULE, slug)
    log.log(f"Building insurance report for: {site_name}")
    log.log(f"Reading audit JSON: {args.audit}")

    audit = load_audit(args.audit, log)

    # Config values override / fill the report header where the audit is thin.
    audit.setdefault("site_name", site_name)
    audit["site_name"] = config.get("site_name", audit.get("site_name"))
    if config.get("client"):
        audit["client"] = config["client"]
    if config.get("contact_name"):
        audit["contact_name"] = config["contact_name"]
    if config.get("technician"):
        audit["technician"] = config["technician"]
    if config.get("authorization"):
        audit["authorization"] = config["authorization"]

    questionnaire = build_questionnaire(audit.get("findings", []))
    log.log(f"  Mapped {len(questionnaire)} insurance questions.")
    out = write_report(audit, questionnaire, slug, log)
    log.close()
    print(f"\nReport complete: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
