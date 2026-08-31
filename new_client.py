#!/usr/bin/env python3
"""Generate a client site from the business-site template.

Usage:
    python3 new_client.py clients/joes-hvac.json

Reads the config JSON, fills the {{PLACEHOLDERS}} in templates/business-site/,
and writes the finished site to clients/<slug>/.
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).parent
TEMPLATE_DIR = REPO / "templates" / "business-site"
CLIENTS_DIR = REPO / "clients"

REQUIRED = [
    "slug", "business_name", "tagline", "headline", "meta_description",
    "cta_label", "phone", "email", "address", "maps_url", "city",
    "hours", "about", "services", "color_primary", "color_accent",
]


DEFAULT_BADGES = ["Licensed & insured", "Locally owned", "Free estimates"]
DEFAULT_WHY_US = [
    "Straight answers and upfront pricing",
    "We show up when we say we will",
    "Work done right the first time",
]


def phone_raw(phone: str) -> str:
    """(231) 555-0147 -> +12315550147"""
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 10:
        digits = "1" + digits
    return "+" + digits


def services_html(services: list) -> str:
    """Items are either strings or {"name": ..., "desc": ...} objects."""
    lines = []
    for s in services:
        if isinstance(s, dict):
            lines.append(
                f'        <li><span class="svc-name">{s["name"]}</span>'
                f'<span class="svc-desc">{s["desc"]}</span></li>'
            )
        else:
            lines.append(f'        <li><span class="svc-name">{s}</span></li>')
    return "\n".join(lines)


def list_html(items: list[str], indent: str = "          ") -> str:
    return "\n".join(f"{indent}<li>{i}</li>" for i in items)


def hero_art_html(config: dict, config_path: Path) -> tuple[str, str]:
    """Returns (layout_class, art_block). hero_art names an SVG file next to the config."""
    art_file = config.get("hero_art")
    if not art_file:
        return "hero-grid", ""
    svg = (config_path.parent / art_file).read_text().strip()
    return "hero-grid has-art", f'      <div class="hero-art" aria-hidden="true">\n{svg}\n      </div>'


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)

    config_path = Path(sys.argv[1])
    config = json.loads(config_path.read_text())

    missing = [k for k in REQUIRED if k not in config]
    if missing:
        sys.exit(f"Config is missing keys: {', '.join(missing)}")

    layout_class, art_block = hero_art_html(config, config_path)

    replacements = {
        "{{HERO_LAYOUT_CLASS}}": layout_class,
        "{{HERO_ART}}": art_block,
        "{{BADGES_HTML}}": list_html(config.get("badges", DEFAULT_BADGES)),
        "{{WHY_US_HTML}}": list_html(config.get("why_us", DEFAULT_WHY_US)),
        "{{CTA_HEADING}}": config.get("cta_heading", "Ready to get started?"),
        "{{BUSINESS_NAME}}": config["business_name"],
        "{{TAGLINE}}": config["tagline"],
        "{{HEADLINE}}": config["headline"],
        "{{META_DESCRIPTION}}": config["meta_description"],
        "{{CTA_LABEL}}": config["cta_label"],
        "{{PHONE}}": config["phone"],
        "{{PHONE_RAW}}": phone_raw(config["phone"]),
        "{{EMAIL}}": config["email"],
        "{{ADDRESS}}": config["address"],
        "{{MAPS_URL}}": config["maps_url"],
        "{{CITY}}": config["city"],
        "{{HOURS}}": config["hours"],
        "{{ABOUT}}": config["about"],
        "{{SERVICES_HTML}}": services_html(config["services"]),
        "{{COLOR_PRIMARY}}": config["color_primary"],
        "{{COLOR_ACCENT}}": config["color_accent"],
        "{{YEAR}}": str(date.today().year),
    }

    out_dir = CLIENTS_DIR / config["slug"]
    out_dir.mkdir(parents=True, exist_ok=True)

    for template_file in TEMPLATE_DIR.iterdir():
        if template_file.name == "config.example.json":
            continue
        text = template_file.read_text()
        for placeholder, value in replacements.items():
            text = text.replace(placeholder, value)
        leftover = re.findall(r"\{\{[A-Z_]+\}\}", text)
        if leftover:
            sys.exit(f"Unfilled placeholders in {template_file.name}: {leftover}")
        (out_dir / template_file.name).write_text(text)

    print(f"Site generated: {out_dir}/")
    print(f"Preview: cd {out_dir} && python3 -m http.server 8000")


if __name__ == "__main__":
    main()
