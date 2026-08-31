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

## 7. Expansion menu — add-ons that fit a one-man, automation-heavy shop

Filter for everything below: sellable by one person, mostly produced by
Claude, no 24/7 obligation, and it either adds monthly recurring revenue or
wins the whole account. Phased by client count so the day job stays survivable.

### Phase 1 — sell from day one (no new infrastructure)

**Review engine — $75/mo add-on.** After each job, the client texts their
customer a review link (or we automate the send from their job sheet).
We draft owner responses to every review — good and bad — in the owner's
voice. Podium charges $300+/mo for this; at $75 it's a steal and it's
nearly all Claude-drafted. Reviews are THE local ranking factor, so it
also makes the Lighthouse plan visibly work.

**Google Business Profile management — $100/mo or bundled in Lighthouse.**
Weekly posts, photo uploads, Q&A answers, category/hours hygiene. For a
tradesman, GBP drives more calls than the website. ~20 min/client/week
with Claude drafting everything.

**Online booking setup — $150–300 one-time.** Square Appointments,
Calendly, or the trade's tool (Housecall Pro, Jobber) wired into the site's
CTA. Turns "call us" into booked jobs while they sleep; zero ongoing cost.

**Local SEO content — $200/mo add-on.** Two service-area or FAQ pages per
month ("Furnace repair in North Muskegon", "Why is my AC icing up?") written
with Claude, reviewed by the client in five minutes, published by us. This is
the highest-margin recurring item on the menu; the marginal cost is nearly zero.

### Phase 2 — at ~10 clients (needs your credentials, light process)

**Small-office security checkup — $400–800 one-time, $50/mo to keep it
current.** Password manager rollout, MFA on email and banking, router/WiFi
audit, backup verification, a one-page findings report. The AAS in IT
Security is the sales license here, and nobody else local is offering it
to 5-person businesses. Big unlock: **cyber-insurance questionnaires** —
insurers now demand MFA/backup/training answers that small businesses
can't fill out; charge $250 to get them through it, and the remediation
work sells itself.

**Business phone / VoIP setup — $250–500 one-time.** Google Voice or
RingCentral on their number, ring groups, voicemail-to-email. Natural for
a network tech; pairs with every website deal for businesses still giving
out personal cells.

**Email newsletter — $150/mo add-on.** Monthly customer newsletter
(seasonal reminders, offers) drafted by Claude, sent via a free-tier email
tool to their customer list. Restaurants, charters, and HVAC (tune-up
season!) all have natural calendars.

### Phase 3 — at ~20 clients or full-time (real commitments, price them in)

**Managed business network — $99–199/mo per site.** Router/AP/switch
management (UniFi or MikroTik), guest WiFi, camera VLANs, remote
monitoring — MSP-lite for shops and offices. Highest ceiling on this menu
and squarely your trade, but it carries on-site expectations, so gate it
behind quitting the day job. ⚠️ This overlaps Pure Broadband's business
most directly — clear the non-compete question BEFORE selling it, and
ideally sell it as the partnership instead.

**Site + booking + reviews bundles per niche.** Once 3+ clients in one
trade exist, productize: "the charter captain package", "the contractor
package" — fixed price, fixed scope, one-week delivery, because the
template and copy patterns already exist in this repo.

### Deliberately NOT on the menu

- **Google/Facebook ads management** — clients blame you for burned spend,
  results need budget they won't commit, and it's a monthly argument. Refer
  it out.
- **24/7 SLA / full MSP contracts** — one person cannot honor 2 a.m.
  obligations while employed. "Same-day response" is the ceiling until
  there are two of you.
- **Custom web apps / e-commerce builds** — quotes balloon, scope creeps,
  and one bad project eats a quarter. The exception: simple Square/Stripe
  payment links and gift cards (charters and restaurants love gift cards)
  — those are an hour of work, charge $150.

### What the math becomes

25 clients averaging $120/mo base ≈ $36k/yr. If 40% take one Phase-1
add-on (avg $115/mo), that's **+$13.8k/yr ≈ $50k recurring**, still on
free-tier infrastructure, before any Phase-3 network revenue. Add-ons are
also churn armor: a client paying for reviews + GBP + site has three
reasons to stay.

## 8. Automation roadmap (built here, with Claude)

- [x] Uptime + SSL-expiry monitor for all client domains (`tools/monitor.py`,
      cron-ready, phone alerts via ntfy.sh)
- [x] Domain-expiry watcher across the client portfolio (same tool, via RDAP)
- [x] Intake form → config JSON → generated draft site pipeline (`intake/`)
- [ ] Monthly client report generator (Lighthouse scores, uptime %, changes
      made) emailed automatically
- [ ] Stripe subscription setup for the three care plans
- [ ] Review-response drafter: paste new reviews, get on-voice replies to
      approve (powers the $75/mo review engine)
- [ ] GBP post generator: monthly batch of Google Business Profile posts
      per client from their config voice
- [ ] SEO content pipeline: service-area/FAQ page generator using each
      client's config + template (powers the $200/mo content add-on)
- [ ] Security checkup report template + checklist script (Phase 2)
