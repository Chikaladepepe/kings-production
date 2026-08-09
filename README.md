# 👑 Kings Production

**“Where Excellence Meets Innovation.”**

Kings Production is a premium Roblox development studio and asset marketplace.
This is the official home of the studio — a place where creators ship their
work and builders find ready-to-use scripts, models, plugins, animations, and
systems, all reviewed and approved by the Kings Production team.

Live at **https://kingsproduction.cc**

---

## What the site offers

**A real marketplace.** Browse the catalog by category (Animation, Model,
Plugin, System), search, and see top-selling assets ranked by sales. Every
upload goes through a **review process** before it goes live, so what you buy
is quality-checked.

**Accounts that matter.** Register an account, log in securely, enable
**two-factor authentication**, and recover your account through password
reset. The first registered user becomes an Admin, who then manages roles and
moderation from a dedicated Admin Panel.

**Creators are the heart of it.** Members can browse, comment, review, and
purchase. VIP / Licensed creators post assets — every submission enters the
**approval queue**, and admins approve or reject with a reason. A **24-hour
posting cooldown** keeps the marketplace fresh: creators can post one new
asset per day (admins are exempt), with the countdown shown right on the
upload page.

**Posts that rank.** Every asset is **clickable** — open the full description,
like it, and leave **star-rated comments** (comments require a 1–5 star pick
before posting, so every piece of feedback feeds the asset's score). The more
likes and the higher the ratings, the higher the post ranks: the front page
and shop are sorted by a **trending score** (likes + ratings + sales, decayed
by age), with Newest and Top-selling sort options too.

**A Creator Dashboard for VIP / Licensed +.** A dedicated dashboard tab
shows your **sales graph** (revenue per day over the last 30 days), your
license keys, and device-level security for everything you post.

**Purchases with license keys — and a VIP upgrade included.** Buying any asset
issues a **license key** tied to your account, and **instantly upgrades your
account to VIP / Licensed** — meaning you can start posting and selling your
own assets right after your first purchase. Assign your key to your own Roblox
game from the License page, and download your file whenever you need it.

**License security — advanced protection for your files.** Even if a file
gets leaked, the key inside it stays bound to the buyer: nobody else can use
it. Your asset's file can call the **activation API** on first run and send a
**heartbeat** while running, so creators see exactly which devices are using
their work. From the Dashboard, a creator can **disable a license** (the kill
switch — the file refuses to run everywhere) or **revoke a single device**
(that device alone is cut off on its next check). Unauthorized devices get
`denied` and the file shuts itself down.

**Payments: Stripe · PayPal · GCash.** Checkout is powered by **Stripe**
(cards), **PayPal**, and **GCash** (via PayMongo). Choose your method at
checkout, pay, and the license + VIP upgrade are issued the moment payment
confirms. Until a payment gateway is connected, checkout runs in **test mode**
and completes instantly without moving money.

**Regional pricing.** Asset prices are stored in **USD** and shown in each
buyer's own currency — pick your country when you create your account (or
change it anytime in Settings), and every price on the site converts to your
local currency with live exchange rates.

**Post with an image link, not a file.** Creators post assets by pasting a
direct image URL for the cover — no upload, no storage cost. Attaching the
actual downloadable file is optional.

**Built by the community, for the community.** Every asset, comment, and
profile has a **report** action so the team can act on misconduct — with bans
and timeouts for repeat offenders, and full protection for admin accounts.

**Studio showcase.** Meet the team behind the studio on the Creators page and
browse the studio's own shipped projects on the Portfolio page.

---

## Design

A dark, premium theme — deep blacks and gradients lit by ambient gold
glow, the crown as the light source, light-catching surfaces, and a floating
social dock (Discord · YouTube · legal) that stays with you on every page.
Clean, fast, and built to feel like a high-end studio, not a template.

The site opens with an animated **loading screen** — the crown spinning in a
ring of gold light above the studio tagline — and then stays alive: a soft
gold glow follows your cursor, light particles drift up through the hero,
cards tilt gently in 3D as you move over them, buttons sweep with light, and
the headline stats count up as they appear.

## Technology

Built as a modern full-stack app: a **Node.js / Express** API with a **SQLite**
database (pluggable to **Turso** cloud storage), uploads on disk or **Cloudflare
R2**, and a single-file, dependency-free frontend that shares one business-logic
engine between the server and the browser — so every feature works the same
everywhere. Passwords are salted and hashed; sessions are secure tokens; 2FA is
RFC 6238 TOTP.

## Legal

- [Privacy Policy](https://kingsproduction.cc/#/privacy) — including our
  **no-scraping promise**: we are aware of the Roblox Terms of Use and never
  collect any data from Roblox or Roblox users.
- [Terms of Use](https://kingsproduction.cc/#/terms) — how accounts, the
  marketplace, purchases, and licensing work.

---

© Kings Production · Premium Roblox development studio.
