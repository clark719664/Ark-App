# Business Playbook — Ark Web Solutions (Muskegon, MI)

Owner: Clark Langlois. This is the operating plan, tailored to Clark's actual
position: CCST-certified, AAS in Networking & IT Security (MCC, May 2026),
currently tech support / software engineering at a local ISP.

## 1. Positioning: you are not "a web designer"

Most local web designers can build a page but can't explain an MX record.
Clark's edge is the opposite and rarer combination: **networking, DNS, email
deliverability, and security are already his day job.** So the pitch is not
"I make websites" — it's:

> "One local guy handles everything about your business being online:
> website, domain, DNS, email, security. You call or text me and it's handled."

That's an MSP-lite, and it justifies a monthly fee the way a $12/mo
Squarespace plan never has to be defended.

## 2. Services and pricing

### One-time
| Service | Price |
|---|---|
| 1-page site (template-based, this repo) | $500–$900 |
| 4–6 page site | $1,500–$3,000 |
| Business email setup (Google Workspace + SPF/DKIM/DMARC) | $250 flat |
| Domain rescue / DNS migration | $150–$300 |

### Monthly care plans (the actual business)
| Plan | Price | Includes |
|---|---|---|
| **Dock** | $49/mo | Hosting, SSL, DNS management, domain renewal, uptime monitoring |
| **Harbor** | $129/mo | Dock + 1 hr of edits/mo, monthly report, email deliverability monitoring |
| **Lighthouse** | $249/mo | Harbor + SEO basics, Google Business Profile, priority same-day support |

Target: **25 clients averaging ~$120/mo = ~$36k/yr recurring** before any new
builds. Infrastructure cost at that scale: roughly $0–30/mo total
(Cloudflare Pages free tier, domains at cost).

## 3. Go-to-market: Muskegon specifically

1. **Niche first:** trades and lakeshore businesses — contractors, HVAC,
   plumbing, charters, marinas, restaurants. They have money, terrible or no
   websites, and they refer each other.
2. **Walk in, don't cold-email.** Bring a phone with their current site (or
   their absence from Google) pulled up next to a demo from this repo.
3. **Muskegon Lakeshore Chamber of Commerce** — join once revenue starts;
   their mixers are where trades owners actually are.
4. **The hook offer:** discounted first build ($500) *conditional on* a
   12-month care plan. The plan is the product; the build is the door.
5. **Monthly report = retention.** The automated Lighthouse/uptime report
   (roadmap below) is what makes the fee feel obviously worth it.

## 4. The Pure Broadband question — handle this carefully

Clark's employer serves the exact businesses this company would sell to.
Two rules and one opportunity:

- **Read your employment agreement before signing your first client.** Look
  for non-compete, non-solicitation, and IP-assignment clauses. Don't build
  this business on company time or company equipment — this repo and all
  work on it should live on personal accounts and personal hardware only.
- **Never poach a contact you met through work.** Besides the legal risk,
  Muskegon is a small town.
- **The opportunity:** pitch the IT Director / owner on a *partnership* —
  Pure Broadband resells "website + email setup" to its business customers,
  Clark fulfills it, revenue is shared. The ISP adds a product with zero
  effort; Clark gets warm leads with permission instead of a conflict.

## 5. Legal & money setup (Michigan)

1. **LLC via Michigan LARA** — file Articles of Organization online, $50.
   Annual statement is $25/yr, due Feb 15.
2. **EIN** — free, 10 minutes, irs.gov.
3. **Business checking account** — keep money separate from day one.
4. **Stripe** — invoicing + subscriptions for the care plans.
5. **Service agreement** — one-page contract covering scope, payment,
   and ownership. Non-negotiable term: **the client owns their domain,
   registered in their name, with Ark as technical manager.** It builds
   trust, it's the ethical default, and it kills the single ugliest
   dispute in this industry.
6. Have a lawyer review the contract once (~$300–500 one time).

## 6. First 90 days

- **Weeks 1–2:** LLC + EIN + bank + Stripe. Deploy the agency site in this
  repo to Cloudflare Pages on a real domain. Generate 2–3 fictional demo
  sites as the portfolio.
- **Weeks 3–8:** 20 walk-ins. Goal: 3 paying clients on care plans. Keep the
  day job — this is nights and weekends until recurring revenue covers rent.
- **Weeks 9–12:** Ask every client for one referral. Build the monthly
  report automation. Raise build prices as the calendar fills.

## 7. Automation roadmap (built here, with Claude)

- [ ] Uptime + SSL-expiry monitor for all client domains (Python, runs on a
      cron, texts Clark on failure)
- [ ] Domain-expiry watcher across the client portfolio
- [ ] Monthly client report generator (Lighthouse scores, uptime %, changes
      made) emailed automatically
- [ ] Stripe subscription setup for the three care plans
- [ ] Intake form → config JSON → generated draft site pipeline
