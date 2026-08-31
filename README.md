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
cp templates/business-site/config.example.json clients/joes-hvac.json
# edit the JSON with the client's details, then:
python3 new_client.py clients/joes-hvac.json
# output lands in clients/joes-hvac/ — preview it the same way
```

## Deploying (free tier)

1. Push this repo to GitHub (done).
2. In Cloudflare Pages: **Create project → connect repo → build output directory: `site`**.
3. For each client site, create a separate Pages project pointed at `clients/<slug>/`,
   or drag-and-drop the folder. Attach the client's custom domain in Cloudflare.

See `docs/runbooks/dns-email-setup.md` for the domain/DNS/email checklist used
on every new client.
