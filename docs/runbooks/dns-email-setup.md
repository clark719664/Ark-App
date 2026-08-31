# Runbook: Domain, DNS & Email Setup (every new client)

Goal: client-owned domain, Cloudflare-managed DNS, working site + email with
clean deliverability. Budget ~45 minutes once practiced.

## 1. Domain

- [ ] Register (or transfer) the domain **in the client's name** at Cloudflare
      Registrar (at-cost pricing, free WHOIS privacy).
- [ ] Client's own email as the account owner; add yourself as a member with
      DNS edit rights. Record the registrar login location in the client sheet.
- [ ] Auto-renew ON. Confirm the renewal card is the client's, not yours.

## 2. DNS (Cloudflare)

- [ ] Site: `CNAME @ -> <pages-project>.pages.dev` (proxied) and
      `CNAME www -> @` (proxied), or per host instructions.
- [ ] SSL/TLS mode: **Full (strict)**.
- [ ] Enable "Always Use HTTPS".
- [ ] If migrating: export the old zone file FIRST, screenshot existing
      records, and keep old hosting live until the new site is verified.

## 3. Email (Google Workspace Starter, $7/user/mo — bill client directly)

- [ ] Create the Workspace, verify the domain via TXT record.
- [ ] MX records: Google's standard set (or the single
      `smtp.google.com` record on new accounts).
- [ ] **SPF** — TXT on `@`: `v=spf1 include:_spf.google.com ~all`
      (one SPF record only; merge if others exist).
- [ ] **DKIM** — generate the 2048-bit key in Workspace Admin, add the
      `google._domainkey` TXT record, then click Start Authentication.
- [ ] **DMARC** — TXT on `_dmarc`:
      `v=DMARC1; p=quarantine; rua=mailto:dmarc@<clientdomain>` —
      start with `p=none` for a week on domains with existing mail flows.
- [ ] Send a test to a Gmail address; open "Show original" and confirm
      SPF=PASS, DKIM=PASS, DMARC=PASS.

## 4. Verify & record

- [ ] Site loads on `https://domain` and `https://www.domain`.
- [ ] `dig +short MX <domain>` and `dig +short TXT <domain>` match the plan.
- [ ] SSL Labs grade A.
- [ ] Log everything (registrar, DNS host, email tenant, record set) in the
      client sheet. This documentation IS the care-plan deliverable.
