# Kings Production

A marketplace platform for Roblox assets — scripts, models, plugins, animations,
and systems — for the Kings Production studio (kingsproduction.cc). Full-stack:
**Node.js + Express + SQLite** backend with a **single-file SPA** frontend.

## Quick start

Requires **Node ≥ 23.4** (`node:sqlite` is built in and unflagged there) — or
Node 22.13+ started with `NODE_OPTIONS=--experimental-sqlite node server.js`.
No native build step. Node 24 is recommended.

```bash
npm install
npm start          # → http://localhost:3000
```

That's it. The server creates `data/kings.db` (SQLite) and `uploads/` on first run,
seeds the studio content (Portfolio + Creators pages), and serves the app at `/`.

**Storage is pluggable:** set `TURSO_URL` + `TURSO_AUTH_TOKEN` to keep the database
in Turso (free cloud SQLite), and `R2_*` vars to keep uploads in Cloudflare R2
(free object storage) — see the env table below and `DEPLOY.md` for the free
forever setup.

> **No demo accounts exist.** On a fresh install the **first account to register
> becomes an Admin** (disable with `AUTO_ADMIN=false`). Admins can promote Members
> to VIP / Licensed creators from the Admin Panel → Users tab.

## Architecture

```
index.html               — the entire SPA (styles + views + router + API client)
shared/engine.js         — ONE business-logic engine, used by BOTH:
                             • the Node server (require'd)   over SQLite/Turso + disk/R2
                             • the browser (inlined copy)    over localStorage + IndexedDB
server.js                — Express app: serves index.html + the /api/* surface
server/sqlite-store.js   — local store adapter on node:sqlite (default)
server/turso-store.js    — cloud store adapter on Turso (free SQLite, set TURSO_URL)
server/disk-files.js     — uploads land on disk by default (uploads/<assetId>.bin)
server/r2-files.js       — uploads land in Cloudflare R2 when R2_* vars are set
server/mail.js           — logs emails + optional SMTP delivery (nodemailer)
scripts/build.mjs        — `node scripts/build.mjs` re-inlines engine.js into index.html
```

The browser app auto-detects the transport: if `/api/health` answers on the same
origin it talks to the real backend; otherwise (e.g. opened as a static file) it
runs the *same* engine in-browser so every feature still works offline. This is
how the feature set stays identical in both modes.

## Features

- **Design** — minimalist dark grey/black theme; gold is reserved exclusively for
  the crown (logo, hero, admin badge, empty states).
- **Authentication** — register, login, **2FA (TOTP, RFC 6238)**, forgot-password /
  reset delivered to the account email (Admin → Mailbox in development, real SMTP
  when `SMTP_*` env vars are set). Passwords are salted PBKDF2 (60k iterations).
- **Roles** — Member (grey), VIP/Licensed (blue), Admin (gold). Members comment +
  buy; VIPs post (every post enters the **pending-approval queue**); Admins get a
  separate panel.
- **Marketplace** — main page with a featured "Top Selling" section (ranked by
  sales) and a searchable/filterable catalog (Animation / Model / Plugin / System).
- **Reviews & ratings** — 1–5 star reviews per asset (one per user, editable),
  average rating shown on cards and the asset page.
- **Reporting flow** — every asset, comment, and profile has a Report action; the
  Admin Panel → Reports tab lists open reports with target context and quick
  actions (view / delete asset, ban / timeout user) plus one-click resolve.
- **Profiles** — display name, handle, bio, profile picture; public profile pages
  show posted assets, recent purchases, and recent comments.
- **Asset management** — creators edit (description, price, category, file —
  re-enters approval) and delete their own posts.
- **Admin panel** — Overview stats, Approvals (approve/reject with reason), all
  Assets (file access + delete any), Users (roles + ban/unban/timeout/clear),
  Reports, Online sessions, and the dev Mailbox.
- **Moderation rules** — bans block login; timeouts block commenting, purchasing,
  reviewing, and posting. **Admin accounts are protected** — they can never be
  banned, timed out, or role-changed (enforced in the engine, not just the UI).
- **Purchases & licenses** — buying issues a license key; the License page assigns
  keys to Roblox game IDs.

## API overview

All routes live under `/api` and return `{ ok, data }` / `{ ok:false, code, error }`.
Authentication is a `Authorization: Bearer <token>` header (token stored after
login/register/2FA). See `server.js` for the full route list:

- `POST /api/auth/register · login · verify2fa · request-reset · reset-password · logout`
- `GET /api/me`, `PATCH /api/profile`, `POST /api/auth/2fa/setup|enable|disable`
- `GET/POST/PATCH/DELETE /api/assets…` (multipart `file` field), `GET /api/assets/:id/file` (authenticated stream)
- `POST /api/assets/:id/purchase`, `GET /api/purchases/mine`, `POST /api/licenses/assign`
- `GET/POST /api/assets/:id/comments`, `GET/POST /api/assets/:id/reviews`, `DELETE /api/reviews/:id`
- `POST /api/reports`
- `GET /api/profile/:handle`, `GET /api/site/content`
- `GET/POST/DELETE /api/admin/*` — overview, approvals, assets, users, roles,
  sessions, emails, reports (engine enforces the admin role on every call)

## Configuration (env vars)

| Var            | Default             | Purpose                                            |
| -------------- | ------------------- | -------------------------------------------------- |
| `PORT`         | `3000`              | HTTP port                                          |
| `PUBLIC_URL`   | `http://localhost:3000` | Absolute base for email reset links            |
| `AUTO_ADMIN`   | `true`              | First registered user becomes Admin                |
| `DATA_DIR`     | `./data`            | SQLite file location (only when `TURSO_URL` unset) |
| `UPLOAD_DIR`   | `./uploads`         | Asset file location (only when `R2_*` unset)       |
| `TURSO_URL` / `TURSO_AUTH_TOKEN` | — | Cloud SQLite (Turso) — persistent DB, free tier 5 GB |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | — | Cloudflare R2 — persistent uploads, free tier 10 GB |
| `SMTP_HOST/USER/PASS/PORT/SECURE` | — | Real email delivery (optional) |

## Development

```bash
npm run check   # syntax-check all Node files
npm run build   # re-inline shared/engine.js into index.html after editing the engine
```

Note: `css/style.css` and `js/probe.js` are leftover probe files from an earlier
prototype and are not used by the app.

## Deployment

See **[DEPLOY.md](./DEPLOY.md)** for Render / Railway / Fly.io / Docker steps.
