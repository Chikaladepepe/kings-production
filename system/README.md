# Kings Production · License System (for Roblox Studio)

This folder contains the script that locks a Roblox system to the
**Kings Production** licensing portal. It prevents file leaks: even if
someone copies your file, it will not run without a licensed, matching
system — and the portal can pause or kick any leaked copy at any time.

## Files

| File | What it is |
|---|---|
| `license_system.lua` | The main license script (v2.1) — paste this into Roblox Studio |
| `example_usage.lua` | A working template showing how to wrap your own system with the license |

> This folder is version-controlled inside the repo (`kings-production/system/`)
> and is the **single source of truth**: the site's "Studio code" button
> generates its script from this exact file. If the file changes, rebuild with
> `npm run build` and redeploy.

## 3-step install

1. **Register your system** on `kingsproduction.cc` → Dashboard → **Register System**
   (System Name + System Password → status shows PENDING, flips to ACTIVE once verified)
2. **Configure the script**: open `license_system.lua` and fill in your
   `SystemName` and `SystemPassword` in the `CONFIG` block at the top
3. **Add it to your game**:
   - Put the script into `ServerScriptService` (or your system's main folder)
   - Roblox Studio → **Game Settings → Security → enable "Allow HTTP Requests"**
   - Wrap your own system with it (see `example_usage.lua`)

> **Use the site's generated copy for anything you ship.** Dashboard → your
> system → **Studio code** produces the final locked script with the
> anti-tamper fingerprint filled in. This folder's file is the working spec
> (`TAMPER_KEY` is `""` here, so the fingerprint check is off while you test).

## How it works

- On game start the script asks the portal: *"is this system licensed?"*
  → **ACTIVE** = your system runs, **DENIED** = it is disabled.
- A **heartbeat** re-checks every 5 minutes, so pausing the license or
  kicking a device on the web takes effect in-game within minutes.
- **Auto-kick**: a kicked device is DENIED on its next check-in, and any
  kicked **player** (by Roblox User ID) is force-disconnected even mid-game.
  Leaked copies are useless fast — the moment they're kicked they stop running.

## Device controls (Dashboard → your system)

| Control | What it does |
|---|---|
| **Pause / Resume** | Stops / restarts the whole system (denies every check-in) |
| **Kick** | Revokes one device — denied on its next check-in, player auto-kicked |
| **Authorize** | Undoes a kick — lets that device back in |
| **Delete** | Removes the system and all its devices |

Devices now show a readable label on the dashboard ("Server abc12345" for
live servers, "Studio" for tests) instead of a raw Job ID.

## Security notes

- **Anti-tamper lock**: the shipped copy embeds a SHA-256 fingerprint of its
  own source. Editing the script to strip the license breaks the fingerprint
  and the system **refuses to start**. The check is enforced in **Studio**
  (Roblox hides `script.Source` from live servers, so in a published game it
  is skipped automatically — there the protection is the portal's
  pause/kick/device-denial, plus obfuscation).
- **Obfuscate before shipping** (a Luau obfuscator) — the password lives in
  the script, and obfuscation makes stripping it out much harder. Combined
  with the fingerprint + pause/kick controls, a leaked copy is effectively
  dead on arrival.
- Put your real logic in a separate **Script** that the license **disables**
  when unlicensed, so a leaked copy has nothing to run.

## API contract (for reference)

```
POST https://kingsproduction.cc/api/systems/activate
POST https://kingsproduction.cc/api/systems/heartbeat

Body:  { "systemName": "...", "systemPassword": "...", "deviceId": "...", "deviceName": "..." }
Reply: { "ok": true, "data": {
          "active": true|false,
          "reason": "...",
          "revokedPlayers": ["123", "456"]   -- players to auto-kick
        } }

POST https://kingsproduction.cc/api/systems/device   (player registration)

Body:  { "systemName": "...", "systemPassword": "...",
         "playerId": "123", "playerName": "..." }
Reply: { "ok": true, "data": { "active": true|false, "reason": "...",
                               "kicked": true|false } }
```
