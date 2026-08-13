--[[==========================================================================
	EXAMPLE — how to wrap YOUR OWN system with the license
	This is a template, not the license itself. Copy the ideas that fit.
============================================================================--]]

-- 1) Require the license module (adjust the path to wherever you put it).
--    If you pasted license_system.lua as a ModuleScript it will be named
--    "license_system" — the require name must match that exact name:
local License = require(script.Parent.license_system)

-- 2) Optional: run extra shutdown behavior the moment the license dies
License.OnDenied = function()
	print("[MySystem] License denied — shutting down my system")
	-- e.g. stop music, close UIs, disable features:
	-- game.Workspace.MyMusicBox.Disabled = true
end

-- 3) Start it — pass the Script/object that should be force-disabled when
--    unlicensed. Put your real system logic inside a Script so it can be
--    Disabled; gate anything else with License.IsLicensed().
License.Start(script.Parent.MusicSystem)

-- 4) Gate your features on the license
local function initMusicSystem()
	if not License.IsLicensed() then
		warn("[MySystem] Not licensed — features disabled")
		return
	end
	-- ... your real Music System code runs here ...
end

initMusicSystem()

-- NOTE: to make a leaked copy useless fast, hide your real logic in the
-- protected Script (MusicSystem) — the license script disables that object
-- when the license is paused/revoked, so the copy can't run at all.
