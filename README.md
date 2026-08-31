# Ark Web Solutions

A one-person web services company for small businesses in Muskegon, MI —
websites, hosting, DNS, and business email, sold as a monthly "it's handled" plan.

> **Brand note:** "Ark Web Solutions" is a working name. To rename, search-replace
> `Ark Web Solutions` across the repo (it appears only in `site/` and docs).

## What's in this repo

| Path | What it is |
|---|---|
| `site/` | The agency's own marketing website (static — deploy free on Cloudflare Pages) |
| `templates/business-site/` | Reusable client-site template with `{{PLACEHOLDERS}}` |
| `clients/` | Generated client sites, one folder each |
| `new_client.py` | Generates a new client site from a config JSON |
| `intake/` | Client intake form — fill it out during a walk-in, get the config JSON |
| `tools/monitor.py` | Uptime + SSL expiry + domain expiry monitor for all client sites |
| `docs/playbook.md` | The business plan: pricing, go-to-market, legal setup |
| `docs/runbooks/` | Step-by-step checklists for DNS/email setup and client onboarding |

## Quick start

Preview the agency site locally:

```bash
cd site && python3 -m http.server 8000
# open http://localhost:8000
```

Create a new client site:

```bash
# Option A: open intake/index.html in a browser, fill it out, download the JSON
# Option B: copy the example and edit by hand
cp templates/business-site/config.example.json clients/joes-hvac.json
# then:
python3 new_client.py clients/joes-hvac.json
# output lands in clients/joes-hvac/ — preview it the same way
```

Optional per-client fields: `hero_art` (an SVG file next to the config, inlined
into the hero), `badges`, `why_us`, `cta_heading`, and services as
`{"name", "desc"}` objects. See `clients/joes-hvac.json` for a full example.

Monitor client sites (cron this every 15 min once clients are live):

```bash
cp tools/sites.example.json tools/sites.json   # then edit with real sites
python3 tools/monitor.py                        # exit 1 + alert on any problem
NTFY_TOPIC=your-secret-topic python3 tools/monitor.py   # push alerts to your phone via ntfy.sh
```

## Deploying (free tier)

1. Push this repo to GitHub (done).
2. In Cloudflare Pages: **Create project → connect repo → build output directory: `site`**.
3. For each client site, create a separate Pages project pointed at `clients/<slug>/`,
   or drag-and-drop the folder. Attach the client's custom domain in Cloudflare.

See `docs/runbooks/dns-email-setup.md` for the domain/DNS/email checklist used
on every new client.
