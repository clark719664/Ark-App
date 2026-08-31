#!/usr/bin/env python3
"""Tests for new_client.py — run with: python3 -m unittest discover tests -v"""

import json
import shutil
import subprocess
import sys
import unittest
from html.parser import HTMLParser
from pathlib import Path

REPO = Path(__file__).parent.parent
sys.path.insert(0, str(REPO))
import new_client  # noqa: E402

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input",
              "link", "meta", "source", "track", "wbr"}


class TagBalanceChecker(HTMLParser):
    """Fails on mismatched or unclosed non-void tags."""

    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if not self.stack:
            self.errors.append(f"closing </{tag}> with empty stack")
        elif self.stack[-1] != tag:
            self.errors.append(f"expected </{self.stack[-1]}>, got </{tag}>")
        else:
            self.stack.pop()


def base_config(**overrides) -> dict:
    config = {
        "slug": "test-client",
        "business_name": "Test Business",
        "tagline": "A tagline",
        "headline": "A headline",
        "meta_description": "A description",
        "cta_label": "Call now",
        "phone": "(231) 555-0100",
        "email": "test@example.com",
        "address": "1 Main St, Muskegon, MI 49440",
        "maps_url": "https://maps.google.com/?q=1+Main+St",
        "city": "Muskegon, MI",
        "hours": "Mon-Fri: 9-5",
        "about": "About text.",
        "services": ["Service one", "Service two"],
        "color_primary": "#123456",
        "color_accent": "#abcdef",
    }
    config.update(overrides)
    return config


class GeneratorTest(unittest.TestCase):
    def setUp(self):
        self.workdir = REPO / "clients"
        self.slug = "test-client"
        self.config_path = self.workdir / f"{self.slug}.json"
        self.out_dir = self.workdir / self.slug
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.config_path.unlink(missing_ok=True)
        (self.workdir / f"{self.slug}-art.svg").unlink(missing_ok=True)
        shutil.rmtree(self.out_dir, ignore_errors=True)

    def generate(self, config: dict) -> str:
        self.config_path.write_text(json.dumps(config))
        result = subprocess.run(
            [sys.executable, str(REPO / "new_client.py"), str(self.config_path)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        return (self.out_dir / "index.html").read_text()

    # ---- happy path ----

    def test_generates_complete_site(self):
        html = self.generate(base_config())
        for expected in ["Test Business", "A headline", "(231) 555-0100",
                         "tel:+12315550100", "Service one"]:
            self.assertIn(expected, html)
        self.assertNotRegex(html, r"\{\{[A-Z_]+\}\}")
        for f in ["index.html", "style.css", "script.js"]:
            self.assertTrue((self.out_dir / f).exists(), f"missing {f}")

    def test_html_is_well_formed(self):
        html = self.generate(base_config())
        checker = TagBalanceChecker()
        checker.feed(html)
        self.assertEqual(checker.errors, [])
        self.assertEqual(checker.stack, [], f"unclosed tags: {checker.stack}")

    def test_internal_anchors_resolve(self):
        import re
        html = self.generate(base_config())
        ids = set(re.findall(r'id="([^"]+)"', html))
        for anchor in set(re.findall(r'href="#([^"]+)"', html)):
            self.assertIn(anchor, ids, f"#{anchor} link has no target")

    # ---- optional-field behavior ----

    def test_defaults_for_optional_fields(self):
        html = self.generate(base_config())
        self.assertIn("Licensed &amp; insured", html)          # default badge
        self.assertIn("Ready to get started?", html)           # default CTA heading
        self.assertIn('class="wrap hero-grid"', html)          # no art -> no has-art

    def test_custom_optional_fields(self):
        html = self.generate(base_config(
            badges=["Badge A", "Badge B", "Badge C"],
            why_us=["Reason 1", "Reason 2", "Reason 3"],
            cta_heading="Custom CTA",
        ))
        for expected in ["Badge A", "Reason 2", "Custom CTA"]:
            self.assertIn(expected, html)
        self.assertNotIn("Ready to get started?", html)

    def test_service_objects_with_descriptions(self):
        html = self.generate(base_config(
            services=[{"name": "Named service", "desc": "Its description"}, "Plain service"]
        ))
        self.assertIn('<span class="svc-name">Named service</span>', html)
        self.assertIn('<span class="svc-desc">Its description</span>', html)
        self.assertIn('<span class="svc-name">Plain service</span>', html)

    def test_hero_art_inlined(self):
        art = (self.workdir / f"{self.slug}-art.svg")
        art.write_text('<svg viewBox="0 0 520 400" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="5"/></svg>')
        html = self.generate(base_config(hero_art=f"{self.slug}-art.svg"))
        self.assertIn("hero-grid has-art", html)
        self.assertIn('<circle cx="10"', html)

    # ---- hostile input ----

    def test_ampersands_and_quotes_are_escaped(self):
        html = self.generate(base_config(
            business_name="Rosie's Bread & Butter",
            tagline='She said "the best" & meant it',
            meta_description='Bread & butter "daily" in Muskegon',
        ))
        self.assertIn("Rosie&#x27;s Bread &amp; Butter", html)
        self.assertNotIn('content="Bread & butter "daily"', html)
        checker = TagBalanceChecker()
        checker.feed(html)
        self.assertEqual(checker.errors, [])

    def test_angle_brackets_do_not_inject_markup(self):
        html = self.generate(base_config(about="Fast <b>bold</b> claims <script>alert(1)</script>"))
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_missing_required_key_fails_loudly(self):
        config = base_config()
        del config["phone"]
        self.config_path.write_text(json.dumps(config))
        result = subprocess.run(
            [sys.executable, str(REPO / "new_client.py"), str(self.config_path)],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("phone", result.stdout + result.stderr)

    # ---- phone normalization ----

    def test_phone_raw_formats(self):
        cases = {
            "(231) 555-0147": "+12315550147",
            "231-555-0147": "+12315550147",
            "231.555.0147": "+12315550147",
            "2315550147": "+12315550147",
            "1-231-555-0147": "+12315550147",
        }
        for raw, expected in cases.items():
            self.assertEqual(new_client.phone_raw(raw), expected, msg=raw)


if __name__ == "__main__":
    unittest.main()
