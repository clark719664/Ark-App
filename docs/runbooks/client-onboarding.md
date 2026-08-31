# Runbook: New Client Onboarding

## 1. Sale
- [ ] Signed service agreement (scope, price, care plan term, client owns domain).
- [ ] Collect build deposit (50%) + first month via Stripe before work starts.

## 2. Intake (one 30-minute conversation, on-site if possible)
Collect into a config JSON (`templates/business-site/config.example.json`):
- [ ] Business name, tagline, what they want customers to DO (call? book? visit?)
- [ ] Phone, email, address, hours
- [ ] Services list (3–6, in the customer's words, not jargon)
- [ ] 5–10 photos taken on-site with a phone — real photos of real work beat
      stock photos for local trust
- [ ] Existing domain/logins if any (see DNS runbook before touching them)

## 3. Build
- [ ] `python3 new_client.py clients/<slug>.json`
- [ ] Drop photos in, adjust copy, tune the two theme colors to their branding.
- [ ] Send preview link. **One revision round included** — say so upfront.

## 4. Launch
- [ ] Run `docs/runbooks/dns-email-setup.md` end to end.
- [ ] Submit sitemap in Google Search Console; create/claim Google Business
      Profile and link the site.
- [ ] Collect final payment. Start care-plan subscription in Stripe.

## 5. Handoff & retention
- [ ] One-page summary email: what was built, where everything lives, what
      the plan covers, how to request changes (text/call/email).
- [ ] Calendar reminder: 30-day check-in call.
- [ ] Ask for a Google review + one referral at the 30-day call, not before.
