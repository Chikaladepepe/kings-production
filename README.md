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

**Accounts that matter.** Register an account or **sign in with Google** in
one click (a Google button appears on the login and signup pages once the
OAuth keys are configured). Every new registration requires accepting the
**Privacy Policy and Terms of Use** — a checkbox on both the signup and login
forms, enforced by the server and recorded on your account. Enable
**two-factor authentication** and recover your account through password
reset. The first registered user becomes an Admin, who then manages roles and
moderation from a dedicated Admin Panel.

**Creators are the heart of it.** Members can browse, comment, review, and
purchase. VIP / Licensed creators post assets — every submission enters the
**approval queue**, and admins approve or reject with a reason. A **24-hour
posting cooldown** keeps the marketplace fresh: creators can post one new
asset per day (admins are exempt), with the countdown shown right on the
upload page.

**Posts that sell.** Every asset is **clickable** — open the full description,
like it, and leave **star-rated comments** (only verified buyers can rate and
comment, so every piece of feedback is real). The front page and shop offer
**Trending, Newest, and Top-selling** sort options.

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
and timeouts for repeat offenders, and full protection for staff accounts.

**A real role hierarchy.** Accounts carry one of five roles — **Member**,
**VIP / Licensed**, **Admin**, **Co-Founder**, or **Owner** — each shown as a
badge next to the name across the whole site. Owner and Co-Founder can do
everything, Admin can do everything except grant roles at Admin level or
higher, VIP / Licensed creators can post, and Members browse, buy, and rate.
Staff go to **any profile** (even their own) and open the *Manage roles &
tags* panel to change someone's role or add up to six extra display tags —
like `#VIP`, `#Founder`, `#Designer` — which render as badges everywhere.
The studio **Owner account** is recognized by identity and bypasses every
permission gate — it can change its own role and tags, moderate any staff
member, and grant any role without ever being locked out, and it is restored
to Owner on every boot.

**A live status badge.** A small pill in the corner pings the server so
buyers always know the site's state: a green **Online · Ready** dot when it's
awake, an amber **Waking up…** pulse while a sleeping instance spins back up,
and a grey **Asleep** state when it's idle.

**Studio showcase.** Meet the team behind the studio on the Creators page and
browse the studio's own shipped projects on the Portfolio page. The portfolio
is **admin-published only** — admins post projects with auto-detected brand
links (Discord, YouTube, Twitch, X, Roblox, MediaFire, GitHub, Spotify,
Telegram, Drive and more render as their own icons) and a live cover-image
preview. One project can be pinned as the **★ Spotlight** — it renders larger
at the top of the portfolio, and only one can be featured at a time.

---

## Design

A dark, premium theme — deep blacks lit by a living ambient glow (slowly
drifting gold and violet light with a faint grid), glassmorphic cards and
header, a shimmering gradient headline, and a floating social dock
(Discord · YouTube · legal) plus the live server-status pill that stay with
you on every page. The auth pages are a royal split layout with a glowing
brand panel and a one-click **Continue with Google** button.

The site opens with an animated **loading screen** — the crown spinning in a
ring of gold light above the studio tagline — and then stays alive: a soft
gold glow follows your cursor, light particles drift up through the hero,
cards tilt gently in 3D as you move over them, buttons sweep with light,
sections reveal on scroll, and the headline stats count up as they appear.

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
