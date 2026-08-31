"""Shared helpers for Ark Field Kit Python tools. Standard library only.

Provides the conventions every tool follows: authorization banner, dry-run
gating, config loading with validation, and timestamped logging.
"""

import argparse
import ipaddress
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = KIT_ROOT / "logs"
REPORT_DIR = KIT_ROOT / "reports"

BANNER = r"""
  ┌──────────────────────────────────────────────────────────┐
  │  ARK FIELD KIT — authorized IT service work only          │
  │  Run only on equipment you have permission to service.    │
  └──────────────────────────────────────────────────────────┘
"""


def timestamp() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


def date_slug() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y%m%d")


class Logger:
    """Writes to stdout and appends to a per-run log file."""

    def __init__(self, module: str, slug: str):
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.path = LOG_DIR / f"{module}-{slug}-{date_slug()}.log"
        self._fh = self.path.open("a", encoding="utf-8")
        self.log(f"=== {module} run for '{slug}' at {timestamp()} ===")

    def log(self, msg: str = "") -> None:
        print(msg)
        self._fh.write(msg + "\n")
        self._fh.flush()

    def close(self) -> None:
        self._fh.close()


def confirm_authorization(args, site_name: str, log: Logger) -> None:
    """Print the banner and require authorization before doing anything."""
    print(BANNER)
    if getattr(args, "authorized", None):
        log.log(f"Authorization on file: {args.authorized}")
        return
    print(f"  Target site: {site_name}")
    print("  Confirm you have the client's authorization to perform this work.")
    try:
        answer = input("  Type 'yes' to proceed: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = ""
    if answer != "yes":
        print("  Not authorized — aborting.")
        sys.exit(2)
    log.log("Authorization confirmed interactively by operator.")


def load_config(path: str, required: list) -> dict:
    p = Path(path)
    if not p.exists():
        sys.exit(f"Config not found: {path}\nCopy the module's config.example.* and fill it in.")
    try:
        config = json.loads(p.read_text())
    except json.JSONDecodeError as e:
        sys.exit(f"Config is not valid JSON: {e}")
    missing = [k for k in required if k not in config or config[k] in (None, "")]
    if missing:
        sys.exit(f"Config is missing required fields: {', '.join(missing)}")
    return config


def base_parser(description: str) -> argparse.ArgumentParser:
    """Argument parser preloaded with the standard field-kit flags."""
    p = argparse.ArgumentParser(description=description)
    p.add_argument("config", help="path to your filled-in config JSON")
    p.add_argument("--apply", action="store_true",
                   help="execute for real (default is a safe dry run)")
    p.add_argument("--yes", action="store_true",
                   help="skip confirmation prompts for destructive steps")
    p.add_argument("--authorized", metavar="NOTE",
                   help='record signed authorization, e.g. "Joe\'s HVAC / 2026-01-04"')
    return p


def private_hosts(cidr: str):
    """Yield host IPs for a CIDR, refusing public ranges by default."""
    net = ipaddress.ip_network(cidr, strict=False)
    if not net.is_private:
        raise ValueError(f"{cidr} is not a private (RFC-1918) range — refusing to scan.")
    return net.hosts()


def mode_label(apply: bool) -> str:
    return "APPLY (making real changes)" if apply else "DRY RUN (no changes)"
