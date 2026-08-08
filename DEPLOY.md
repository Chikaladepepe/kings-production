# Deploying Kings Production — and putting it live on your own domain

This runbook takes the app from this folder to a **live site on
`https://kingsproduction.cc`** with the APIs and marketplace running, in 5 steps:

0. Push the project to GitHub
1. Choose a host and start the app
2. Connect `kingsproduction.cc` through Cloudflare
3. Configure the domain-wide settings (HTTPS, PUBLIC_URL, email)
4. Verify everything works from the live domain

> **What the app is:** one Node process serving the SPA (`index.html`) and the
> `/api/*` surface. Storage is pluggable: the database is **local SQLite** by
> default or **Turso** (free cloud SQLite) when `TURSO_URL` is set; uploads are
> **local disk** by default or **Cloudflare R2** when `R2_*` vars are set. Any
> platform that can run `node server.js` works. Requirements: **Node ≥ 23.4**
> (`node:sqlite` is built in and unflagged) or Node 22.13+ with
> `NODE_OPTIONS=--experimental-sqlite node server.js`. Node 24 is ideal.

---

## Step 0 — Push the project to GitHub

The folder is not a git repository yet, so initialize one and push. (These
commands run on YOUR machine — Git and the GitHub CLI are required.)

```bash
cd kings-production

# 1. init + first commit
git init
git add .
git commit -m "Kings Production — Node/Express + SQLite asset marketplace"

# 2. create the remote repo (GitHub CLI) and push
gh repo create kings-production --public --source=. --push
#    ↑ creates github.com/<you>/kings-production and pushes the code
```

No GitHub CLI? Create an empty repo in the GitHub web UI (do **not** tick
"Add a README"), then:

```bash
git remote add origin https://github.com/<you>/kings-production.git
git branch -M main
git push -u origin main
```

> `node_modules/`, `data/`, and `uploads/` are already in `.gitignore` — the
> repo contains only source code, never the database or uploads.

---

## Step 1 — Choose a host and start the app

Pick one. **Render is the fastest for the free tier**; Fly is the best value
for persistent storage + a custom Dockerfile.

| Host | Repo hook | Disk (persistent DB/uploads) | Cost |
| ---- | --------- | ---------------------------- | ---- |
| Render (blueprint `render.yaml`) | ✓ auto-deploy on push | ⚠ no disk on free tier (data resets on redeploy); disk on paid plans | free tier |
| Railway (`npm start`) | ✓ auto-deploy | ✓ volumes | paid |
| Fly.io (`Dockerfile`) | ✓ | ✓ volumes | pay-as-you-go |
| Any VPS (`node server.js`) | manual | your own disk | your server |

### Render (recommended free start)

1. In Render: **New → Blueprint**, choose the repo. It reads `render.yaml`
   automatically (build `npm install`, start `node server.js`, health check
   `/api/health`).
2. Render gives you `https://kings-production.onrender.com`. Open it, register —
   **the first account becomes Admin**.
3. Keep Render auto-deploy on: every `git push` redeploys.

> ⚠️ **Free tier has no persistent disk.** The database (`data/`) and uploads
> (`data/uploads`) live on an **ephemeral disk that resets on every redeploy**
> (and Render may recycle the instance at any time). Great for trying the app;
> **not** for real customers yet. Two ways to make data permanent:
> - **Recommended, free forever:** point the app at **Turso** (cloud SQLite)
>   and **Cloudflare R2** (object storage) — see the section below. No monthly
>   bill, no code changes needed (the app already supports both).
> - **Upgrade the Render service to a paid plan** and uncomment the `disk:`
>   block in `render.yaml` (one redeploy; the blueprint provisions a 1 GB disk
>   at `/opt/render/project/src/data`).
>
> Also on the free tier, the service **spins down after ~15 minutes of
> inactivity** — the first visit after idle takes 30–60 s to wake up. That's
> normal, not a crash.

#### Free forever storage: Turso (database) + Cloudflare R2 (uploads)

The app auto-detects these env vars — when set, the database and uploads live
in the cloud and survive redeploys, restarts, and instance recycling.

**1. Create the Turso database (the DB):**

1. Go to **https://turso.tech** → **Sign up** (GitHub login is fastest).
2. In the dashboard click **Create database** → name it `kings-production` →
   **Create**. Pick a location close to you.
3. On the database page, copy the **database URL** (starts with
   `libsql://…`) → that's `TURSO_URL`.
4. Click **Settings / Tokens** → **Generate token** (type: *Read/write*) →
   copy it → that's `TURSO_AUTH_TOKEN`. Store it somewhere safe.

**2. Create the Cloudflare R2 bucket (the uploads):**

1. Cloudflare dashboard → **R2** → **Create bucket** → name it
   `kings-production-uploads` (any name) → **Create**. *(R2 gives 10 GB for
   free with zero egress fees.)*
2. **Manage R2 API Tokens** → **Create API token** → permission **Object
   Read & Write** → **Create**. Copy the **Access Key ID** and **Secret
   Access Key** (shown once).
3. Your **Account ID** is on the R2 overview page (top-right).

**3. Point Render at them:**

Render → your service → **Environment**, add (then the service redeploys
automatically):

```
TURSO_URL=libsql://your-db-your-org.turso.io
TURSO_AUTH_TOKEN=eyJ...
R2_ACCOUNT_ID=<your Cloudflare account id>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=kings-production-uploads
```

Verify: open `https://your-service.onrender.com/api/health` → `"store":"turso"`.
Every write is confirmed persisted to Turso before the API answers, so
purchases and registrations survive even if Render restarts the app.

> Note: the cloud store keeps a full in-memory cache, so this setup is built
> for a **single app instance** (the Render free tier runs one). Don't scale
> to multiple replicas without migrating the DB layer first.

### Railway

```bash
railway init
railway add volume --mountPath /data          # persist data/ + uploads/
railway variables set DATA_DIR=/data UPLOAD_DIR=/data/uploads
railway up
```

Or import the repo in the Railway dashboard (it reads `package.json`, start
command `node server.js`). Note the generated URL — it's your origin.

### Fly.io

```bash
fly launch --name kings-production --region ams    # uses the included Dockerfile
fly volumes create kings_data --size 1 --region ams
fly secrets set DATA_DIR=/data UPLOAD_DIR=/data/uploads
fly deploy
```

The included `Dockerfile` runs `npm install` then `node server.js` on Node 24;
the `VOLUME` lines let Fly mount persistent storage at `/app/data`.

### VPS / bare metal

```bash
node -v                     # needs >= 23.4 (or 22.13+ with the sqlite flag)
npm install
DATA_DIR=/var/lib/kings-production \
UPLOAD_DIR=/var/lib/kings-production/uploads \
PUBLIC_URL=https://kingsproduction.cc \
npm start
```

Run it behind a reverse proxy (Caddy / nginx) with HTTPS. For systemd:

```ini
# /etc/systemd/system/kings-production.service
[Service]
ExecStart=/usr/bin/node /srv/kings-production/server.js
WorkingDirectory=/srv/kings-production
Environment=PORT=3000
Environment=PUBLIC_URL=https://kingsproduction.cc
Restart=always
```

> **Keep the host URL for Step 2.** It stays the "origin" — the real app server.
> Cloudflare DNS will point your domain at it.

---

## Step 2 — Connect `https://kingsproduction.cc` through Cloudflare

Your domain is **already on Cloudflare** (that's how `kingsproduction.cc`
resolves today). This is a DNS + SSL change only — no code changes needed; the
app already reads its public URL from the `PUBLIC_URL` env var.

> ⚠️ **Before touching DNS:** `kingsproduction.cc` currently shows the existing
> Kings Production site. Pointing the records below at the new app **replaces**
> it. If you want to keep the old site, first move it to a subdomain such as
> `old.kingsproduction.cc` (add an A/CNAME for that name, leave it proxied).

### 2a. Add the DNS records

In Cloudflare → your zone → **DNS → Records**, add (proxied, orange cloud ☁️ on
both):

| Type  | Name | Content / target                  | Proxy |
| ----- | ---- | --------------------------------- | ----- |
| CNAME | `@`  | `kings-production.onrender.com`   | ☁️ on |
| CNAME | `www`| `kings-production.onrender.com`   | ☁️ on |

- The apex `@` CNAME works because Cloudflare **flattens** apex CNAMEs — you do
  not need an A record or an IP.
- If your host is Railway, target `web-production-xxxx.up.railway.app`; Fly:
  `kings-production.fly.dev`; a VPS: use an **A** record with the server IP
  instead of a CNAME.
- Delete the old site's records for `@` and `www` at the same time (keep any
  subdomain records like `old.`).
- Leave the ☁️ (proxy) **on** — this is what lets Cloudflare terminate HTTPS,
  handle SSL, and protect the origin.

### 2b. Register the domain on your host (origin)

Cloudflare forwards your domain's requests to the origin **with
`kingsproduction.cc` as the Host header**, and the SSL mode in 2c needs the
origin to serve a certificate for that domain. Register it on the host so one
gets provisioned:

- **Render:** Dashboard → Service → **Settings → Custom Domains** → **Add
  Custom Domain** → `kingsproduction.cc` (add `www.kingsproduction.cc` too).
  Render issues the Let's Encrypt certificate automatically (a few minutes).
- **Railway:** Service → **Settings → Networking → Custom domains** → add the
  domain (Railway provisions its own TLS for it).
- **Fly.io:** `fly certs create kingsproduction.cc` and
  `fly certs create www.kingsproduction.cc`.
- **VPS:** your reverse proxy terminates TLS — Caddy auto-issues certs for the
domain; nginx needs one (e.g. `certbot --nginx -d kingsproduction.cc -d
www.kingsproduction.cc`).

Skipping this is the #1 cause of Cloudflare **525** errors (the origin's
certificate doesn't match the domain).

### 2c. Set the SSL/TLS mode

Cloudflare → **SSL/TLS → Overview**:

- Set **SSL/TLS encryption mode** to **Full (strict)** — the origin
  (Render/Railway/Fly) serves its own valid certificate, so strict validates it.
- Enable **Always Use HTTPS**.
- (Optional but recommended) **Edge Certificates → Minimum TLS 1.2**.

If you used a bare VPS with only plain HTTP, use **Full** instead of
Full (strict).

### 2d. Don't cache the API

Cloudflare **Caching → Configuration**: leave **Standard** (no "Cache
Everything"). If you later add cache rules, always exclude `/api/*` — the API
is dynamic and every request must reach your origin. The SPA page itself is
fine to cache briefly, but it's not required.

### 2e. Redirect `www` → apex (optional)

Cloudflare → **Rules → Redirect Rules**: `www.kingsproduction.cc/*` →
`https://kingsproduction.cc/$1` (301, preserve query string). The app works on
both, but one canonical hostname is cleaner for SEO and email links.

### 2f. Point the app at the domain

On your host, set this environment variable (Render: Dashboard → Service →
Environment; Railway: Variables; Fly: `fly secrets set`). If you used the
Render blueprint, `render.yaml` has a commented-out `PUBLIC_URL` — uncomment it
and redeploy:

```
PUBLIC_URL=https://kingsproduction.cc
```

This is used for password-reset email links and the startup banner. Deploy/
restart the service after setting it.

### 2g. Verify the domain is live

```bash
curl -I https://kingsproduction.cc/api/health
# expect: HTTP/2 200  and  {"ok":true,"data":{"name":"Kings Production API","store":"sqlite",...}}
```

DNS propagation is usually instant on Cloudflare (proxied). If you get a
Cloudflare **521/522** error page, the origin isn't reachable — see
Troubleshooting below.

---

## Step 3 — Make the APIs, accounts, and purchases fully live

### Accounts & APIs (live out of the box)

Once the domain resolves, these all work — no further setup:

- **Register / login / logout** — the first registered user is Admin
  (`AUTO_ADMIN=false` disables this; then create the admin, or promote from the
  Admin Panel).
- **2FA (TOTP)** per account (Settings → Security).
- **Roles** — Admin promotes Members to **VIP / Licensed** in Admin → Users,
  which unlocks asset posting.
- **Approval queue** — every upload enters Admin → Approvals until approved.
- **Purchases & licenses** — buying an approved asset issues a license key
  (Admin → Mailbox and the buyer's License page can assign it to a Roblox game
  ID).
- **Reviews, ratings, reports, comments** — all live.
- **Admin panel** — overview stats, approvals, all assets + file access, users
  (ban / timeout / roles), online sessions, reports, mailbox.

### Real email (password reset that actually reaches inboxes)

By default, reset links go to the **Admin → Mailbox** and the server console —
fine for testing, not for customers. To send real mail, set on the host:

```
SMTP_HOST=smtp.yourprovider.com
SMTP_USER=no-reply@kingsproduction.cc
SMTP_PASS=••••••••••
SMTP_PORT=587            # optional, default 587
SMTP_SECURE=false        # set true for port 465
```

When `SMTP_HOST` is set, the server **stops returning reset links inside API
responses** (that would leak the reset token) and delivers them by email only.

### Purchases & real money — read this carefully

The marketplace **issues license keys** but does **not move real money**:
`API.purchase` records the sale and mints a `KP-XXXX-XXXX` license key in your
SQLite DB. That's a full product/membership flow, but no payment gateway is
connected yet.

To take real payments, pick an integration (separate work, happy to build it):

- **Stripe Checkout** (recommended, one-time sales): add a `POST
  /api/checkout` route that creates a Stripe Checkout Session for the asset's
  price; Stripe redirects the buyer back to `https://kingsproduction.cc/` on
  success, and a webhook marks the purchase paid before the license key is
  issued. Prices are already in a currency-agnostic integer (`price`), so map
  R$ to your currency.
- **Roblox-specific** — e.g. selling through Roblox's own platform/Group Funds
  for real Robux, and treating this site as the catalog/storefront. In that
  model the license key flow stays as-is and you verify Roblox ownership
  separately.
- **Balance wallet** — users top up via Stripe, purchases deduct from the
  wallet (best if you want "Robux"-like balances in-app).

Until one of those is wired, **transactions are simulated** — fine for a live
demo/community shop, not for collecting money.

---

## Step 4 — Go-live verification checklist

Run through this from `https://kingsproduction.cc` (not localhost):

1. `curl https://kingsproduction.cc/api/health` → `{ "ok": true }`.
2. Register a fresh account → it becomes **Admin**. Log out, log back in.
3. Set up **2FA** and complete a login with the code.
4. Register a second account; as Admin, promote it to **VIP/Licensed**.
5. As the VIP: upload an asset (file, title, description, price) → it shows
   **Pending** and is hidden from the shop.
6. As Admin: approve it → it appears in the shop with its price.
7. As a Member: purchase it → a **license key** is issued; the file becomes
   downloadable.
8. Leave a **review/rating**, write a **comment**, and **report** the asset;
   as Admin, resolve the report.
9. Request a password reset → check the mailbox (or your real inbox if SMTP is
   set) and complete the reset.
10. Confirm the page is HTTPS on both `kingsproduction.cc` and `www.` (if you
    added the redirect, `www` should bounce to the apex).
11. Back up the DB: `data/kings.db` (plus `uploads/`) contains every account,
    asset, purchase, and license. Back it up daily once the shop is real.

---

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| Cloudflare **521 / 522** | Origin unreachable. Check the host is running, the service URL works directly, and DNS targets the right hostname/IP. |
| **525 SSL handshake** | SSL mode mismatch. Use **Full (strict)** with an HTTPS origin; **Full** if the origin is plain HTTP. |
| Site loads but **API 404s / "network error"** | The app fell back to the in-browser engine (no `/api/health` on this origin). Confirm the host runs `node server.js` and `PUBLIC_URL` is set. |
| **DB resets on redeploy** | On Render's free tier there's no persistent disk — data resets by design. Set `TURSO_URL` + `TURSO_AUTH_TOKEN` (free cloud SQLite, see “Free forever storage” above), or upgrade to a paid plan and uncomment the `disk:` block in `render.yaml`. |
| **Uploads lost / downloads 404** | Uploads live on disk by default. Set the `R2_*` env vars (free 10 GB object storage) so files persist too. |
| **Login not persisting** | Sessions are Bearer tokens stored in the browser, not cookies — nothing domain-specific to fix; clear site data and retry. |
| **Reset link 404s** | `PUBLIC_URL` is wrong/missing, so emailed links point at the wrong origin. Set it to `https://kingsproduction.cc`. |
| **Uploads fail** | Files > 20 MB are rejected by design; also confirm the origin's upload folder is writable and persistent. |
